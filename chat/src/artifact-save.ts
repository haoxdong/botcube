import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { check, checked, describe, reads } from 'botcube-artifact-check';
import { readDraft } from 'botcube-artifact-check/email-schema';
import { readRecord, type VersionRecord } from 'botcube-artifact-check/record';
import type { Sheet } from 'botcube-artifact-check/sheet';
import { z } from 'zod';
import { HttpError } from './cartridge.js';

/** A User's save of an Artifact edited in place (ADR 0087): the edited files of `version`, by their path in the Source. */
export const ArtifactSave = z.object({
  id: z.string(),
  version: z.number().int(),
  files: z.record(z.string(), z.string()),
});
export type ArtifactSave = z.infer<typeof ArtifactSave>;

/**
 * Each Artifact Type as a save stores it, in the layout the harness's `Artifact` tool keeps: a version is
 * `<n><suffix>` beside its `<n>.json` record, a folder when `suffix` is empty and one file otherwise. `saves` names the
 * Source files a save may carry: in a folder, files the edited version already has; a one-file Source is keyed by its
 * own file name, the file the type's checker reads. A type with no `saves` is not edited in place. `keeps` names, in a
 * Source's text, what names the Files its version keeps a copy of (the harness's `keep`, kept_files.py): a save keeps
 * the edited version's copies, so it may not change them.
 */
type SaveType = {
  name: 'page' | 'slides' | 'doc' | 'sheet' | 'email'; suffix: string; saves: ((file: string) => boolean) | null;
  keeps?: { what: string; named: (text: string) => string[] };
};
const TYPES: readonly SaveType[] = [
  { name: 'page', suffix: '.html', saves: null },
  { name: 'slides', suffix: '', saves: (file) => /^project\/slides\/[^/]+\.html$/.test(file) },
  { name: 'doc', suffix: '.md', saves: (file) => reads('doc', file) },
  { name: 'sheet', suffix: '.sheet.json', saves: (file) => reads('sheet', file), keeps: { what: 'import steps', named: importSteps } },
  { name: 'email', suffix: '.email.json', saves: (file) => reads('email', file), keeps: { what: 'attachments', named: attachments } },
];

export interface SavedArtifact {
  id: string;
  type: SaveType['name'];
  title: string;
  description: string;
  version: number;
  author: 'user';
  path: string;
}

/**
 * Stores the User's edit as the Artifact's next version, authored by the User, then writes the edited files into the
 * Source, so the agent's next turn works from them. `directory` is the account's Files on disk. A save refuses any
 * symbolic link on its way, so it reads and writes only inside `directory`.
 */
export async function saveArtifact(directory: string, { id, version, files }: ArtifactSave): Promise<SavedArtifact> {
  const edits = Object.entries(files);
  if (edits.length === 0) throw new HttpError(400, `A save of ${id} carries no edited file`);
  const source = sourceOf(id);
  const tree = await AccountTree.at(directory);
  const versions = `artifacts/${source}.versions`;
  const type = editedType(await tree.versions(versions), id, version);
  const edit: Edit = { tree, id, source, versions, version, type, files, kept: [] };
  edit.kept = type.suffix === '' ? await tree.files(edited(edit)) : [];
  await refuseEdits(edit);
  await checkWhole(edit);
  const record = readRecord((await tree.read(`${versions}/${version}.json`)).toString('utf8'));
  await refuseChangedKept(edit);
  const next = await storeNext(edit, record);
  // The Source after the version: a failed write leaves the User's version stored, which the agent's next read shows.
  await Promise.all(edits.map(([name, text]) => tree.write(sourceFile(edit, name), text, 'replace')));
  return {
    id, type: type.name, title: record.title, description: record.description, version: next, author: 'user',
    path: `/${versions}/${next}${type.suffix}`,
  };
}

/** A save in progress: the version it edits and the files it carries, by their path in the Source. */
type Edit = {
  tree: AccountTree; id: string; source: string; versions: string; version: number; type: SaveType;
  files: Record<string, string>;
  /** A folder Source's files in the edited version; empty for a one-file Source. */
  kept: string[];
};

const edited = ({ versions, version, type }: Edit) => `${versions}/${version}${type.suffix}`;
/** Where an edited file lives in the Source: a folder's file under it, a one-file Source itself. */
const sourceFile = ({ source, type }: Edit, name: string) => type.suffix === '' ? `${source}/${name}` : source;

