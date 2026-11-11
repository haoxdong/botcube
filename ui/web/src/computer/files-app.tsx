"use client";

import { Collapse, Presence, presenceMotion } from "../app/collapse";

import { m as motionElement } from "framer-motion";

import { ChevronLeft, ChevronRight, Clock, Folder } from 'lucide-react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type RefObject, type MouseEvent } from 'react';
import { contextMenuKey } from "../app/context-menu-key";
import { ContextMenu } from '@base-ui/react/context-menu';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { FileName } from './file-name';
import { FileTypeIcon, isImageName } from '../components/file-type-icon';
import { FilesChart, opensAsChart } from './files-chart';
import { Thumbnail } from './thumbnail';
import { deleteFile, fileDownloadUrl, listFiles, renameFile, type FileEntry } from './files-service';

import { LoadingSkeleton } from 'botcube-ui-web/load-state';

const MotionClock = motionElement.create(Clock);
const MotionFolder = motionElement.create(Folder);

/** An item of the open folder: a file, with its size, or a folder holding files further down. */
type FilesItem = {
  name: string;
  /** The file's path, or the folder's path with its trailing slash. */
  path: string;
} & ({ folder: false; size: number } | { folder: true });

/** The items inside a folder ('' for the top, else its path with a trailing slash), in name order as Finder sorts them. */
function itemsIn(files: readonly FileEntry[], folder: string): FilesItem[] {
  // Keyed by path, so a file and a folder of the same name, which storage allows, both stay listed.
  const items = new Map<string, FilesItem>();
  for (const file of files) {
    if (!file.name.startsWith(folder)) continue;
    const [name = '', ...below] = file.name.slice(folder.length).split('/');
    const path = below.length === 0 ? file.name : `${folder}${name}/`;
    items.set(path, below.length === 0 ? { name, path, folder: false, size: file.size } : { name, path, folder: true });
  }
  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** How many files Recents lists. */
const RECENTS = 20;

/** Recents: the newest files in every folder, newest first. */
function recentsIn(files: readonly FileEntry[]): FilesItem[] {
  return [...files]
    .sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified))
    .slice(0, RECENTS)
    .map(({ name, size }) => ({ name: name.slice(name.lastIndexOf('/') + 1), path: name, folder: false, size }));
}

/** A light blue folder with its tab, as the dock's Files icon draws it. */
export const FOLDER_ICON = (
  <>
    <path d="M2 9a3 3 0 0 1 3-3h7l3 3h12a3 3 0 0 1 3 3v2H2z" style={{ fill: 'var(--color-blue)' }} />
    <rect x="2" y="11" width="28" height="17" rx="3" style={{ fill: 'var(--color-bubble)' }} />
  </>
);

/** A flat folder in the dock's two blues; a file's icon is its type's, from `FileTypeIcon`. */
const FOLDER = (
  <svg viewBox="0 0 64 52" aria-hidden="true">
    <path d="M2 10a5 5 0 0 1 5-5h15l6 6h29a5 5 0 0 1 5 5v4H2z" style={{ fill: 'var(--color-blue)' }} />
    <rect x="2" y="15" width="60" height="35" rx="6" style={{ fill: 'var(--color-bubble)' }} />
  </svg>
);

/** An item's kind: a folder, an image Files shows as its picture, or any other file, a document. */
function kindOf({ name, folder }: FilesItem) {
  if (folder) return 'folder';
  return isImageName(name) ? 'image' : 'document';
}

