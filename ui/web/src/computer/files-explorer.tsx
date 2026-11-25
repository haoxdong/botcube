// The Files window as Windows 11 File Explorer, from stock Fluent parts (ADR 0093).
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, makeStyles, mergeClasses, MessageBar, MessageBarBody,
  ProgressBar, Spinner, Text, tokens,
} from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Fades } from '../app/motion';
import { FilesChart, opensAsChart } from './files-chart';
import { CommandBar } from './files-explorer-commands';
import { DetailsList, type ListActions, type Sort } from './files-explorer-list';
import { AddressRow, NavPane, useExplorerStyles, type Crumb } from './files-explorer-nav';
import { foldersIn, itemsIn, parentOf, recentsIn, sizeText, type FilesItem, type Place } from './files-items';
import type { FileEntry, UploadOptions } from './files-service';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, containerType: 'inline-size' },
  body: { display: 'flex', flex: 1, minHeight: 0 },
  main: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 },
  list: { position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'auto' },
  dropping: {
    outlineWidth: tokens.strokeWidthThick,
    outlineStyle: 'dashed',
    outlineColor: tokens.colorBrandStroke1,
    outlineOffset: `calc(-1 * ${tokens.strokeWidthThick})`,
  },
  centered: { margin: 'auto', padding: tokens.spacingHorizontalXXL, textAlign: 'center' },
  upload: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(80px, 2fr) auto', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: `0 ${tokens.spacingHorizontalS}` },
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

type Upload = { id: number; name: string; fraction: number; controller: AbortController };

/** The open place's items: none until Files has answered, Home's recent files, or a folder's own items. */
function listingOf(files: readonly FileEntry[] | null, place: Place): FilesItem[] {
  if (files === null) return [];
  return place === null ? recentsIn(files) : itemsIn(files, place);
}

/** Explorer's keys outside a text field: Escape forgets the cut, Ctrl+X cuts the selected file, Ctrl+V pastes. */
function onShortcut(event: KeyboardEvent, { file, setCut, paste }: { file: FilesItem | undefined; setCut: (path: string | null) => void; paste: () => void }) {
  if (event.target instanceof HTMLInputElement) return;
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (event.key === 'Escape') setCut(null);
  else if (command && key === 'x' && file !== undefined) setCut(file.path);
  else if (command && key === 'v') paste();
}

/**
 * The Files window, as Windows 11 File Explorer draws it in details view: the address row (Back, Forward, Up, Refresh,
 * the path and a search of the open place), a command bar, a navigation pane of Home and workspace's folders, the open
 * place's items, and a status bar. Home lists the newest files. A folder opens in place, a chart opens live, any other
 * file downloads. The listing reloads as a place opens.
 */