/** The edited version's type, when it is the Artifact's newest. */
function editedType(stored: Map<number, SaveType>, id: string, version: number): SaveType {
  if (stored.size === 0) throw new HttpError(404, `No Artifact ${id} in Files`);
  const latest = Math.max(...stored.keys());
  const type = stored.get(version);
  if (latest !== version || type === undefined) {
    throw new HttpError(409, `Version ${latest} of ${id} is newer than the version ${version} you edited. Open the newest and edit again.`);
  }
  return type;
}

/** Refuses a file the editor cannot save, and a Source file reached through a symbolic link. */
async function refuseEdits(edit: Edit): Promise<void> {
  const { id, source, type: { suffix, saves }, kept } = edit;
  const names = Object.keys(edit.files);
  for (const name of names) {
    const allowed = saves !== null && saves(name) && (suffix === '' ? kept.includes(name) : name === path.posix.basename(source));
    if (!allowed) throw new HttpError(400, `${name} is not a file of ${id} the editor can save`);
  }
  await Promise.all(names.map((name) => edit.tree.refuseLink(sourceFile(edit, name))));
}

/** Runs the type's checker, when it has one, over the whole Source as the save would store it. */
async function checkWhole(edit: Edit): Promise<void> {
  const { name } = edit.type;
  if (!checked(name)) return;
  const read = edit.kept.filter((file) => reads(name, file));
  const texts = await Promise.all(read.map(async (file) => (await edit.tree.read(`${edited(edit)}/${file}`)).toString('utf8')));
  const errors = await check(name, { ...Object.fromEntries(read.map((file, at) => [file, texts[at] ?? ''])), ...edit.files });
  if (errors.length > 0) throw new HttpError(400, errors.map((error) => describe(error)).join('\n'));
}

/**
 * Refuses a save that changes what names a File the edited version keeps a copy of (a Sheet's import steps, an Email's
 * attachments): the editors keep them as they are, so the saved version's record keeps the edited one's copies.
 */
async function refuseChangedKept(edit: Edit) {
  const { id, version, files, tree, type: { keeps } } = edit;
  if (keeps === undefined) return;
  const kept = keeps.named((await tree.read(edited(edit))).toString('utf8'));
  if (JSON.stringify(keeps.named(Object.values(files)[0] ?? '')) !== JSON.stringify(kept)) {
    throw new HttpError(400, `A save of ${id} keeps the ${keeps.what} of version ${version}: ${kept.join(', ') || 'none'}`);
  }
}

/** A Sheet's import steps, each by its edit's index and the File it names; the checker has passed the Sheet. */
function importSteps(text: string): string[] {
  const { edits }: Sheet = JSON.parse(text);
  return edits.flatMap((step, index) => step.kind === 'importFile' ? [`edit ${index} imports ${step.asset}`] : []);
}

/** An Email's attachments, each by its index and the File it names; the checker has passed the draft. */
function attachments(text: string): string[] {
  return (readDraft(text).attachments ?? []).map(({ file }, index) => `attachment ${index} is ${file}`);
}

/**
 * Builds the next version under a hidden name, claims its number by creating its `<n>.json` (the User as author), then
 * renames it into place, so a version is visible only once its record is.
 */
async function storeNext(edit: Edit, { title, description, imports }: VersionRecord): Promise<number> {
  const { tree, id, versions, version, type: { suffix }, files, kept } = edit;
  const next = version + 1;
  const claimed = `${versions}/${next}.json`;
  const building = `${versions}/.saving-${randomUUID()}${suffix}`;
  try {
    if (suffix === '') {
      await Promise.all(kept.map(async (name) => tree.write(`${building}/${name}`, files[name] ?? await tree.read(`${edited(edit)}/${name}`), 'new')));
    } else {
      await tree.write(building, Object.values(files)[0] ?? '', 'new');
    }
    await tree.write(claimed, JSON.stringify({ author: 'user', title, description, imports }), 'new').catch((error: unknown) => {
      throw errorCode(error) === 'EEXIST' ? new HttpError(409, `Version ${next} of ${id} was saved first. Open the newest and edit again.`) : error;
    });
    await tree.rename(building, `${versions}/${next}${suffix}`).catch(async (error: unknown) => {
      await tree.remove(claimed);
      throw error;
    });
  } finally {
    await tree.remove(building);
  }
  return next;
}

