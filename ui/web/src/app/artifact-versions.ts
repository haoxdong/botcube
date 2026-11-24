import { readRecord, type VersionRecord } from "botcube-artifact-check/record";
import { recordedVersion, recordName, storedVersion, type StoredType } from "botcube-artifact-check/versions";

import { chatServiceUrl } from "../plugin/chat-service-url";
import { listFiles, type FileEntry } from "../computer/files-service";
import { readFile } from "./artifact-files";
import { filesPath, nameOf, type FilesPath } from "./files-path";

/** A version of an Artifact its record names in Files, and when Files wrote that record. */
export type RecordedVersion = { version: number; at: Date };
/** A whole version of an Artifact in Files: its number and type, where it is stored, and when Files wrote it. */
export type StoredVersion = RecordedVersion & { type: StoredType; path: FilesPath };

/** How the store reads Files: its listing, and one file's text. The account's live Files unless given. */
export type FilesReader = { list?: () => Promise<readonly FileEntry[]>; read?: (path: FilesPath) => Promise<string> };

const listLive = () => listFiles({ chatServiceUrl: chatServiceUrl() });

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
    newest: async (): Promise<StoredVersion | undefined> => {
      const whole = (await list()).flatMap(({ name, lastModified }) => {
        const found = storedVersion(name);
        return found?.source === source ? [{ version: found.version, type: found.type, path: filesPath(found.name), at: new Date(lastModified) }] : [];
      });
      return whole.sort((a, b) => b.version - a.version)[0];
    },
    /** Version `version`'s record: who made it, its title and description, and the Files it keeps. */
    read: async (version: number): Promise<VersionRecord> => readRecord(await read(filesPath(recordName(source, version)))),
  };
}

export type ArtifactVersions = ReturnType<typeof artifactVersions>;
