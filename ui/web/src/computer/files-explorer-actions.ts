// What File Explorer's views share with their menus and the tab: what they do to an item, and what they show of it
// (ADR 0093).
import type { MouseEvent } from 'react';
import type { FilesItem } from './files-items';

/** How a click on an item was made: with Ctrl (or Cmd) it toggles the item, with Shift it selects a range. */
type ClickKeys = Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>;

/** What a view does to an item: select or open it, act on it from its menu, or end its rename (null cancels). */
export interface ListActions {
  onClick: (item: FilesItem, keys: ClickKeys) => void;
  /** A right-click, before its menu opens. */
  onPoint: (item: FilesItem) => void;
  onOpen: (item: FilesItem) => void;
  onCut: (item: FilesItem) => void;
  onCopy: (item: FilesItem) => void;
  onDownload: (item: FilesItem) => void;
  onStartRename: (item: FilesItem) => void;
  onDelete: (item: FilesItem) => void;
  onCopyPath: (item: FilesItem) => void;
  onProperties: (item: FilesItem) => void;
  onEndRename: (name: string | null) => void;
  /** An item's menu opened, or (null) the open one closed. */
  onMenu: (item: FilesItem | null) => void;
  /** Whether an item's menu acts on several items, the selection it is part of; Rename then is off. */
  many: (item: FilesItem) => boolean;
}

/** What a view shows of the items: which are selected, cut (dimmed until pasted) and being renamed, and whose menu is open. */
export type ItemMarks = { selected: ReadonlySet<string>; cut: ReadonlySet<string>; renaming: string | null; menuOn: string | null };

/** What reveals an item of the virtual grid: it draws the item's row, scrolling to it. */
export type Reveal = { scrollToItem: (index: number) => void };

/** The files Cut or Copy took, which Paste moves or copies into the open folder: one clipboard for every tab. */
export type Clipboard = { paths: readonly string[]; copy: boolean };
export const EMPTY_CLIPBOARD: Clipboard = { paths: [], copy: false };

/** Puts a file into a folder, resolving to the path it took; void where nothing waits on it. */
type Put = (path: string, folder: string) => Promise<string> | void;
type Pasting = { onCopy: Put; onMove: Put; onClipboard: (clipboard: Clipboard) => void };

/** Whether Paste has anything to put in the open place, Home (null) taking nothing. */
export const canPasteInto = (folder: string | null, clipboard: Clipboard) => folder !== null && clipboard.paths.length > 0;

/**
 * Paste into the open place: copied files copy, and stay to paste again; cut files move, those already there staying
 * put. Nothing pastes into Home (null). Resolves to the paths the files took, which Windows then selects.
 */
export async function pasteInto(folder: string | null, clipboard: Clipboard, { onCopy, onMove, onClipboard }: Pasting): Promise<string[]> {
  if (folder === null) return [];
  if (!clipboard.copy && clipboard.paths.length > 0) onClipboard(EMPTY_CLIPBOARD);
  const put = clipboard.copy ? onCopy : onMove;
  const moving = clipboard.paths.filter((path) => clipboard.copy || path.slice(0, path.lastIndexOf('/') + 1) !== folder);
  // A refused file says why through the window's error; the rest are still selected.
  const settled = await Promise.allSettled(moving.map(async (path) => put(path, folder)));
  return settled.flatMap((each) => (each.status === 'fulfilled' && typeof each.value === 'string' ? [each.value] : []));
}

/** New folder shows at once, in rename, as Windows makes one; none in Home. */
export function makeFolder(place: string | null, onNewFolder: (folder: string) => string, startRename: (item: FilesItem) => void) {
  if (place === null) return;
  const path = onNewFolder(place);
  startRename({ name: path.slice(place.length, -1), path, lastModified: new Date().toISOString(), folder: true });
}