/** A size in binary units, as Thunar gives it: `n bytes` under a KiB, else KiB, MiB or GiB to one decimal. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const [scale, unit] = bytes < 1024 ** 2 ? [1024, 'KiB'] : bytes < 1024 ** 3 ? [1024 ** 2, 'MiB'] : [1024 ** 3, 'GiB'];
  return `${(bytes / scale).toFixed(1)} ${unit}`;
}

/** What a place holds, in Thunar's words: `2 folders, 6 files`, a zero part left out. */
function countsText(items: readonly FilesItem[]): string {
  const folders = items.filter(({ folder }) => folder).length;
  const parts = ([[folders, 'folder'], [items.length - folders, 'file']] as const)
    .filter(([count]) => count > 0)
    .map(([count, noun]) => `${count} ${noun}${count === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** Where Files is: a folder ('' for workspace, the top, else its path with a trailing slash), or Recents (null). */
type Place = string | null;

/**
 * The Files window, as Thunar draws it: a toolbar of Back, Forward and the open place's location, each folder of it
 * opening that folder; a Places sidebar of Recents, workspace and workspace's own folders, flush to the window's edge;
 * the place's files and folders in icon view, an image as its own picture; and a status bar saying what the place
 * holds, or the selected file's name and size. A click selects an item and a double-click (or Enter) opens it; a
 * right-click (a long-press on a phone, or the context-menu key) opens a file's menu of Download, Rename and Delete.
 * The listing reloads as a place opens.
 */
export function FilesWindow({
  files,
  error,
  onDownload,
  onDelete,
  onRename,
  onReload,
  thumbnailUrl,
}: {
  /** Null until the Chat Service has answered. */
  files: readonly FileEntry[] | null;
  error: string | null;
  onDownload: (name: string) => void;
  /** Settles once the Chat Service answers; rejects when it refuses, and the file shows again. */
  onDelete: (name: string) => Promise<void> | void;
  /** A file's path, and the new name it takes in its folder; returns the new path when it shows at once. */
  onRename: (path: string, name: string) => string | null;
  /** Reload the listing. */
  onReload: () => void;
  /** A URL an image file's picture loads from. */
  thumbnailUrl: (path: string) => Promise<string>;
}) {
  // The open place, and the places Back and Forward return to, nearest last and first.
  const [visits, setVisits] = useState<{ back: Place[]; place: Place; forward: Place[] }>({ back: [], place: '', forward: [] });
  const { back, place, forward } = visits;
  // The selected item's path: Finder highlights it until another is chosen.
  const [selected, setSelected] = useState<string | null>(null);
  const items = files === null ? [] : place === null ? recentsIn(files) : itemsIn(files, place);
  const trail = place === null ? [] : place.split('/').slice(0, -1);
  // The location's folders, from workspace down to the open one, with the path each opens.
  const crumbs = [{ name: 'workspace', path: '' }, ...trail.map((name, index) => ({ name, path: `${trail.slice(0, index + 1).join('/')}/` }))];
  // The sidebar's folders: workspace, then its own folders as the listing has them.
  const places = [{ name: 'workspace', path: '' }, ...(files === null ? [] : itemsIn(files, '').filter(({ folder }) => folder))];
  // The selected file in view, whose name and size the status bar gives in place of the place's counts.
  const chosen = items.find(({ path }) => path === selected);
  const status = chosen === undefined || chosen.folder ? countsText(items) : `“${chosen.name}” ${sizeText(chosen.size)}`;
  // Why each of the open place's pictures failed to load, said until another place opens.
  const [brokenPictures, setBrokenPictures] = useState<readonly string[]>([]);
  const pictureFailed = useCallback((message: string) => setBrokenPictures((said) => [...said, message]), []);
  // An item's icon, or an image's own picture.
  const icon = (item: FilesItem) => {
    const kind = kindOf(item);
    if (kind === 'folder') return FOLDER;
    return kind === 'image'
      ? <Thumbnail path={item.path} name={item.name} thumbnailUrl={thumbnailUrl} onFailure={pictureFailed} />
      : <FileTypeIcon name={item.name} />;
  };
  // Opening a place reloads the listing, so it shows what the agent has saved since.
  const visit = (next: typeof visits) => {
    setVisits(next);
    setBrokenPictures([]);
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
  // A chart opens live in the listing's place.
  const [viewing, setViewing] = useState<FilesItem | null>(null);
  const open = (item: FilesItem) => (item.folder ? go(item.path) : opensAsChart(item.name) ? setViewing(item) : onDownload(item.path));
  const view = useRef<HTMLDivElement>(null);
  // The file whose Delete waits on the sheet's confirmation, and its button that focus returns to.
  const [deleting, setDeleting] = useState<{ row: FilesItem; opener: HTMLElement; open: boolean } | null>(null);
  const deleteFocus = useRef<{ opener: HTMLElement; path: string } | null>(null);
  const closeSheet = () => {
    setDeleting((current) => current === null ? null : { ...current, open: false });
  };
  // A file whose Delete was refused: its row shows again, and focus goes back to it.
  const [refocus, setRefocus] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (refocus === null) return;
    const frame = requestAnimationFrame(() => {
      [...(view.current?.querySelectorAll<HTMLElement>('.agent-computer-file') ?? [])].find((row) => row.dataset.filePath === refocus)?.focus();
      setRefocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [refocus]);
  // The file whose name is being edited under its icon, and whether that edit has ended: Enter's commit or Escape's
  // cancel unmounts the field, and the blur that follows must not commit again.
  const [renaming, setRenaming] = useState<FilesItem | null>(null);
  const renameEnded = useRef(false);
  const nameField = useRef<HTMLInputElement>(null);
  const endRename = (name: string | null) => {
    if (renaming === null || renameEnded.current) return;
    renameEnded.current = true;
    setRenaming(null);
    if (name === null || name === renaming.name) return;
    const shown = onRename(renaming.path, name);
    if (shown !== null && selected === renaming.path) setSelected(shown);
  };
  const menuItems: { label: string; act: (at: { row: FilesItem; opener: HTMLElement }) => void }[] = [
    { label: 'Download', act: ({ row }) => onDownload(row.path) },
    {
      label: 'Rename',
      act: ({ row }) => {
        renameEnded.current = false;
        setRenaming(row);
      },
    },
    { label: 'Delete', act: ({ row, opener }) => { deleteFocus.current = { opener, path: row.path }; setDeleting({ row, opener, open: true }); } },
  ];
  useEffect(() => {
    // As in Finder, the name is selected up to its extension.
    const dot = renaming?.name.lastIndexOf('.') ?? -1;
    nameField.current?.focus();
    nameField.current?.setSelectionRange(0, dot > 0 ? dot : (renaming?.name.length ?? 0));
  }, [renaming]);
  return (
    <div ref={view} tabIndex={-1} className="agent-computer-files" aria-label="Files">
      <nav className="agent-computer-files-sidebar" aria-label="Sidebar">
        <p>Places</p>
        <button type="button" aria-current={place === null ? 'true' : undefined} onClick={() => go(null)}>
          <Clock aria-hidden="true" />
          <span>Recents</span>
        </button>
        {places.map(({ name, path }) => (
          <button key={path} type="button" aria-current={place === path ? 'true' : undefined} onClick={() => go(path)}>
            <Folder aria-hidden="true" />
            <span>{name}</span>
          </button>
        ))}
      </nav>
      <div className="agent-computer-files-main">
        <div className="agent-computer-files-toolbar">
          <button type="button" aria-label="Back" title="Back" disabled={back.length === 0} onClick={goBack}>
            <ChevronLeft aria-hidden="true" />
          </button>
          <button type="button" aria-label="Forward" title="Forward" disabled={forward.length === 0} onClick={goForward}>
            <ChevronRight aria-hidden="true" />
          </button>
          {/* The location field: the open place, its folders from workspace down, the leading ones giving way first. */}
          <nav className="agent-computer-files-path" aria-label="Path">
            <Presence>{place === null ? <MotionClock {...presenceMotion} key="0" aria-hidden="true" /> : <MotionFolder {...presenceMotion} key="1" aria-hidden="true" />}</Presence>
            <span className="agent-computer-files-crumbs">
              <Presence>{place === null ? (
                <motionElement.span {...presenceMotion} aria-current="true">Recents</motionElement.span>
              ) : (
                crumbs.map(({ name, path }, index) => (
                  <Fragment key={path}>
                    <Presence>{index > 0 && <motionElement.span {...presenceMotion} aria-hidden="true">›</motionElement.span>}</Presence>
                    <button type="button" aria-current={path === place ? 'true' : undefined} onClick={() => go(path)}>{name}</button>
                  </Fragment>
                ))
              )}</Presence>
            </span>
          </nav>
        </div>
  
        <AlertDialog.Root open={deleting?.open === true} onOpenChange={(open) => { if (!open) closeSheet(); }} onOpenChangeComplete={(open) => { if (!open) setDeleting(null); }}>
          <AlertDialog.Portal container={view.current}>
            <AlertDialog.Popup className="agent-computer-files-sheet standard-popup" aria-label="Delete file" finalFocus={() => {
              const target = deleteFocus.current;
              if (target?.opener.isConnected) return target.opener;
              return [...(view.current?.querySelectorAll<HTMLElement>(".agent-computer-file") ?? [])].find((row) => row.dataset.filePath === target?.path) ?? view.current;
            }}>
              <p>{`Delete “${deleting?.row.name}”? This can't be undone.`}</p>
              <AlertDialog.Close render={<button type="button" />}>Cancel</AlertDialog.Close>
              <button type="button" className="agent-computer-files-delete" onClick={() => {
                closeSheet();
                if (deleting === null) return;
                const { path } = deleting.row;
                void Promise.resolve(onDelete(path)).catch(() => setRefocus(path));
              }}>Delete</button>
            </AlertDialog.Popup>
          </AlertDialog.Portal>
        </AlertDialog.Root>
        <Presence>{error && <motionElement.p {...presenceMotion} className="agent-computer-error" role="alert">{error}</motionElement.p>}</Presence>
        {brokenPictures.map((message, index) => <p key={index} className="agent-computer-error" role="alert">{message}</p>)}
        <Collapse open={files === null && error === null} appear={false}><LoadingSkeleton label="Files" /></Collapse>
        <Presence>{files !== null && files.length === 0 && (
          <motionElement.p {...presenceMotion} className="agent-computer-files-empty">No files yet. Files the agent downloads appear here within a minute or two.</motionElement.p>
        )}</Presence>
        <FilesChart file={viewing} fileUrl={thumbnailUrl} onDownload={onDownload} onClose={() => setViewing(null)} />
        <Presence>{files !== null && viewing === null && (
          <motionElement.div {...presenceMotion} className="agent-computer-files-grid" role="listbox" aria-label={place === null ? 'Recents' : 'Folder contents'}>
            {items.map((item) => <FileMenu key={item.path} container={view} row={item} actions={menuItems} onOpen={() => setSelected(item.path)}><Presence>{item.path === renaming?.path ? (
              <motionElement.div {...presenceMotion} key={item.path} role="option" aria-selected={item.path === selected} className="agent-computer-file" data-file-path={item.path} data-kind={kindOf(item)}>
                {icon(item)}
                <input
                  ref={nameField}
                  className="agent-computer-file-rename"
                  aria-label={`Rename ${item.name}`}
                  defaultValue={item.name}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === 'Enter') endRename(event.currentTarget.value);
                    else if (event.key === 'Escape') {
                      event.stopPropagation();
                      endRename(null);
                    }
                  }}
                  onBlur={(event) => endRename(event.currentTarget.value)}
                />
              </motionElement.div>
            ) : (
              <motionElement.button {...presenceMotion} key="1"
                type="button"
                role="option"
                aria-selected={item.path === selected}
                className="agent-computer-file"
                data-file-path={item.path}
                data-kind={kindOf(item)}
                // The name may show cut short: the item is named, and its tooltip shows, in full.
                aria-label={item.name}
                title={item.name}
                // Enter, a click with no pointer behind it, opens; a pointer's click selects.
                onClick={(event: MouseEvent<HTMLButtonElement>) => (event.detail === 0 ? open(item) : setSelected(item.path))}
                onDoubleClick={() => open(item)}
              >
                {icon(item)}
                <FileName name={item.name} />
              </motionElement.button>
            )}</Presence></FileMenu>)}
          </motionElement.div>
        )}</Presence>
        <Presence>{files !== null && files.length > 0 && <motionElement.p {...presenceMotion} className="agent-computer-files-status" role="status">{status}</motionElement.p>}</Presence>
      </div>

    </div>
  );
}

