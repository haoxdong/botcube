// One tab of the Files window: a place in File Explorer, from stock Fluent parts (ADR 0093).
import { makeStyles, mergeClasses, MessageBar, MessageBarBody, Spinner, Text, tokens } from '@fluentui/react-components';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Fades } from '../app/motion';
import { FilesChart, opensAsChart } from './files-chart';
import { ListArea } from './files-explorer-area';
import { CommandBar } from './files-explorer-commands';
import { DeleteDialog } from './files-explorer-delete';
import { ItemsView } from './files-explorer-items';
import { foundBy, onExplorerKey, type KeyActions, type Typed } from './files-explorer-keys';
import { canPasteInto, EMPTY_CLIPBOARD, makeFolder, pasteInto, type Clipboard, type ListActions, type Reveal } from './files-explorer-actions';
import { FolderMenu, type Arrangement, type Pane } from './files-explorer-menus';
import { AddressRow, NavPane, useExplorerStyles, type Crumb } from './files-explorer-nav';
import { DetailsPane, PreviewPane, PropertiesDialog, type Subject } from './files-explorer-panes';
import { UploadRows, useUploads } from './files-explorer-uploads';
import {
  defaultView, foldersIn, groupsOf, itemsIn, parentOf, recentsIn, sizeText, sortItems, VIEWS, type FilesItem, type GroupBy, type Place, type Sort, type View,
} from './files-items';
import { afterPaste, clicked, everything, inverted, NOTHING, pointedAt } from './files-selection';
import type { FileEntry, FolderEntry, UploadOptions } from './files-service';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  body: { display: 'flex', flex: 1, minHeight: 0 },
  main: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 },
  beside: { display: 'flex', flex: 1, minHeight: 0 },
  centered: { margin: 'auto', padding: tokens.spacingHorizontalXXL, textAlign: 'center' },
  status: {
    display: 'flex',
    gap: tokens.spacingHorizontalL,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
});

/** Each place's first order: Home's newest first, a folder's by name. */
const sortFor = (place: Place): Sort => (place === null ? { sortColumn: 'modified', sortDirection: 'descending' } : { sortColumn: 'name', sortDirection: 'ascending' });