export function FilesWindow({ files, error, onDownload, onDelete, onRename, onMove, onReload, onUpload, thumbnailUrl }: {
  /** Null until the Chat Service has answered. */
  files: readonly FileEntry[] | null;
  error: string | null;
  onDownload: (name: string) => void;
  /** Settles once the Chat Service answers; rejects when it refuses, and the file shows again. */
  onDelete: (name: string) => Promise<void> | void;
  /** A file's path, and the new name it takes in its folder; returns the new path when it shows at once. */
  onRename: (path: string, name: string) => string | null;
  /** Move a file into a folder ('' for workspace), as Paste does after Cut. */
  onMove: (path: string, folder: string) => void;
  /** Reload the listing. */
  onReload: () => void;
  /** Upload a file into a folder ('' for workspace); settles once it is in Files, or refused, or cancelled. */
  onUpload: (file: File, options: UploadOptions, folder: string) => Promise<string>;
  /** A URL a file loads from, as a chart does. */
  thumbnailUrl: (path: string) => Promise<string>;
}) {
  const styles = useStyles();
  const explorer = useExplorerStyles();
  // The open place, and the places Back and Forward return to, nearest last and first.
  const [visits, setVisits] = useState<{ back: Place[]; place: Place; forward: Place[] }>({ back: [], place: '', forward: [] });
  const { back, place, forward } = visits;
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(() => sortFor(''));
  // A chart opens live in the list's place.
  const [viewing, setViewing] = useState<FilesItem | null>(null);
  const listed = listingOf(files, place);
  const items = listed.filter(({ name }) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const chosen = items.find(({ path }) => path === selected);
  const file = chosen?.folder === false ? chosen : undefined;
  const trail = place === null ? [] : place.split('/').slice(0, -1);
  const crumbs: [Crumb, ...Crumb[]] = place === null
    ? [{ name: 'Home', target: null }]
    : [{ name: 'workspace', target: '' }, ...trail.map((name, index) => ({ name, target: `${trail.slice(0, index + 1).join('/')}/` }))];

  // Opening a place reloads the listing, so it shows what the agent has saved since.
  const visit = (next: typeof visits) => {
    setVisits(next);
    setSelected(null);
    setQuery('');
    setViewing(null);
    const { place: opened } = next;
    setSort(sortFor(opened));
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
  const open = (item: FilesItem) => (item.folder ? go(item.path) : opensAsChart(item.name) ? setViewing(item) : onDownload(item.path));

  const root = useRef<HTMLDivElement>(null);
  // The file whose Delete waits on the dialog's confirmation, until the dialog has gone.
  const [deleting, setDeleting] = useState<{ item: FilesItem; open: boolean } | null>(null);
  const closeDelete = () => setDeleting((current) => (current === null ? null : { ...current, open: false }));
  // A file whose Delete was refused: focus goes back to its row as it shows again.
  const [refocus, setRefocus] = useState<string | null>(null);
  useEffect(() => {
    // The dialog holds focus until it has gone.
    if (refocus === null || deleting !== null) return;
    const row = [...(root.current?.querySelectorAll<HTMLElement>('.agent-computer-file') ?? [])].find(({ dataset }) => dataset.filePath === refocus);
    if (row === undefined) return;
    row.focus();
    setRefocus(null);
  }, [refocus, files, deleting]);
  const confirmDelete = () => {
    closeDelete();
    if (deleting === null) return;
    const { path } = deleting.item;
    void Promise.resolve(onDelete(path)).catch(() => setRefocus(path));
  };

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
    if (shown !== null && selected === renaming.path) setSelected(shown);
  };
  // The cut file, which Paste moves into the open folder; Paste does nothing in Home.
  const [cut, setCut] = useState<string | null>(null);
  const paste = () => {
    if (cut === null || place === null) return;
    setCut(null);
    if (cut.slice(0, cut.lastIndexOf('/') + 1) !== place) onMove(cut, place);
  };
  const shortcut = (event: KeyboardEvent) => onShortcut(event, { file, setCut, paste });
  const actions: ListActions = {
    onSelect: setSelected,
    onOpen: open,
    onCut: (item) => setCut(item.path),
    onDownload: (item) => onDownload(item.path),
    onStartRename: (item) => {
      renameEnded.current = false;
      setSelected(item.path);
      setRenaming(item);
    },
    onDelete: (item) => setDeleting({ item, open: true }),
    onEndRename: endRename,
  };

  // Uploads land in the open folder, or workspace from Home; each shows its progress until it ends.
  const [uploads, setUploads] = useState<readonly Upload[]>([]);
  const nextUpload = useRef(0);
  const [dropping, setDropping] = useState(false);
  const upload = (chosenFiles: FileList | null) => {
    for (const each of chosenFiles ?? []) {
      const entry: Upload = { id: nextUpload.current++, name: each.name, fraction: 0, controller: new AbortController() };
      setUploads((all) => [...all, entry]);
      const onProgress = (fraction: number) => setUploads((all) => all.map((one) => (one.id === entry.id ? { ...one, fraction } : one)));
      const ended = () => setUploads((all) => all.filter(({ id }) => id !== entry.id));
      // The app says why an upload failed; the window only stops showing its progress.
      void onUpload(each, { onProgress, signal: entry.controller.signal }, place ?? '').then(ended, ended);
    }
  };
  // The browser's file chooser: Fluent has no file picker part, so an input is made for each choice, never drawn.
  const chooseFiles = () => {
    const chooser = document.createElement('input');
    chooser.type = 'file';
    chooser.multiple = true;
    chooser.onchange = () => upload(chooser.files);
    chooser.click();
  };
  const dragsFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');

  const folders = files === null ? [] : foldersIn(files);
  const loading = files === null && error === null;
  const empty = files !== null && files.length === 0;
  return (
    <div ref={root} role="region" className={mergeClasses('agent-computer-files', styles.root)} aria-label="Files">
      <AddressRow
        crumbs={crumbs}
        canBack={back.length > 0}
        canForward={forward.length > 0}
        canUp={up !== null}
        query={query}
        onBack={goBack}
        onForward={goForward}
        onUp={() => { if (up !== null) go(up); }}
        onRefresh={onReload}
        places={folders}
        onOpen={go}
        onQuery={setQuery}
      />
      <CommandBar
        hasFile={file !== undefined}
        canPaste={cut !== null && place !== null}
        onUpload={chooseFiles}
        onCut={() => { if (file !== undefined) setCut(file.path); }}
        onPaste={paste}
        onDownload={() => { if (file !== undefined) onDownload(file.path); }}
        onRename={() => { if (file !== undefined) actions.onStartRename(file); }}
        onDelete={() => { if (file !== undefined) actions.onDelete(file); }}
      />
      <Fades>{error !== null && (
        <div key="error">
          <MessageBar intent="error" role="alert"><MessageBarBody>{error}</MessageBarBody></MessageBar>
        </div>
      )}</Fades>
      <div className={styles.body}>
        <NavPane folders={folders} place={place} onOpen={go} />
        <div className={styles.main}>
          <div
            className={mergeClasses(styles.list, dropping && styles.dropping)}
            onKeyDown={shortcut}
            onDragOver={(event) => {
              if (!dragsFiles(event)) return;
              event.preventDefault();
              setDropping(true);
            }}
            onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropping(false); }}
            onDrop={(event) => {
              if (!dragsFiles(event)) return;
              event.preventDefault();
              setDropping(false);
              upload(event.dataTransfer.files);
            }}
          >
            <Spinner size="tiny" label="Loading" className={mergeClasses(styles.centered, !loading && explorer.hidden)} />
            <Text className={mergeClasses('agent-computer-files-empty', styles.centered, !empty && explorer.hidden)}>
              No files yet. Files the agent downloads appear here within a minute or two.
            </Text>
            <FilesChart file={viewing} fileUrl={thumbnailUrl} onDownload={onDownload} onClose={() => setViewing(null)} />
            <DetailsList
              items={items}
              sort={sort}
              onSort={setSort}
              selected={selected}
              cut={cut}
              renaming={renaming?.path ?? null}
              actions={actions}
              className={mergeClasses((files === null || empty || viewing !== null) && explorer.hidden)}
            />
          </div>
          {uploads.map(({ id, name, fraction, controller }) => (
            <div key={id} className={styles.upload}>
              <Text size={200} truncate wrap={false}>{name}</Text>
              <ProgressBar value={fraction} aria-label={`Uploading ${name}`} />
              <Button appearance="subtle" size="small" icon={<Dismiss20Regular />} aria-label={`Cancel upload ${name}`} title="Cancel upload" onClick={() => controller.abort()} />
            </div>
          ))}
          <div role="status" className={styles.status}>
            <Text size={200}>{files === null ? '' : countText(items.length)}</Text>
            <Text size={200}>{chosen === undefined ? '' : '1 item selected'}</Text>
            <Text size={200}>{file === undefined ? '' : sizeText(file.size)}</Text>
          </div>
        </div>
      </div>
      <Dialog
        open={deleting?.open === true}
        modalType="alert"
        onOpenChange={(_, data) => { if (!data.open) closeDelete(); }}
        surfaceMotion={{ onMotionFinish: (_, { direction }) => { if (direction === 'exit') setDeleting(null); } }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete file</DialogTitle>
            <DialogContent>{`Delete “${deleting?.item.name ?? ''}”? This can't be undone.`}</DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={closeDelete}>Cancel</Button>
              <Button appearance="primary" onClick={confirmDelete}>Delete</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
