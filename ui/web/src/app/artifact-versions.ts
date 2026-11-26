import { readRecord, type VersionRecord } from "botcube-artifact-check/record";
import { recordedVersion, recordName, storedVersion, type StoredType } from "botcube-artifact-check/versions";

import { chatServiceUrl } from "../plugin/chat-service-url";
import { listFiles, type FileEntry } from "../computer/files-service";
import { readFile } from "./artifact-files";
import type { Published } from "./artifact-published";
import { filesPath, nameOf, type FilesPath } from "./files-path";

/** A version of an Artifact its record names in Files, and when Files wrote that record. */
type RecordedVersion = { version: number; at: Date };
/** A whole version of an Artifact in Files: its number and type, where it is stored, and when Files wrote it. */
type StoredVersion = RecordedVersion & { type: StoredType; path: FilesPath };

/** How the store reads Files: its listing, and one file's text. The account's live Files unless given. */
export type FilesReader = { list?: () => Promise<readonly FileEntry[]>; read?: (path: FilesPath) => Promise<string> };

const listLive = () => listFiles({ chatServiceUrl: chatServiceUrl() });

function newestBySource(files: readonly FileEntry[], source?: string) {
  const newest = new Map<string, StoredVersion>();
  for (const { name, lastModified } of files) {
    const found = storedVersion(name);
    if (!found || (source !== undefined && found.source !== source)) continue;
    const previous = newest.get(found.source);
    if (!previous || found.version > previous.version) {
      newest.set(found.source, { version: found.version, type: found.type, path: filesPath(found.name), at: new Date(lastModified) });
    }
  }
  return newest;
}

async function readVersion(source: string, version: number, read: NonNullable<FilesReader["read"]>): Promise<VersionRecord> {
  return readRecord(await read(filesPath(recordName(source, version))));
}

/** The newest whole version of each Artifact, ordered by when Files wrote it. */
export async function listArtifacts({ list = listLive, read = readFile }: FilesReader = {}): Promise<Published[]> {
  const newest = [...newestBySource(await list())].sort(([, a], [, b]) => b.at.getTime() - a.at.getTime());
  return Promise.all(newest.map(async ([source, { version, type, path }]) => {
    const { author, title, description } = await readVersion(source, version, read);
    return { id: filesPath(source), version, type: type === "page" ? null : type, path, author, title, description };
  }));
}

/**
 * The versions in Files of the Artifact `id`, its Source's Files path, in the layout the harness writes
 * (`botcube-artifact-check/versions`). Its record is a version's first file; its type's last-written file makes it whole.
 */
export function artifactVersions(id: FilesPath, { list = listLive, read = readFile }: FilesReader = {}) {
  const source = nameOf(id);
  return {
    /** Every version with a record, newest first: a version still being written is among them. */
    list: async (): Promise<RecordedVersion[]> =>
      (await list())
        .flatMap(({ name, lastModified }) => {
          const found = recordedVersion(name);
          return found?.source === source ? [{ version: found.version, at: new Date(lastModified) }] : [];
        })
        .sort((a, b) => b.version - a.version),
    /** The newest whole version; undefined when there is none. */
    newest: async (): Promise<StoredVersion | undefined> => newestBySource(await list(), source).get(source),
    /** Version `version`'s record: who made it, its title and description, and the Files it keeps. */
    read: (version: number) => readVersion(source, version, read),
  };
}

export type ArtifactVersions = ReturnType<typeof artifactVersions>;