const countText = (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`;

/** The open place's items: none until Files has answered, Home's recent files, or a folder's own items. */
function listingOf(files: readonly FileEntry[] | null, folders: readonly FolderEntry[], place: Place): FilesItem[] {
  if (files === null) return [];
  return place === null ? recentsIn(files) : itemsIn(files, place, folders);
}

/** What the window gives each tab: Files, what to do to them, and what the tabs share. */
export type TabProps = {
  files: readonly FileEntry[] | null;
  /** Files' folders, the empty ones among them. */
  folders?: readonly FolderEntry[];
  error: string | null;
  onDownload: (name: string) => void;
  onDelete: (name: string) => Promise<void> | void;
  onRename: (path: string, name: string) => string | null;
  /** Each answers the path the file took. */
  onMove: (path: string, folder: string) => Promise<string> | void;
  onCopy: (path: string, folder: string) => Promise<string> | void;
  /** Makes the first free `New folder` in a folder, answering its path. */
  onNewFolder: (folder: string) => string;
  onReload: () => void;
  onUpload: (file: File, options: UploadOptions, folder: string) => Promise<string>;
  thumbnailUrl: (path: string) => Promise<string>;
  clipboard: Clipboard;
  onClipboard: (clipboard: Clipboard) => void;
  /** The view a place was last shown in, this session, if any. */
  viewOf: (place: Place) => View | undefined;
  onViewOf: (place: Place, view: View) => void;
  /** Whether the window's keytips are showing, so a key is a keytip's letter and not a shortcut. */
  keytipping: () => boolean;
};

/**
 * A tab of the Files window, as Windows 11 File Explorer draws it: the address row (Back, Forward, Up, Refresh, the
 * path and a search of the open place), a command bar, a navigation pane of Home and workspace's folders, the open
 * place's items in its view, a Details or Preview pane, and a status bar. Home lists the newest files. A folder opens in
 * place, a chart opens live, any other file downloads. The listing reloads as a place opens.
 */
export function ExplorerTab({ active, onPlace, className, ...props }: TabProps & { active: boolean; onPlace: (place: Place) => void; className?: string }) {
  const { files, folders: emptyFolders = [], error, onDownload, onDelete, onRename, onMove, onCopy, onNewFolder, onReload, onUpload, thumbnailUrl, clipboard, onClipboard, viewOf, onViewOf, keytipping } = props;
  const styles = useStyles();
  const explorer = useExplorerStyles();
  // The open place, and the places Back and Forward return to, nearest last and first.
  const [visits, setVisits] = useState<{ back: Place[]; place: Place; forward: Place[] }>({ back: [], place: '', forward: [] });
  const { back, place, forward } = visits;
  const [selection, setSelection] = useState(NOTHING);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(() => sortFor(''));
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [pane, setPane] = useState<Pane | null>(null);
  // A chart opens live in the list's place.
  const [viewing, setViewing] = useState<FilesItem | null>(null);
  const listed = listingOf(files, emptyFolders, place);
  const view = viewOf(place) ?? defaultView(listed);
  const items = sortItems(listed.filter(({ name }) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase())), sort);
  const groups = groupsOf(items, groupBy);
  // The items in the order shown, which a Shift+click's range and type-to-find follow.
  const order = groups.flatMap((group) => group.items);
  const paths = order.map(({ path }) => path);
  const chosen = order.filter(({ path }) => selection.paths.includes(path));
  const chosenFiles = chosen.filter(({ folder }) => !folder);
  const [only] = chosen;
  const alone = chosen.length === 1 ? only : undefined;
  const file = alone?.folder === false ? alone : undefined;
  const trail = place === null ? [] : place.split('/').slice(0, -1);
  const crumbs: [Crumb, ...Crumb[]] = place === null
    ? [{ name: 'Home', target: null }]
    : [{ name: 'workspace', target: '' }, ...trail.map((name, index) => ({ name, target: `${trail.slice(0, index + 1).join('/')}/` }))];

  // Opening a place reloads the listing, so it shows what the agent has saved since.
  const visit = (next: typeof visits) => {
    const { place: opened } = next;
    setVisits(next);
    setSelection(NOTHING);
    setQuery('');
    setViewing(null);
    setSort(sortFor(opened));
    setGroupBy('none');
    onPlace(opened);
    onReload();
  };
  const go = (to: Place) => visit(to === place ? visits : { back: [...back, place], place: to, forward: [] });
  const goBack = () => {
    const to = back.at(-1);
    if (to !== undefined) visit({ back: back.slice(0, -1), place: to, forward: [place, ...forward] });
  };
  const goForward = () => {
    const [to, ...further] = forward;
    if (to !== undefined) visit({ back: [...back, place], place: to, forward: further });
  };
  const up = parentOf(place);
  const goUp = () => { if (up !== null) go(up); };
  const open = (item: FilesItem) => (item.folder ? go(item.path) : opensAsChart(item.name) ? setViewing(item) : onDownload(item.path));

  const root = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement | null>(null);
  const reveal = useRef<Reveal | null>(null);
  /** Focus on an item of the view in use: a grid's row in Details, else its card. */
  const focusItem = (path: string) => {
    const part = view === 'details' ? '.fui-DataGridRow' : '.fui-ListItem';
    const target = [...(area.current?.querySelectorAll<HTMLElement>(`${part}[data-file-path]`) ?? [])].find(({ dataset }) => dataset.filePath === path);
    target?.focus();
    return target !== undefined;
  };
  // An item that is to take focus once its row is drawn: one a virtual view brings into its drawn rows, or one whose
  // Delete was refused, as it shows again.
  const [refocus, setRefocus] = useState<string | null>(null);
  const bring = (path: string) => {
    if (focusItem(path)) return;
    reveal.current?.scrollToItem(paths.indexOf(path));
    setRefocus(path);
  };
  // The files whose Delete waits on the dialog's confirmation, until the dialog has gone.
  const [deleting, setDeleting] = useState<{ items: readonly FilesItem[]; open: boolean } | null>(null);
  useEffect(() => {
    // The dialog holds focus until it has gone.
    if (refocus === null || deleting !== null) return;
    if (focusItem(refocus)) setRefocus(null);
  });
  const confirmDelete = () => {
    if (deleting === null) return;
    setDeleting({ ...deleting, open: false });
    for (const { path } of deleting.items) void Promise.resolve(onDelete(path)).catch(() => setRefocus(path));
  };
  const [properties, setProperties] = useState<{ subject: Subject; open: boolean } | null>(null);
  // The item whose menu is open, and whether the folder's is.
  const [menu, setMenu] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState(false);

  // The file whose name is being edited in its row, and whether that edit has ended: Enter's commit or Escape's cancel
  // unmounts the field, and the blur that follows must not commit again.
  const [renaming, setRenaming] = useState<FilesItem | null>(null);
  const renameEnded = useRef(false);
  const endRename = (name: string | null) => {
    if (renaming === null || renameEnded.current) return;
    renameEnded.current = true;
    setRenaming(null);
    if (name === null || name === renaming.name) return;
    const shown = onRename(renaming.path, name);
    if (shown !== null && selection.paths.includes(renaming.path)) setSelection({ paths: [shown], anchor: shown });
  };
  const startRename = (item: FilesItem) => {
    renameEnded.current = false;
    setSelection({ paths: [item.path], anchor: item.path });
    setRenaming(item);
  };
  const canPaste = canPasteInto(place, clipboard);
  const paste = () => void pasteInto(place, clipboard, { onCopy, onMove, onClipboard }).then((pasted) => setSelection((now) => afterPaste(now, pasted)));
  // Copy takes folders too; Cut takes files only.
  const take = (some: readonly FilesItem[], copy: boolean) => onClipboard({ paths: some.filter(({ folder }) => copy || !folder).map(({ path }) => path), copy });
  const newFolder = () => makeFolder(place, onNewFolder, startRename);
  // An item's menu acts on the selection it is part of, else on the item alone.
  const targets = (item: FilesItem) => (selection.paths.includes(item.path) ? chosen : [item]);
  const filesOf = (some: readonly FilesItem[]) => some.filter(({ folder }) => !folder);
  const remove = (some: readonly FilesItem[]) => { if (some.length > 0) setDeleting({ items: some, open: true }); };
  const actions: ListActions = {
    onClick: (item, keys) => setSelection(clicked(selection, item.path, { toggle: keys.ctrlKey || keys.metaKey, range: keys.shiftKey }, paths)),
    onPoint: (item) => setSelection(pointedAt(selection, item.path)),
    onOpen: open,
    onCut: (item) => take(targets(item), false),
    onCopy: (item) => take(targets(item), true),
    onDownload: (item) => filesOf(targets(item)).forEach(({ path }) => onDownload(path)),
    onStartRename: startRename,
    onDelete: (item) => remove(filesOf(targets(item))),
    onCopyPath: (item) => { void navigator.clipboard.writeText(targets(item).map(({ path }) => path).join('\n')); },
    onProperties: (item) => setProperties({ subject: { items: targets(item) }, open: true }),
    onEndRename: endRename,
    onMenu: (item) => setMenu(item?.path ?? null),
    many: (item) => selection.paths.includes(item.path) && chosen.length > 1,
  };
  const placeSubject: Subject = { place, items: listed };
  const showProperties = () => setProperties({ subject: chosen.length > 0 ? { items: chosen } : placeSubject, open: true });
  const arrangement: Arrangement = {
    view, sort, groupBy, pane, onSort: setSort, onGroupBy: setGroupBy, onPane: setPane, onView: (next) => onViewOf(place, next),
  };

  const { uploads, upload, chooseFiles } = useUploads(onUpload, place ?? '');
  const setView = (index: number) => {
    const next = VIEWS[Math.max(0, Math.min(VIEWS.length - 1, index))];
    if (next !== undefined) onViewOf(place, next.view);
  };

  // Explorer's keys, and type-to-find's letters.
  const typed = useRef<Typed>({ text: '', at: -Infinity });
  const keyActions: KeyActions = {
    selectAll: () => setSelection(everything(paths)),
    rename: () => { if (alone !== undefined) startRename(alone); },
    remove: () => remove(chosenFiles),
    back: goBack,
    forward: goForward,
    up: goUp,
    refresh: onReload,
    focusSearch: () => {
      const box = root.current?.querySelector<HTMLInputElement>('input[aria-label="Search"]');
      box?.focus();
      if (box !== document.activeElement) root.current?.querySelector<HTMLButtonElement>('button[aria-label="Search"]')?.click();
    },
    focusAddress: () => root.current?.querySelector<HTMLElement>('[aria-label="Path"] [aria-current="page"]')?.focus(),
    properties: showProperties,
    togglePane: (which) => setPane(pane === which ? null : which),
    view: setView,
    contextMenu: () => {
      const at = selection.anchor !== null && selection.paths.includes(selection.anchor) ? selection.anchor : chosen[0]?.path;
      if (at === undefined) {
        setFolderMenu(true);
        return;
      }
      bring(at);
      setMenu(at);
    },
    cut: () => take(chosenFiles, false),
    copy: () => take(chosen, true),
    paste,
    newFolder,
    forgetCut: () => onClipboard(EMPTY_CLIPBOARD),
    find: (text) => {
      const found = foundBy(text, order, selection.anchor);
      if (found === undefined) return;
      setSelection({ paths: [found.path], anchor: found.path });
      bring(found.path);
    },
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (keytipping()) return;
    const inList = event.target instanceof Node && area.current?.contains(event.target) === true;
    typed.current = onExplorerKey(event, keyActions, { inList, typed: typed.current });
  };

  const folders = files === null ? [] : foldersIn(files, '', emptyFolders);
  const loading = files === null && error === null;
  const empty = files !== null && files.length === 0 && emptyFolders.length === 0;
  const selectedSize = chosenFiles.reduce((total, each) => total + (each.folder ? 0 : each.size), 0);
  return (
    <div ref={root} role="tabpanel" className={mergeClasses(styles.root, className)} onKeyDown={onKey}>
      <AddressRow
        crumbs={crumbs}
        canBack={back.length > 0}
        canForward={forward.length > 0}
        canUp={up !== null}
        query={query}
        onBack={goBack}
        onForward={goForward}
        onUp={goUp}
        onRefresh={onReload}
        places={folders}
        onOpen={go}
        onQuery={setQuery}
      />
      <CommandBar
        hasFiles={chosenFiles.length > 0}
        canCopy={chosen.length > 0}
        canRename={alone !== undefined}
        canPaste={canPaste}
        canNewFolder={place !== null}
        arrangement={arrangement}
        keytips={active && menu === null && !folderMenu}
        selection={{ onSelectAll: keyActions.selectAll, onSelectNone: () => setSelection(NOTHING), onInvert: () => setSelection(inverted(selection, paths)), onProperties: showProperties }}
        onUpload={chooseFiles}
        onNewFolder={newFolder}
        onCut={keyActions.cut}
        onCopy={keyActions.copy}
        onPaste={paste}
        onDownload={() => chosenFiles.forEach(({ path }) => onDownload(path))}
        onRename={keyActions.rename}
        onDelete={keyActions.remove}
      />
      <Fades>{error !== null && (
        <div key="error">
          <MessageBar intent="error" role="alert"><MessageBarBody>{error}</MessageBarBody></MessageBar>
        </div>
      )}</Fades>
      <div className={styles.body}>
        <NavPane folders={folders} place={place} onOpen={go} />
        <div className={styles.main}>
          <div className={styles.beside}>
            <FolderMenu
              arrangement={arrangement}
              open={folderMenu}
              onOpenChange={setFolderMenu}
              canPaste={canPaste}
              news={{ canNewFolder: place !== null, onNewFolder: newFolder, onUpload: chooseFiles }}
              onRefresh={onReload}
              onPaste={paste}
              onProperties={() => setProperties({ subject: placeSubject, open: true })}
            >
              <ListArea
                areaRef={area}
                onDropFiles={upload}
                onArrowed={(path, moved) => setSelection(clicked(selection, path, moved, paths))}
                onStep={(by) => setView(VIEWS.findIndex((each) => each.view === view) + by)}
              >
                <Spinner size="tiny" label="Loading" className={mergeClasses(styles.centered, !loading && explorer.hidden)} />
                <Text className={mergeClasses('agent-computer-files-empty', styles.centered, !empty && explorer.hidden)}>
                  No files yet. Files the agent downloads appear here within a minute or two.
                </Text>
                <FilesChart file={viewing} fileUrl={thumbnailUrl} onDownload={onDownload} onClose={() => setViewing(null)} />
                <ItemsView
                  items={order}
                  groups={groups}
                  groupBy={groupBy}
                  view={view}
                  sort={sort}
                  onSort={setSort}
                  marks={{ selected: new Set(selection.paths), cut: new Set(clipboard.copy ? [] : clipboard.paths), renaming: renaming?.path ?? null, menuOn: menu }}
                  actions={actions}
                  shown={active && viewing === null}
                  thumbnailUrl={thumbnailUrl}
                  onSelection={(next) => setSelection({ paths: next, anchor: next.at(-1) ?? null })}
                  reveal={reveal}
                  className={mergeClasses((files === null || empty || viewing !== null) && explorer.hidden)}
                />
              </ListArea>
            </FolderMenu>
            <DetailsPane open={pane === 'details'} subject={chosen.length > 0 ? { items: chosen } : placeSubject} files={files ?? []} thumbnailUrl={thumbnailUrl} onClose={() => setPane(null)} />
            <PreviewPane open={pane === 'preview'} file={file ?? null} thumbnailUrl={thumbnailUrl} onDownload={onDownload} onClose={() => setPane(null)} />
          </div>
          <UploadRows uploads={uploads} />
          <div role="status" className={styles.status}>
            <Text size={200}>{files === null ? '' : countText(items.length)}</Text>
            <Text size={200}>{chosen.length === 0 ? '' : `${countText(chosen.length)} selected`}</Text>
            <Text size={200}>{chosenFiles.length === 0 ? '' : sizeText(selectedSize)}</Text>
          </div>
        </div>
      </div>
      <DeleteDialog shown={deleting} onCancel={() => setDeleting((was) => (was === null ? null : { ...was, open: false }))} onConfirm={confirmDelete} onGone={() => setDeleting(null)} />
      <PropertiesDialog
        shown={properties}
        files={files ?? []}
        onClose={() => setProperties((was) => (was === null ? null : { ...was, open: false }))}
        onGone={() => setProperties(null)}
      />
    </div>
  );
}
