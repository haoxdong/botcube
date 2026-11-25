import { fileExtension, isImageName } from '../components/file-type-icon';
import type { FileEntry } from './files-service';

/** An item of the open place: a file, with its size, or a folder holding files further down. */
export type FilesItem = {
  name: string;
  /** The file's path, or the folder's path with its trailing slash. */
  path: string;
  /** The file's, or for a folder the newest of the files inside it. */
  lastModified: string;
} & ({ folder: false; size: number } | { folder: true });

/** Where Files is: a folder ('' for workspace, the top, else its path with a trailing slash), or Home (null). */
export type Place = string | null;

/** The items inside a folder ('' for the top, else its path with a trailing slash). */
export function itemsIn(files: readonly FileEntry[], folder: string): FilesItem[] {
  // Keyed by path, so a file and a folder of the same name, which storage allows, both stay listed.
  const items = new Map<string, FilesItem>();
  for (const file of files) {
    if (!file.name.startsWith(folder)) continue;
    const [name = '', ...below] = file.name.slice(folder.length).split('/');
    if (below.length === 0) {
      items.set(file.name, { name, path: file.name, lastModified: file.lastModified, folder: false, size: file.size });
      continue;
    }
    const path = `${folder}${name}/`;
    const seen = items.get(path);
    const lastModified = seen === undefined || Date.parse(file.lastModified) > Date.parse(seen.lastModified) ? file.lastModified : seen.lastModified;
    items.set(path, { name, path, lastModified, folder: true });
  }
  return [...items.values()];
}

/** How many files Home lists. */
const RECENTS = 20;

/** Home's recent files: the newest in every folder, newest first. */
export function recentsIn(files: readonly FileEntry[]): FilesItem[] {
  return [...files]
    .sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified))
    .slice(0, RECENTS)
    .map(({ name, size, lastModified }) => ({ name: name.slice(name.lastIndexOf('/') + 1), path: name, lastModified, folder: false, size }));
}

/** A folder, with the folders inside it. */
type FolderNode = { name: string; path: string; folders: FolderTree };
/** A folder's own folders, each with the folders inside it, in name order. */
export type FolderTree = FolderNode[];

export function foldersIn(files: readonly FileEntry[], folder = ''): FolderTree {
  return itemsIn(files, folder)
    .filter(({ folder: isFolder }) => isFolder)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, path }) => ({ name, path, folders: foldersIn(files, path) }));
}

/** The folder above an open one, or null at workspace and Home. */
export function parentOf(place: Place): Place {
  if (place === null || place === '') return null;
  const trail = place.split('/').slice(0, -2);
  return trail.length === 0 ? '' : `${trail.join('/')}/`;
}

/** An item's kind, as its icon draws it. */
export function kindOf({ name, folder }: FilesItem): 'folder' | 'image' | 'document' {
  if (folder) return 'folder';
  return isImageName(name) ? 'image' : 'document';
}

/** Explorer's Type column: `File folder`, `PNG File`, or `File` for a name without an extension. */
export function typeText(item: FilesItem): string {
  if (item.folder) return 'File folder';
  const extension = fileExtension(item.name);
  return extension === '' ? 'File' : `${extension.toUpperCase()} File`;
}

/** Explorer's Size column: whole KB, rounded up. */
export function sizeText(bytes: number): string {
  return `${Math.ceil(bytes / 1024).toLocaleString()} KB`;
}

const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

/** Explorer's Date modified column. */
export function dateText(lastModified: string): string {
  return dates.format(new Date(lastModified));
}

/** Folders before files, as Explorer sorts each column. */
const byKind = (a: FilesItem, b: FilesItem) => Number(b.folder) - Number(a.folder);
const byName = (a: FilesItem, b: FilesItem) => a.name.localeCompare(b.name);
const sizeOf = (item: FilesItem) => (item.folder ? 0 : item.size);

/** Each column's order, folders first. */
export const compare = {
  name: (a: FilesItem, b: FilesItem) => byKind(a, b) || byName(a, b),
  modified: (a: FilesItem, b: FilesItem) => byKind(a, b) || Date.parse(a.lastModified) - Date.parse(b.lastModified),
  type: (a: FilesItem, b: FilesItem) => byKind(a, b) || typeText(a).localeCompare(typeText(b)) || byName(a, b),
  size: (a: FilesItem, b: FilesItem) => byKind(a, b) || sizeOf(a) - sizeOf(b) || byName(a, b),
};