export function FilesApp({ chatServiceUrl, onLoad }: { chatServiceUrl: string; onLoad?: (outcome: 'ready' | 'failed') => void }) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (error !== null) onLoad?.('failed');
    else if (files !== null) onLoad?.('ready');
  }, [files, error, onLoad]);

  const latestListing = useRef(0);
  const settle = useCallback(
    (request: Promise<void>) => {
      request.then(async () => {
        const listing = ++latestListing.current;
        const files = await listFiles({ chatServiceUrl });
        if (listing === latestListing.current) setFiles(files);
      }).catch((cause: Error) => setError(cause.message));
    },
    [chatServiceUrl],
  );
  const run = (request: () => Promise<void>) => {
    setError(null);
    settle(request());
  };
  // A name Files already holds is refused, so that rename waits for the answer.
  const rename = (from: string, to: string): string | null => {
    const was = files?.find((file) => file.name === from);
    if (was === undefined || files?.some((file) => file.name === to)) {
      run(() => renameFile(from, to, { chatServiceUrl }));
      return null;
    }
    const moved = { ...was, name: to };
    const swap = (out: FileEntry, into: FileEntry) => (listed: FileEntry[] | null) => listed && listed.map((file) => (file === out ? into : file));
    latestListing.current++;
    setFiles(swap(was, moved));
    run(() => renameFile(from, to, { chatServiceUrl }).catch((cause: unknown) => {
      setFiles(swap(moved, was));
      settle(Promise.resolve());
      throw cause;
    }));
    return to;
  };
  // A delete shows at once, as the rename does; a refused one brings the file back and reloads the listing.
  const remove = (name: string) => {
    const was = files?.find((file) => file.name === name);
    latestListing.current++;
    if (was !== undefined) setFiles((listed) => listed && listed.filter((file) => file !== was));
    const answered = deleteFile(name, { chatServiceUrl }).catch((cause: unknown) => {
      if (was !== undefined) setFiles((listed) => listed && [...listed, was]);
      settle(Promise.resolve());
      throw cause;
    });
    run(() => answered);
    return answered;
  };

  useEffect(() => settle(Promise.resolve()), [settle]);
  const thumbnailUrl = useCallback((path: string) => fileDownloadUrl(path, { chatServiceUrl }), [chatServiceUrl]);

  return (
    <FilesWindow
      files={files}
      error={error}
      onDownload={(name) => {
        setError(null);
        void fileDownloadUrl(name, { chatServiceUrl }).then(
          (url) => window.location.assign(url),
          (cause: Error) => setError(cause.message),
        );
      }}
      onDelete={remove}
      onRename={(path, name) => {
        // The new name stays in the file's folder; the Chat Service refuses an empty name, `.` and `..`.
        if (!name.includes('/')) return rename(path, `${path.slice(0, path.lastIndexOf('/') + 1)}${name}`);
        setError('A file name can’t contain “/”.');
        return null;
      }}
      onReload={() => run(async () => undefined)}
      thumbnailUrl={thumbnailUrl}
    />
  );
}

