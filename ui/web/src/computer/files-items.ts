import { fileExtension, isImageName } from '../components/file-type-icon';
import type { FileEntry } from './files-service';
import { baseOf, filesPath, underOf } from '../app/files-path';

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
    const inside = underOf(filesPath(folder), filesPath(file.name));
    if (inside === null) continue;
    const [name = '', ...below] = inside.split('/');
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
    .map(({ name, size, lastModified }) => ({ name: baseOf(filesPath(name)), path: name, lastModified, folder: false, size }));
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

/** A sort of the open place's items: by a column, either way, as the details view's headers sort. */
export type Sort = { sortColumn: string | number | undefined; sortDirection: 'ascending' | 'descending' };
type SortColumn = keyof typeof compare;
export const SORT_COLUMNS: readonly { column: SortColumn; label: string }[] = [
  { column: 'name', label: 'Name' },
  { column: 'modified', label: 'Date modified' },
  { column: 'type', label: 'Type' },
  { column: 'size', label: 'Size' },
];
const isColumn = (column: Sort['sortColumn']): column is SortColumn => typeof column === 'string' && Object.hasOwn(compare, column);

/** The items in a sort's order; descending turns the whole order round, folders last, as the details view does. */
export function sortItems(items: readonly FilesItem[], { sortColumn, sortDirection }: Sort): FilesItem[] {
  if (!isColumn(sortColumn)) return [...items];
  const order = compare[sortColumn];
  const way = sortDirection === 'ascending' ? 1 : -1;
  return [...items].sort((a, b) => way * order(a, b));
}

/** Explorer's views, as its View menu names them. */
export const VIEWS = [
  { view: 'xl', label: 'Extra large icons' },
  { view: 'large', label: 'Large icons' },
  { view: 'medium', label: 'Medium icons' },
  { view: 'small', label: 'Small icons' },
  { view: 'list', label: 'List' },
  { view: 'details', label: 'Details' },
  { view: 'tiles', label: 'Tiles' },
  { view: 'content', label: 'Content' },
] as const;
export type View = (typeof VIEWS)[number]['view'];

/** A place's first view: Large icons where more than half of its files are pictures, else Details. */
export function defaultView(items: readonly FilesItem[]): View {
  const files = items.filter(({ folder }) => !folder);
  const pictures = files.filter((item) => kindOf(item) === 'image');
  return pictures.length * 2 > files.length ? 'large' : 'details';
}

/** What Group by groups on: nothing, or a column. */
export type GroupBy = 'none' | SortColumn;
export const GROUP_BYS: readonly { by: GroupBy; label: string }[] = [{ by: 'none', label: 'None' }, ...SORT_COLUMNS.map(({ column, label }) => ({ by: column, label }))];

/** A group of the open place's items: its key, its header with its count, and its items in order. */
export type Group = { key: string; label: string; items: FilesItem[] };

const DAY = 86_400_000;
const KB = 1024;

/** An item's size bucket, as Explorer's Group by Size has them, folders first. */
function sizeGroup(item: FilesItem): [number, string] {
  if (item.folder) return [0, 'Folders'];
  const buckets: [number, string][] = [[16 * KB, 'Tiny'], [KB * KB, 'Small'], [128 * KB * KB, 'Medium']];
  const index = buckets.findIndex(([below]) => item.size < below);
  return index === -1 ? [4, 'Large'] : [index + 1, buckets[index]?.[1] ?? ''];
}

/** An item's name range: digits, three ranges of letters, then any other. */
function nameGroup(item: FilesItem): [number, string] {
  const first = item.name.normalize('NFD').charAt(0).toUpperCase();
  if (/[0-9]/.test(first)) return [0, '0–9'];
  const ranges: [string, string][] = [['A', 'H'], ['I', 'P'], ['Q', 'Z']];
  const index = ranges.findIndex(([from, to]) => first >= from && first <= to && /[A-Z]/.test(first));
  return index === -1 ? [4, 'Other'] : [index + 1, ranges.map(([from, to]) => `${from}–${to}`)[index] ?? ''];
}

/** An item's date group, as Explorer's Group by Date modified has them, from today back. */
function dateGroup(item: FilesItem, now: Date): [number, string] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const week = today - ((now.getDay() + 6) % 7) * DAY;
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const at = Date.parse(item.lastModified);
  if (at >= today) return [0, 'Today'];
  if (at >= week) return [1, 'Earlier this week'];
  if (at >= week - 7 * DAY) return [2, 'Last week'];
  return at >= month ? [3, 'Earlier this month'] : [4, 'Older'];
}

/** The group an item falls in, and that group's place among the others. */
function groupOf(item: FilesItem, by: SortColumn, now: Date): [number, string] {
  if (by === 'type') return [item.folder ? 0 : 1, typeText(item)];
  if (by === 'size') return sizeGroup(item);
  return by === 'name' ? nameGroup(item) : dateGroup(item, now);
}

/** The items in groups, each group in the items' order; one group, with no header, for none. */
export function groupsOf(items: readonly FilesItem[], by: GroupBy, now = new Date()): Group[] {
  if (by === 'none') return [{ key: '', label: '', items: [...items] }];
  const groups = new Map<string, { rank: number; items: FilesItem[] }>();
  for (const item of items) {
    const [rank, name] = groupOf(item, by, now);
    const group = groups.get(name) ?? { rank, items: [] };
    group.items.push(item);
    groups.set(name, group);
  }
  return [...groups]
    .sort(([a, one], [b, other]) => one.rank - other.rank || a.localeCompare(b))
    .map(([name, group]) => ({ key: name, label: `${name} (${group.items.length})`, items: group.items }));
}

/** Where an item is, as Properties says: `workspace`, or `workspace/reports`. */
export function locationText(path: string): string {
  const folder = path.endsWith('/') ? path.slice(0, -1) : path;
  return ['workspace', ...folder.split('/').slice(0, -1)].join('/');
}

/** A folder's size: every file inside it, to any depth. */
function folderSize(files: readonly FileEntry[], folder: string): number {
  return files.filter(({ name }) => name.startsWith(folder)).reduce((total, { size }) => total + size, 0);
}

/** An item's size: a file's own, a folder's files. */
export const sizeIn = (files: readonly FileEntry[], item: FilesItem) => (item.folder ? folderSize(files, item.path) : item.size);
