import { storedVersion } from "botcube-artifact-check/versions";

import { chatServiceUrl } from "../plugin/chat-service-url";
import { listFiles, type FileEntry } from "../computer/files-service";
import { readFile } from "./artifact-files";
import { Published } from "./artifact-published";
import { artifactVersions } from "./artifact-versions";
import { filesPath, type FilesPath } from "./files-path";

/** Every Artifact in the Files `files` lists, at its newest version, the most recently written first. */
export async function catalogOf(files: readonly FileEntry[], read: (path: FilesPath) => Promise<string>): Promise<Published[]> {
  const sources = new Set(files.flatMap(({ name }) => storedVersion(name)?.source ?? []));
  const found = await Promise.all([...sources].map(async (source) => {
    const id = filesPath(source);
    const versions = artifactVersions(id, { list: async () => files, read });
    const newest = await versions.newest();
    return newest === undefined ? [] : [{ id, newest, record: await versions.read(newest.version) }];
  }));
  return found.flat()
    .sort((a, b) => b.newest.at.getTime() - a.newest.at.getTime())
    .map(({ id, newest: { version, type, path }, record }) => Published.parse({ id, version, path, type: type === "page" ? null : type, ...record }));
}

export const listArtifacts = async () => catalogOf(await listFiles({ chatServiceUrl: chatServiceUrl() }), readFile);
