// The walk of an account's Files folder on EFS: every visible file and folder under it (ADR 0093).
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { errorCode } from './account-tree.js';
import { HIDDEN, type FileEntry, type FolderEntry } from './files-shared.js';

/** Every visible file and folder under a directory, by its name relative to it. */
export async function walk(base: string, prefix = ''): Promise<{ files: Array<FileEntry & { file: string }>; folders: FolderEntry[] }> {
  let entries;
  try {
    entries = await readdir(path.join(base, prefix), { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { files: [], folders: [] };
    throw error;
  }
  const found: { files: Array<FileEntry & { file: string }>; folders: FolderEntry[] } = { files: [], folders: [] };
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Hidden folders (the Harness's own, an upload's parts) are not the user's Files.
    if (entry.isDirectory() && !HIDDEN.test(`${name}/`)) {
      // eslint-disable-next-line no-await-in-loop -- one stat at a time, as the walk reads
      const { mtime } = await stat(path.join(base, name));
      // eslint-disable-next-line no-await-in-loop -- one folder at a time keeps NFS round trips bounded
      const inside = await walk(base, name);
      found.folders.push({ name, lastModified: mtime.toISOString() }, ...inside.folders);
      found.files.push(...inside.files);
    } else if (entry.isFile()) {
      const file = path.join(base, name);
      // eslint-disable-next-line no-await-in-loop -- one stat at a time, as the walk reads
      const { size, mtime } = await stat(file);
      found.files.push({ name, size, lastModified: mtime.toISOString(), file });
    }
  }
  return found;
}
