// File Explorer's menus: an item's, the open folder's, and View, Sort and Group by, from stock Fluent parts (ADR 0093).
import {
  Menu, MenuDivider, MenuItem, MenuItemCheckbox, MenuItemRadio, MenuList, MenuPopover, MenuTrigger, type MenuCheckedValueChangeData,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowClockwise20Regular, ArrowDownload20Regular, ArrowSort20Regular, ArrowUpload20Regular, ClipboardPaste20Regular, Copy20Regular, Cut20Regular,
  Delete20Regular, Folder20Filled, Grid20Regular, GroupList20Regular, Info20Regular, Link20Regular, Open20Regular, Rename20Regular,
} from '@fluentui/react-icons';
import type { ReactElement, ReactNode } from 'react';
import { KeyedMenuItem, LETTERS } from './files-explorer-keytips';
import type { ListActions } from './files-explorer-actions';
import { GROUP_BYS, SORT_COLUMNS, VIEWS, type FilesItem, type GroupBy, type Sort, type View } from './files-items';
import { FOLDER } from './windows-window';

/** Explorer's panes beside the list, of which one shows at a time. */
export type Pane = 'details' | 'preview';

/** How the open place is laid out: its view, sort, groups and pane, and the changes to each. */
export interface Arrangement {
  view: View;
  sort: Sort;
  groupBy: GroupBy;
  pane: Pane | null;
  onView: (view: View) => void;
  onSort: (sort: Sort) => void;
  onGroupBy: (by: GroupBy) => void;
  onPane: (pane: Pane | null) => void;
}

/** A menu item that opens a menu of its own, with its keytip's letter if it has one. */
export function Submenu({ label, icon, letter, className, children }: { label: string; icon?: ReactElement; letter?: string; className?: string; children: ReactNode }) {
  const props = { ...(icon === undefined ? {} : { icon }), ...(className === undefined ? {} : { className }) };
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        {letter === undefined ? <MenuItem {...props}>{label}</MenuItem> : <KeyedMenuItem {...props} letter={letter}>{label}</KeyedMenuItem>}
      </MenuTrigger>
      <MenuPopover>{children}</MenuPopover>
    </Menu>
  );
}

/** New's items: Folder, as Windows has it first, then Upload. */
export type NewCommands = { canNewFolder: boolean; onNewFolder: () => void; onUpload: () => void };

export function NewItems({ canNewFolder, onNewFolder, onUpload }: NewCommands) {
  return (
    <>
      <MenuItem icon={<Folder20Filled color={FOLDER} />} disabled={!canNewFolder} onClick={onNewFolder}>Folder</MenuItem>
      <MenuItem icon={<ArrowUpload20Regular />} onClick={onUpload}>Upload</MenuItem>
    </>
  );
}

/** The radio a checked-value change picked, if any. */
const picked = ({ checkedItems }: MenuCheckedValueChangeData) => checkedItems[0];

/** View's items: the eight views, then Show, the Details and Preview panes. */
export function ViewMenuList({ arrangement }: { arrangement: Arrangement }) {
  const { view, pane, onView, onPane } = arrangement;
  const shown = pane === null ? [] : [pane];
  return (
    <MenuList
      checkedValues={{ view: [view] }}
      onCheckedValueChange={(_, data) => {
        const chosen = VIEWS.find((each) => each.view === picked(data));
        if (chosen !== undefined) onView(chosen.view);
      }}
    >
      {VIEWS.map((each) => <MenuItemRadio key={each.view} name="view" value={each.view}>{each.label}</MenuItemRadio>)}
      <MenuDivider />
      <Submenu label="Show">
        <MenuList
          checkedValues={{ show: shown }}
          // One pane shows at a time: checking one puts the other away.
          onCheckedValueChange={(_, { checkedItems }) => onPane(checkedItems.find((each): each is Pane => each !== pane && (each === 'details' || each === 'preview')) ?? null)}
        >
          <MenuItemCheckbox name="show" value="details">Details pane</MenuItemCheckbox>
          <MenuItemCheckbox name="show" value="preview">Preview pane</MenuItemCheckbox>
        </MenuList>
      </Submenu>
    </MenuList>
  );
}

/** Group by's items: None, or a column. */
export function GroupMenuList({ arrangement }: { arrangement: Arrangement }) {
  const { groupBy, onGroupBy } = arrangement;
  return (
    <MenuList
      checkedValues={{ group: [groupBy] }}
      onCheckedValueChange={(_, data) => {
        const chosen = GROUP_BYS.find((each) => each.by === picked(data));
        if (chosen !== undefined) onGroupBy(chosen.by);
      }}
    >
      {GROUP_BYS.map((each) => <MenuItemRadio key={each.by} name="group" value={each.by}>{each.label}</MenuItemRadio>)}
    </MenuList>
  );
}

