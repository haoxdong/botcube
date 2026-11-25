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