function FileMenu({ row, actions, onOpen, children, container }: {
  row: FilesItem;
  container: RefObject<HTMLElement | null>;
  actions: { label: string; act: (at: { row: FilesItem; opener: HTMLElement }) => void }[];
  onOpen: () => void;
  children: ReactElement;
}) {
  const opener = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(true);
  const firstItem = useRef<HTMLButtonElement>(null);
  const keyboard = useRef(false);
  const menuActions = useRef<ContextMenu.Root.Actions | null>(null);
  if (row.folder) return children;
  return (
    <ContextMenu.Root actionsRef={menuActions} onOpenChange={(open) => { if (open) { restoreFocus.current = true; onOpen(); } }}>
      <ContextMenu.Trigger ref={opener} className="agent-computer-file-trigger" tabIndex={-1} onKeyDown={(event) => { keyboard.current = contextMenuKey(event); }}>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="standard-popup-positioner" collisionBoundary={container.current ?? undefined}>
          <ContextMenu.Popup onKeyDown={(event) => { if (event.key === "Tab") menuActions.current?.close(); }} className="agent-computer-files-menu standard-popup" aria-label={row.name} onFocus={(event) => { if (keyboard.current && event.target === event.currentTarget) { keyboard.current = false; firstItem.current?.focus(); } }} finalFocus={() => restoreFocus.current ? opener.current?.querySelector("button, input") ?? opener.current : false}>
            {actions.map(({ label, act }, index) => (
              <ContextMenu.Item key={label} ref={index === 0 ? firstItem : undefined} nativeButton render={<button type="button" />} onClick={() => {
                if (opener.current === null) throw new Error("The file menu has no opener");
                restoreFocus.current = label === "Download";
                act({ row, opener: opener.current.querySelector<HTMLElement>(".agent-computer-file") ?? opener.current });
              }}>{label}</ContextMenu.Item>
            ))}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