/** Sort's items: the column and the direction, then any others. The same sort as the details view's headers. */
export function SortMenuList({ arrangement, children }: { arrangement: Arrangement; children?: ReactNode }) {
  const { sort, onSort } = arrangement;
  return (
    <MenuList
      checkedValues={{ sort: sort.sortColumn === undefined ? [] : [String(sort.sortColumn)], direction: [sort.sortDirection] }}
      onCheckedValueChange={(_, data) => {
        const value = picked(data);
        if (data.name === 'direction' && (value === 'ascending' || value === 'descending')) onSort({ ...sort, sortDirection: value });
        else if (data.name === 'sort' && value !== undefined) onSort({ ...sort, sortColumn: value });
      }}
    >
      {SORT_COLUMNS.map(({ column, label }) => <MenuItemRadio key={column} name="sort" value={column}>{label}</MenuItemRadio>)}
      <MenuDivider />
      <MenuItemRadio name="direction" value="ascending">Ascending</MenuItemRadio>
      <MenuItemRadio name="direction" value="descending">Descending</MenuItemRadio>
      {children}
    </MenuList>
  );
}

/**
 * An item's menu: Open, then for a file Cut, Copy, Download, Rename and Delete, for a folder Rename, and for either Copy
 * path and Properties. On an item of a selection of several, it acts on them all, and Rename is off. It opens on a right-click, or `open` from
 * Shift+F10 or the menu key; each item has its keytip.
 */
export function RowMenu({ item, open, actions, children }: { item: FilesItem; open: boolean; actions: ListActions; children: ReactElement }) {
  const many = actions.many(item);
  const letters = LETTERS.row;
  type Entry = { label: keyof typeof letters; icon: ReactElement; act: (item: FilesItem) => void; off: boolean };
  const entries: Entry[] = [
    { label: 'Open', icon: <Open20Regular />, act: actions.onOpen, off: false },
    ...(item.folder ? [
      { label: 'Rename', icon: <Rename20Regular />, act: actions.onStartRename, off: many },
    ] satisfies Entry[] : [
      { label: 'Cut', icon: <Cut20Regular />, act: actions.onCut, off: false },
      { label: 'Copy', icon: <Copy20Regular />, act: actions.onCopy, off: false },
      { label: 'Download', icon: <ArrowDownload20Regular />, act: actions.onDownload, off: false },
      { label: 'Rename', icon: <Rename20Regular />, act: actions.onStartRename, off: many },
      { label: 'Delete', icon: <Delete20Regular />, act: actions.onDelete, off: false },
    ] satisfies Entry[]),
  ];
  const entry = ({ label, icon, act, off }: Entry) => (
    <KeyedMenuItem key={label} letter={letters[label]} icon={icon} disabled={off} onClick={() => act(item)}>{label}</KeyedMenuItem>
  );
  return (
    <Menu openOnContext open={open} onOpenChange={(_, data) => { if (data.open) actions.onPoint(item); actions.onMenu(data.open ? item : null); }}>
      <MenuTrigger disableButtonEnhancement>{children}</MenuTrigger>
      <MenuPopover>
        <MenuList>
          {entries.map(entry)}
          <MenuDivider />
          {entry({ label: 'Copy path', icon: <Link20Regular />, act: actions.onCopyPath, off: false })}
          {entry({ label: 'Properties', icon: <Info20Regular />, act: actions.onProperties, off: false })}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

/**
 * The open folder's menu, on a right-click of the list's empty space, or `open` from Shift+F10 or the menu key with
 * nothing selected: View, Sort by and Group by, Refresh, Paste, New (Folder and Upload), and the folder's Properties, each with its
 * keytip. A right-click on an item opens the item's menu instead.
 */
export function FolderMenu({ arrangement, open, onOpenChange, canPaste, news, onRefresh, onPaste, onProperties, children }: {
  arrangement: Arrangement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canPaste: boolean;
  news: NewCommands;
  onRefresh: () => void;
  onPaste: () => void;
  onProperties: () => void;
  children: ReactElement;
}) {
  const letters = LETTERS.folder;
  return (
    <Menu openOnContext open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <MenuTrigger disableButtonEnhancement>{children}</MenuTrigger>
      <MenuPopover>
        <MenuList>
          <Submenu label="View" letter={letters.View} icon={<Grid20Regular />}><ViewMenuList arrangement={arrangement} /></Submenu>
          <Submenu label="Sort by" letter={letters['Sort by']} icon={<ArrowSort20Regular />}><SortMenuList arrangement={arrangement} /></Submenu>
          <Submenu label="Group by" letter={letters['Group by']} icon={<GroupList20Regular />}><GroupMenuList arrangement={arrangement} /></Submenu>
          <MenuDivider />
          <KeyedMenuItem letter={letters.Refresh} icon={<ArrowClockwise20Regular />} onClick={onRefresh}>Refresh</KeyedMenuItem>
          <MenuDivider />
          <KeyedMenuItem letter={letters.Paste} icon={<ClipboardPaste20Regular />} disabled={!canPaste} onClick={onPaste}>Paste</KeyedMenuItem>
          <Submenu label="New" letter={letters.New} icon={<Add20Regular />}><MenuList><NewItems {...news} /></MenuList></Submenu>
          <MenuDivider />
          <KeyedMenuItem letter={letters.Properties} icon={<Info20Regular />} onClick={onProperties}>Properties</KeyedMenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
