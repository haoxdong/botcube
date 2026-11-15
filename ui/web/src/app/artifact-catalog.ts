
import { chatServiceUrl } from "../cartridge/chat-service-url";
import { listFiles, type FileEntry } from "../computer/files-service";
import { readFile } from "./artifact-files";
import { Published } from "./artifact-published";
import { recordOf } from "./artifact-newest";

const STORED = [
  { suffix: ".html", type: null },
  { suffix: ".md", type: "doc" },
  { suffix: ".sheet.json", type: "sheet" },
  { suffix: ".email.json", type: "email" },
  { suffix: "/project/deck.json", type: "slides" },
] as const;

export async function catalogOf(files: readonly FileEntry[], read: (path: string) => Promise<string>): Promise<Published[]> {
  const newest = new Map<string, { entry: FileEntry; version: number; path: string; type: Published["type"] }>();
  for (const entry of files) {
    const match = /^artifacts\/(.+)\.versions\/(\d+)(.*)$/.exec(entry.name);
    if (!match) continue;
    const [, source, number, suffix] = match;
    const kind = STORED.find((kind) => kind.suffix === suffix);
    if (!kind) continue;
    const id = `/${source}`;
    const version = Number(number);
    if ((newest.get(id)?.version ?? 0) >= version) continue;
    const path = `/${entry.name.slice(0, entry.name.length - (kind.type === "slides" ? kind.suffix.length : 0))}`;
    newest.set(id, { entry, version, path, type: kind.type });
  }
  const sorted = [...newest].sort(([, a], [, b]) => Date.parse(b.entry.lastModified) - Date.parse(a.entry.lastModified));
  return Promise.all(sorted.map(async ([id, { version, path, type }]) => {
    const record = await recordOf(path, read);
    return Published.parse({ id, version, path, type, ...record });
  }));
}

export const listArtifacts = async () => catalogOf(await listFiles({ chatServiceUrl: chatServiceUrl() }), readFile);