function sourceOf(id: string): string {
  const name = id.replace(/^\//, '');
  if (!name || name.split('/').some((segment) => segment === '' || segment.startsWith('.'))) {
    throw new HttpError(400, `${id} is not an Artifact in Files`);
  }
  return name;
}

const errorCode = (error: unknown) => error instanceof Error && 'code' in error ? error.code : undefined;

/** The account's Files, read and written only along paths with no symbolic link, and never past their root. */
class AccountTree {
  private constructor(private readonly root: string) {}

  static async at(directory: string): Promise<AccountTree> {
    return new AccountTree(await realpath(directory));
  }

  async versions(folder: string): Promise<Map<number, SaveType>> {
    const found = new Map<number, SaveType>();
    for (const name of await this.names(folder)) {
      const [, number, suffix] = /^(\d+)(.*)$/.exec(name) ?? [];
      const type = TYPES.find((candidate) => candidate.suffix === suffix);
      if (number !== undefined && type !== undefined) found.set(Number(number), type);
    }
    return found;
  }

  async files(folder: string): Promise<string[]> {
    await this.refuseLink(folder);
    const entries = await readdir(this.full(folder), { withFileTypes: true });
    const linked = entries.find((entry) => entry.isSymbolicLink());
    if (linked !== undefined) throw this.linked(`${folder}/${linked.name}`);
    const found = await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory()) return (await this.files(`${folder}/${entry.name}`)).map((name) => `${entry.name}/${name}`);
      return entry.isFile() ? [entry.name] : [];
    }));
    return found.flat();
  }

  async read(name: string): Promise<Buffer> {
    await this.refuseLink(name);
    const file = await open(this.full(name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await file.readFile();
    } finally {
      await file.close();
    }
  }

  async write(name: string, data: string | Buffer, mode: 'new' | 'replace'): Promise<void> {
    await this.folders(path.posix.dirname(name));
    await this.refuseLink(name);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (mode === 'new' ? constants.O_EXCL : constants.O_TRUNC);
    const file = await open(this.full(name), flags, 0o640);
    try {
      await file.writeFile(data);
    } finally {
      await file.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await this.refuseLink(from);
    await this.refuseLink(to);
    await rename(this.full(from), this.full(to));
  }

  async remove(name: string): Promise<void> {
    await this.refuseLink(path.posix.dirname(name));
    await rm(this.full(name), { recursive: true, force: true });
  }

  async refuseLink(name: string): Promise<void> {
    const segments = name.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new HttpError(400, `${name} is not a path in Files`);
    await this.walk(segments, 1);
  }

  /** Each folder from the root in turn, down to the first that does not exist yet: none may be a link or lead out. */
  private async walk(segments: readonly string[], depth: number): Promise<void> {
    if (depth > segments.length) return;
    const walked = segments.slice(0, depth).join('/');
    const status = await lstat(this.full(walked)).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (status === null) return;
    if (status.isSymbolicLink()) throw this.linked(walked);
    const resolved = await realpath(this.full(walked));
    if (!resolved.startsWith(`${this.root}${path.sep}`)) throw this.linked(walked);
    await this.walk(segments, depth + 1);
  }

  private async names(folder: string): Promise<string[]> {
    await this.refuseLink(folder);
    try {
      return await readdir(this.full(folder));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  /** Makes each folder of `folder` from the root in turn, refusing a link or a file in the way. */
  private async folders(folder: string, depth = 1): Promise<void> {
    const segments = folder.split('/');
    if (depth > segments.length) return;
    const walked = segments.slice(0, depth).join('/');
    await this.refuseLink(walked);
    await mkdir(this.full(walked)).catch((error: unknown) => {
      if (errorCode(error) !== 'EEXIST') throw error;
    });
    if (!(await lstat(this.full(walked))).isDirectory()) throw new HttpError(400, `/${walked} in Files is not a folder`);
    await this.folders(folder, depth + 1);
  }

  private full(name: string): string {
    return path.join(this.root, name);
  }

  private linked(name: string): HttpError {
    return new HttpError(400, `/${name} in Files is a symbolic link, which a save never follows`);
  }
}
