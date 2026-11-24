import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { check, checked, describe, reads } from 'botcube-artifact-check';
import { readDraft } from 'botcube-artifact-check/email-schema';
import { readRecord, type VersionRecord } from 'botcube-artifact-check/record';
import type { Sheet } from 'botcube-artifact-check/sheet';
import { suffixOf, versionOf, versionsFolder } from 'botcube-artifact-check/versions';
import { z } from 'zod';
import { AccountTree, errorCode } from './account-tree.js';
import { HttpError } from './http-error.js';

/** A User's save of an Artifact edited in place (ADR 0087): the edited files of `version`, by their path in the Source. */
export const ArtifactSave = z.object({
  id: z.string(),
  version: z.number().int(),
  files: z.record(z.string(), z.string()),
});
export type ArtifactSave = z.infer<typeof ArtifactSave>;

export const ArtifactRestore = ArtifactSave.pick({ id: true }).extend({
  from: z.number().int().positive(),
  version: z.number().int().positive(),
});
export type ArtifactRestore = z.infer<typeof ArtifactRestore>;

/**
 * Each Artifact Type as a save stores it, in the layout the harness's `Artifact` tool keeps (`botcube-artifact-check/versions`):
 * a version is `<n><suffix>` beside its `<n>.json` record, a folder when `suffix` is empty and one file otherwise. `saves` names the
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
  { name: 'page', suffix: suffixOf('page'), saves: null },
  { name: 'slides', suffix: suffixOf('slides'), saves: (file) => /^project\/slides\/[^/]+\.html$/.test(file) },
  { name: 'doc', suffix: suffixOf('doc'), saves: (file) => reads('doc', file) },
  { name: 'sheet', suffix: suffixOf('sheet'), saves: (file) => reads('sheet', file), keeps: { what: 'import steps', named: importSteps } },
  { name: 'email', suffix: suffixOf('email'), saves: (file) => reads('email', file), keeps: { what: 'attachments', named: attachments } },
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
 * Writes the User's edited files into the Source, then publishes the Artifact's next version, authored by the User,
 * so the agent's next turn works from them. `directory` is the account's Files on disk. A save refuses any
 * symbolic link on its way, so it reads and writes only inside `directory`.
 */
export async function saveArtifact(directory: string, { id, version, files }: ArtifactSave): Promise<SavedArtifact> {
  const edits = Object.entries(files);
  if (edits.length === 0) throw new HttpError(400, `A save of ${id} carries no edited file`);
  const source = sourceOf(id);
  const tree = await AccountTree.at(directory);
  const versions = versionsFolder(source);
  const type = newestType(await versionsIn(tree, versions), id, version, 'edit');
  const edit: Edit = { tree, id, source, versions, version, type, files, kept: [] };
  edit.kept = type.suffix === '' ? await tree.files(edited(edit)) : [];
  await refuseEdits(edit);
  await checkWhole(edit);
  const record = readRecord((await tree.read(`${versions}/${version}.json`)).toString('utf8'));
  await refuseChangedKept(edit);
  const { title, description, imports } = record;
  const savedRecord = { title, description, ...(imports === undefined ? {} : { imports }) };
  return storeNext(edit, { ...savedRecord, author: 'user' }, (building) => buildEdited(edit, building),
    async (_, publish) => {
      await Promise.all(edits.map(([name, text]) => tree.write(sourceFile(edit, name), text, 'replace')));
      await publish();
    });
}

export async function restoreArtifact(directory: string, { id, from, version }: ArtifactRestore): Promise<SavedArtifact> {
  const source = sourceOf(id);
  const tree = await AccountTree.at(directory);
  const versions = versionsFolder(source);
  const stored = await versionsIn(tree, versions);
  newestType(stored, id, version, 'restore');
  const type = stored.get(from);
  if (type === undefined) throw new HttpError(404, `No version ${from} of ${id} in Files`);

  const record = readRecord((await tree.read(`${versions}/${from}.json`)).toString('utf8'));
  return storeNext({ tree, id, versions, version, type }, { ...record, author: 'user', restoredFrom: from },
    (building) => tree.copy(`${versions}/${from}${type.suffix}`, building, type.suffix === ''),
    (building, publish) => replaceSource(tree, source, building, type.suffix === '', publish));
}

type NextVersion = {
  tree: AccountTree; id: string; versions: string; version: number; type: SaveType;
};

/** A save in progress: the version it edits and the files it carries, by their path in the Source. */
type Edit = NextVersion & {
  source: string;
  files: Record<string, string>;
  /** A folder Source's files in the edited version; empty for a one-file Source. */
  kept: string[];
};

const edited = ({ versions, version, type }: Edit) => `${versions}/${version}${type.suffix}`;
/** Where an edited file lives in the Source: a folder's file under it, a one-file Source itself. */
const sourceFile = ({ source, type }: Edit, name: string) => type.suffix === '' ? `${source}/${name}` : source;

/** The edited version's type, when it is the Artifact's newest. */
function newestType(stored: Map<number, SaveType>, id: string, version: number, action: 'edit' | 'restore'): SaveType {
  if (stored.size === 0) throw new HttpError(404, `No Artifact ${id} in Files`);
  const latest = Math.max(...stored.keys());
  const type = stored.get(version);
  if (latest !== version || type === undefined) {
    const observed = action === 'edit' ? 'edited' : 'saw';
    throw new HttpError(409, `Version ${latest} of ${id} is newer than the version ${version} you ${observed}. Open the newest and ${action} again.`);
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

async function buildEdited(edit: Edit, building: string): Promise<void> {
  const { tree, type: { suffix }, files, kept } = edit;
  if (suffix === '') {
    await Promise.all(kept.map(async (name) => tree.write(`${building}/${name}`, files[name] ?? await tree.read(`${edited(edit)}/${name}`), 'new')));
  } else {
    await tree.write(building, Object.values(files)[0] ?? '', 'new');
  }
}

async function replaceSource(tree: AccountTree, source: string, building: string, folder: boolean, publish: () => Promise<void>): Promise<() => Promise<void>> {
  const replacement = `${building}.source`;
  const previous = `${building}.previous`;
  try {
    await tree.copy(building, replacement, folder);
    await tree.folders(path.posix.dirname(source));
    const hadSource = await tree.rename(source, previous).then(() => true, (error: unknown) => {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    });
    try {
      await tree.rename(replacement, source);
      try {
        await publish();
      } catch (error) {
        await tree.remove(source);
        throw error;
      }
    } catch (error) {
      if (hadSource) await tree.rename(previous, source);
      throw error;
    }
  } catch (error) {
    await tree.remove(replacement);
    throw error;
  }
  return () => tree.remove(previous);
}

async function storeNext(
  { tree, id, versions, version, type }: NextVersion,
  record: VersionRecord & { author: 'user' },
  build: (building: string) => Promise<void>,
  publishWithSource: (building: string, publish: () => Promise<void>) => Promise<void | (() => Promise<void>)>,
): Promise<SavedArtifact> {
  const next = version + 1;
  const claimed = `${versions}/${next}.json`;
  const stored = `${versions}/${next}${type.suffix}`;
  const building = `${versions}/.saving-${randomUUID()}${type.suffix}`;
  try {
    await build(building);
    await tree.write(claimed, JSON.stringify(record), 'new').catch((error: unknown) => {
      throw errorCode(error) === 'EEXIST' ? new HttpError(409, `Version ${next} of ${id} was saved first. Open the newest and edit again.`) : error;
    });
    const cleanup = await publishWithSource(building, () => tree.rename(building, stored)).catch(async (error: unknown) => {
      await tree.remove(claimed);
      throw error;
    });
    await cleanup?.();
  } finally {
    await tree.remove(building);
  }
  return { id, type: type.name, title: record.title, description: record.description, version: next, author: record.author, path: `/${stored}` };
}

function sourceOf(id: string): string {
  const name = id.replace(/^\//, '');
  if (!name || name.split('/').some((segment) => segment === '' || segment.startsWith('.'))) {
    throw new HttpError(400, `${id} is not an Artifact in Files`);
  }
  return name;
}

/** The saved versions in `folder`, by number. */
async function versionsIn(tree: AccountTree, folder: string): Promise<Map<number, SaveType>> {
  const found = new Map<number, SaveType>();
  for (const name of await tree.names(folder)) {
    const stored = versionOf(name);
    const type = TYPES.find((candidate) => candidate.name === stored?.type);
    if (stored !== null && type !== undefined) found.set(stored.version, type);
  }
  return found;
}
