'use client';

import { ChevronLeft, ChevronRight, Clock, Folder } from 'lucide-react';
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { failureDetail } from './failure-detail';
import { attachmentAccountEpoch, FILE_ACCOUNT_LOCK, invalidateAttachmentAccount } from 'botcube-ui-web/cartridge';

/** A file in the account's Files, by its path inside them. */
export interface FileEntry {
  name: string;
  size: number;
  lastModified: string;
}

interface ChatServiceOptions {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}

async function chatService(
  path: string,
  init: RequestInit,
  fallback: string,
  { chatServiceUrl, fetchImpl = fetch }: ChatServiceOptions,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(new URL(path, chatServiceUrl).toString(), { ...init, credentials: 'include' });
  if (!response.ok) throw new Error(await failureDetail(response, fallback));
  if (response.status === 204) return {};
  return (await response.json()) as Record<string, unknown>;
}

/** The account's Files. */
export async function listFiles(options: ChatServiceOptions): Promise<FileEntry[]> {
  return (await chatService('/files', { method: 'GET' }, 'Files request failed', options)).files as FileEntry[];
}

/** A short-lived URL that downloads one file. */
export async function fileDownloadUrl(name: string, options: ChatServiceOptions): Promise<string> {
  const path = `/files/download-url?${new URLSearchParams({ name })}`;
  return (await chatService(path, { method: 'GET' }, 'Download failed', options)).url as string;
}

/** Delete a file from Files, every stored version of it. */
export async function deleteFile(name: string, options: ChatServiceOptions): Promise<void> {
  await chatService(`/files?${new URLSearchParams({ name })}`, { method: 'DELETE' }, 'Delete failed', options);
}

/** Give a file another path in Files; the Chat Service never overwrites one already there. */
export async function renameFile(from: string, to: string, options: ChatServiceOptions): Promise<void> {
  await chatService(
    '/files/rename',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to }) },
    'Rename failed',
    options,
  );
}

class UploadHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** A presigned URL that uploads `name` as a new file; the Chat Service refuses a name Files already holds. */
async function newUploadUrl(name: string, signal: AbortSignal, { chatServiceUrl, fetchImpl = fetch }: ChatServiceOptions): Promise<string> {
  const response = await fetchImpl(new URL('/files/upload-url', chatServiceUrl).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
    credentials: 'include',
    signal,
  });
  if (!response.ok) throw new UploadHttpError(response.status, await failureDetail(response, 'Upload failed'));
  return ((await response.json()) as { url: string }).url;
}

export interface UploadOptions {
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}

/** PUTs `file` to a presigned URL as a new object, reporting the fraction sent; XHR, as fetch reports no upload progress. */
function putFile(url: string, file: File, { onProgress, signal }: UploadOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('If-None-Match', '*');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new UploadHttpError(request.status, `Upload failed: ${request.status}`)));
    request.onerror = () => reject(new Error('Upload failed: network error'));
    request.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));
    signal.addEventListener('abort', () => request.abort(), { once: true });
    request.send(file);
  });
}

const pendingUploads = new Set<Promise<string>>();
let changingAccount = false;

export async function withUploadsSettled<T>(change: () => Promise<T>): Promise<T> {
  if (changingAccount) throw new Error('An account change is already in progress');
  changingAccount = true;
  try {
    await Promise.all([...pendingUploads]);
    return await navigator.locks.request(FILE_ACCOUNT_LOCK, async () => {
      invalidateAttachmentAccount();
      return await change();
    });
  } finally {
    changingAccount = false;
  }
}

function uploadCopyName(name: string, copy: number): string {
  const dot = name.lastIndexOf('.');
  const extension = [...(dot > 0 ? name.slice(dot) : '')];
  const stem = [...(dot > 0 ? name.slice(0, dot) : name)];
  const encoder = new TextEncoder();
  while (extension.length > 0 && encoder.encode(`${stem[0] ?? ''} (${copy})${extension.join('')}`).length > 255) extension.pop();
  const suffix = ` (${copy})${extension.join('')}`;
  while (stem.length > 1 && encoder.encode(`${stem.join('')}${suffix}`).length > 255) stem.pop();
  return `${stem.join('')}${suffix}`;
}

async function uploadAvailableFile(file: File, options: UploadOptions, service: ChatServiceOptions, copy = 1): Promise<string> {
  options.signal.throwIfAborted();
  const name = copy === 1 ? file.name : uploadCopyName(file.name, copy);
  let url: string;
  try {
    url = await newUploadUrl(name, options.signal, service);
  } catch (error) {
    if (error instanceof UploadHttpError && error.status === 409 && error.message === `A file named ${name} is already in Files`) {
      return uploadAvailableFile(file, options, service, copy + 1);
    }
    throw error;
  }
  options.signal.throwIfAborted();
  try {
    await putFile(url, file, options);
  } catch (error) {
    if (error instanceof UploadHttpError && error.status === 412) return uploadAvailableFile(file, options, service, copy + 1);
    throw error;
  }
  return `/${name}`;
}

export async function uploadFile(file: File, options: UploadOptions, service: ChatServiceOptions): Promise<string> {
  if (changingAccount) return Promise.reject(new Error('Uploads are paused while your account changes. Retry after sign-in.'));
  const epoch = attachmentAccountEpoch();
  const pending = navigator.locks.request(FILE_ACCOUNT_LOCK, { mode: 'shared' }, async () => {
    if (epoch !== attachmentAccountEpoch()) throw new Error('Your account changed while this upload waited. Attach the file again.');
    return uploadAvailableFile(file, options, service);
  }).then((path) => path).finally(() => pendingUploads.delete(pending));
  pendingUploads.add(pending);
  return pending;
}

/** An item of the open folder: a file, or a folder holding files further down. */
interface FilesItem {
  name: string;
  /** The file's path, or the folder's path with its trailing slash. */
  path: string;
  folder: boolean;
}

/** The items inside a folder ('' for the top, else its path with a trailing slash), in name order as Finder sorts them. */
function itemsIn(files: readonly FileEntry[], folder: string): FilesItem[] {
  // Keyed by path, so a file and a folder of the same name, which storage allows, both stay listed.
  const items = new Map<string, FilesItem>();
  for (const file of files) {
    if (!file.name.startsWith(folder)) continue;
    const [name = '', ...below] = file.name.slice(folder.length).split('/');
    const path = below.length === 0 ? file.name : `${folder}${name}/`;
    items.set(path, { name, path, folder: below.length > 0 });
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
    .map(({ name }) => ({ name: name.slice(name.lastIndexOf('/') + 1), path: name, folder: false }));
}

/** A light blue folder with its tab, as the dock's Files icon draws it. */
export const FOLDER_ICON = (
  <>
    <path d="M2 9a3 3 0 0 1 3-3h7l3 3h12a3 3 0 0 1 3 3v2H2z" fill="#38bdf8" />
    <rect x="2" y="11" width="28" height="17" rx="3" fill="#7dd3fc" />
  </>
);

/** The gradient a folder's front takes, drawn once in the window. */
const FOLDER_FRONT = 'agent-computer-folder-front';

/** A white page with its corner folded, as Finder draws a document. */
const PAGE = (
  <>
    <path d="M4 2h26l12 12v38a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#ffffff" stroke="#c4c4c9" strokeWidth="1.5" />
    <path d="M30 2v10a2 2 0 0 0 2 2h10" fill="#ececef" stroke="#c4c4c9" strokeWidth="1.5" />
  </>
);

/** Each kind of item as Finder draws it: a big blue folder, or a page that is blank, ruled with text, or a green grid. */
const ICONS = {
  folder: {
    viewBox: '0 0 64 52',
    shapes: (
      <>
        <path d="M2 8a5 5 0 0 1 5-5h16l5 5h29a5 5 0 0 1 5 5v2H2z" fill="#4fa9ec" />
        <path d="M2 14h60v33a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill={`url(#${FOLDER_FRONT})`} />
      </>
    ),
  },
  spreadsheet: {
    viewBox: '0 0 44 56',
    shapes: (
      <>
        {PAGE}
        <path d="M10 24h24v18H10zM10 30h24M10 36h24M18 24v18M26 24v18" fill="none" stroke="#2e9e4f" strokeWidth="1.5" />
      </>
    ),
  },
  text: {
    viewBox: '0 0 44 56',
    shapes: (
      <>
        {PAGE}
        <path d="M10 24h24M10 30h24M10 36h24M10 42h16" stroke="#9a9aa0" strokeWidth="2" />
      </>
    ),
  },
  document: { viewBox: '0 0 44 56', shapes: PAGE },
};

/** Files whose kind has its own icon, by extension; any other file is a plain document. */
const KINDS: Record<string, keyof typeof ICONS> = { csv: 'spreadsheet', xlsx: 'spreadsheet', md: 'text', pdf: 'text', txt: 'text' };

/** An item's kind, as its icon shows it. */
function kindOf({ name, folder }: FilesItem): keyof typeof ICONS {
  if (folder) return 'folder';
  const dot = name.lastIndexOf('.');
  // A name without an extension, or a dotfile, is a plain document.
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  return (Object.hasOwn(KINDS, extension) ? KINDS[extension] : undefined) ?? 'document';
}

function ItemIcon({ item }: { item: FilesItem }) {
  const { viewBox, shapes } = ICONS[kindOf(item)];
  return <svg viewBox={viewBox} aria-hidden="true">{shapes}</svg>;
}

/** A name's last characters, kept whole while its start gives way to an ellipsis, as Finder cuts a name: `rates…cap.md`. */
const TAIL = 6;

/** A name wrapping to two lines at most under its icon, as Finder sets it; a longer one is cut in its middle to fit them. */
function FileName({ name }: { name: string }) {
  const view = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const span = view.current;
    if (span === null) return;
    const fits = (text: string) => {
      span.textContent = text;
      return span.scrollHeight <= span.clientHeight;
    };
    const fit = () => {
      if (fits(name) || name.length <= TAIL) return;
      // The most of the start that fits before the ellipsis, found by halving.
      let [low, high] = [0, name.length - TAIL - 1];
      while (low < high) {
        const head = Math.ceil((low + high) / 2);
        if (fits(`${name.slice(0, head)}…${name.slice(-TAIL)}`)) low = head;
        else high = head - 1;
      }
      span.textContent = `${name.slice(0, low)}…${name.slice(-TAIL)}`;
    };
    fit();
    // Measured again as the cell's box changes, as when the page's font loads.
    const observer = new ResizeObserver(fit);
    if (span.parentElement !== null) observer.observe(span.parentElement);
    return () => observer.disconnect();
  }, [name]);
  return <span ref={view} className="agent-computer-file-name" />;
}

/** Arrow keys move through a menu's items, Enter picks one, Escape closes it back to its opener, and Tab leaves it. */
function menuKeys(event: KeyboardEvent<HTMLDivElement>, close: () => void, opener: HTMLElement) {
  const buttons = [...event.currentTarget.querySelectorAll('button')];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    buttons[(at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  } else if (event.key === 'Enter') {
    buttons[at]?.click();
  } else if (event.key === 'Escape') {
    // The menu's Escape is spent on it: the phone's Agent Profile around Files closes on an Escape that reaches it.
    event.stopPropagation();
    close();
    opener.focus();
  } else {
    // Tab moves focus on out of the menu, which closes behind it.
    if (event.key === 'Tab') close();
    return;
  }
  event.preventDefault();
}

/** An open menu takes focus on its first item, and a pointer down outside it closes it. */
function useMenu(open: unknown, view: RefObject<HTMLDivElement | null>, close: () => void) {
  const closing = useRef(close);
  closing.current = close;
  useEffect(() => {
    if (open === null) return undefined;
    view.current?.querySelector('button')?.focus();
    const outside = ({ target }: Event) => {
      if (!view.current?.contains(target as Node)) closing.current();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, view]);
}

/** Where Files is: a folder ('' for workspace, the top, else its path with a trailing slash), or Recents (null). */
type Place = string | null;

/**
 * The Files window, as Finder draws it: a floating sidebar of Recents, workspace and workspace's own folders; a toolbar
 * of Back and Forward and the open place's name; its files and folders in icon view; and its path along the bottom. A
 * click selects an item and a double-click (or Enter) opens it; a right-click (a long-press on a phone, or the
 * context-menu key) opens a file's menu of Download, Rename and Delete. The listing reloads as a place opens.
 */
export function FilesWindow({
  files,
  error,
  onDownload,
  onDelete,
  onRename,
  onReload,
}: {
  /** Null until the Chat Service has answered. */
  files: readonly FileEntry[] | null;
  error: string | null;
  onDownload: (name: string) => void;
  onDelete: (name: string) => void;
  /** A file's path, and the new name it takes in its folder. */
  onRename: (path: string, name: string) => void;
  /** Reload the listing. */
  onReload: () => void;
}) {
  // The open place, and the places Back and Forward return to, nearest last and first.
  const [visits, setVisits] = useState<{ back: Place[]; place: Place; forward: Place[] }>({ back: [], place: '', forward: [] });
  const { back, place, forward } = visits;
  // The selected item's path: Finder highlights it until another is chosen.
  const [selected, setSelected] = useState<string | null>(null);
  const items = files === null ? [] : place === null ? recentsIn(files) : itemsIn(files, place);
  const trail = place === null ? [] : place.split('/').slice(0, -1);
  // The path bar's folders, from workspace down to the open one, with the path each opens.
  const crumbs = [{ name: 'workspace', path: '' }, ...trail.map((name, index) => ({ name, path: `${trail.slice(0, index + 1).join('/')}/` }))];
  // The sidebar's folders: workspace, then its own folders as the listing has them.
  const places = [{ name: 'workspace', path: '' }, ...(files === null ? [] : itemsIn(files, '').filter(({ folder }) => folder))];
  // Opening a place reloads the listing, so it shows what the agent has saved since.
  const visit = (next: typeof visits) => {
    setVisits(next);
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
  const open = (item: FilesItem) => (item.folder ? go(item.path) : onDownload(item.path));
  const view = useRef<HTMLDivElement>(null);
  // A file's menu, at where it opened inside the window, and the file's button that focus returns to.
  const [menu, setMenu] = useState<{ row: FilesItem; opener: HTMLButtonElement; x: number; y: number } | null>(null);
  const menuView = useRef<HTMLDivElement>(null);
  useMenu(menu, menuView, () => setMenu(null));
  useLayoutEffect(() => {
    const own = menuView.current;
    const frame = view.current;
    if (menu === null || own === null || frame === null) return;
    // A menu that would run past the window opens up or left of where it was asked for, as macOS keeps one in view.
    const fit = (at: number, size: number, room: number) => (at + size <= room ? at : Math.max(0, at - size));
    own.style.left = `${fit(menu.x, own.offsetWidth, frame.clientWidth)}px`;
    own.style.top = `${fit(menu.y, own.offsetHeight, frame.clientHeight)}px`;
  }, [menu]);
  // The file whose Delete waits on the sheet's confirmation, and its button that focus returns to.
  const [deleting, setDeleting] = useState<{ row: FilesItem; opener: HTMLButtonElement } | null>(null);
  const closeSheet = () => {
    setDeleting(null);
    deleting?.opener.focus();
  };
  // The file whose name is being edited under its icon, and whether that edit has ended: Enter's commit or Escape's
  // cancel unmounts the field, and the blur that follows must not commit again.
  const [renaming, setRenaming] = useState<FilesItem | null>(null);
  const renameEnded = useRef(false);
  const nameField = useRef<HTMLInputElement>(null);
  const endRename = (name: string | null) => {
    if (renaming === null || renameEnded.current) return;
    renameEnded.current = true;
    setRenaming(null);
    if (name !== null && name !== renaming.name) onRename(renaming.path, name);
  };
  const menuItems: { label: string; act: (at: { row: FilesItem; opener: HTMLButtonElement }) => void }[] = [
    { label: 'Download', act: ({ row }) => onDownload(row.path) },
    {
      label: 'Rename',
      act: ({ row }) => {
        renameEnded.current = false;
        setRenaming(row);
      },
    },
    { label: 'Delete', act: ({ row, opener }) => setDeleting({ row, opener }) },
  ];
  const openMenu = (row: FilesItem, opener: HTMLButtonElement, x: number, y: number) => {
    const box = view.current?.getBoundingClientRect();
    setSelected(row.path);
    setMenu({ row, opener, x: x - (box?.left ?? 0), y: y - (box?.top ?? 0) });
  };
  useEffect(() => {
    // As in Finder, the name is selected up to its extension.
    const dot = renaming?.name.lastIndexOf('.') ?? -1;
    nameField.current?.focus();
    nameField.current?.setSelectionRange(0, dot > 0 ? dot : (renaming?.name.length ?? 0));
  }, [renaming]);
  return (
    <div ref={view} className="agent-computer-files" aria-label="Files">
      <svg className="agent-computer-files-defs" aria-hidden="true">
        <linearGradient id={FOLDER_FRONT} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8fd0ff" />
          <stop offset="1" stopColor="#5ab4f1" />
        </linearGradient>
      </svg>
      <nav className="agent-computer-files-sidebar" aria-label="Sidebar">
        <button type="button" aria-current={place === null ? 'true' : undefined} onClick={() => go(null)}>
          <Clock aria-hidden="true" />
          <span>Recents</span>
        </button>
        <p>Files</p>
        {places.map(({ name, path }) => (
          <button key={path} type="button" aria-current={place === path ? 'true' : undefined} onClick={() => go(path)}>
            <Folder aria-hidden="true" />
            <span>{name}</span>
          </button>
        ))}
      </nav>
      <div className="agent-computer-files-main">
        <div className="agent-computer-files-toolbar">
          <span className="agent-computer-files-history">
            <button type="button" aria-label="Back" title="Back" disabled={back.length === 0} onClick={goBack}>
              <ChevronLeft aria-hidden="true" />
            </button>
            <button type="button" aria-label="Forward" title="Forward" disabled={forward.length === 0} onClick={goForward}>
              <ChevronRight aria-hidden="true" />
            </button>
          </span>
          <h2 className="agent-computer-files-title">{place === null ? 'Recents' : (trail.at(-1) ?? 'workspace')}</h2>
        </div>
        {deleting && (
          <div
            className="agent-computer-files-sheet"
            role="alertdialog"
            aria-label="Delete file"
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              closeSheet();
            }}
          >
            <p>{`Delete “${deleting.row.name}”? This can't be undone.`}</p>
            {/* The sheet takes focus on its safe choice, and gives it back to the file as it closes. */}
            <button type="button" autoFocus onClick={closeSheet}>Cancel</button>
            <button
              type="button"
              className="agent-computer-files-delete"
              onClick={() => {
                closeSheet();
                onDelete(deleting.row.path);
              }}
            >
              Delete
            </button>
          </div>
        )}
        {error && <p className="agent-computer-error" role="alert">{error}</p>}
        {files !== null && files.length === 0 && (
          <p className="agent-computer-files-empty">No files yet. Files the agent downloads appear here within a minute or two.</p>
        )}
        <div className="agent-computer-files-grid" role="listbox" aria-label={place === null ? 'Recents' : 'Folder contents'}>
          {items.map((item) => item.path === renaming?.path ? (
            <div key={item.path} role="option" aria-selected={item.path === selected} className="agent-computer-file" data-kind={kindOf(item)}>
              <ItemIcon item={item} />
              <input
                ref={nameField}
                className="agent-computer-file-rename"
                aria-label={`Rename ${item.name}`}
                defaultValue={item.name}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') endRename(event.currentTarget.value);
                  else if (event.key === 'Escape') {
                    event.stopPropagation();
                    endRename(null);
                  }
                }}
                onBlur={(event) => endRename(event.currentTarget.value)}
              />
            </div>
          ) : (
            <button
              key={item.path}
              type="button"
              role="option"
              aria-selected={item.path === selected}
              className="agent-computer-file"
              data-kind={kindOf(item)}
              // The name may show cut short: the item is named, and its tooltip shows, in full.
              aria-label={item.name}
              title={item.name}
              // Enter, a click with no pointer behind it, opens; a pointer's click selects.
              onClick={(event) => (event.detail === 0 ? open(item) : setSelected(item.path))}
              onDoubleClick={() => open(item)}
              // A right-click, or a long-press in WebKit on iOS; a folder keeps the browser's own menu.
              onContextMenu={(event) => {
                if (item.folder) return;
                event.preventDefault();
                openMenu(item, event.currentTarget, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (item.folder || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                openMenu(item, event.currentTarget, box.left, box.bottom);
              }}
            >
              <ItemIcon item={item} />
              <FileName name={item.name} />
            </button>
          ))}
        </div>
        <nav className="agent-computer-files-path" aria-label="Path">
          {place === null ? (
            <>
              <Clock aria-hidden="true" />
              <span>Recents</span>
            </>
          ) : (
            <>
              <Folder aria-hidden="true" />
              {crumbs.map(({ name, path }, index) => (
                <Fragment key={path}>
                  {index > 0 && <span aria-hidden="true">›</span>}
                  <button type="button" aria-current={path === place ? 'true' : undefined} onClick={() => go(path)}>{name}</button>
                </Fragment>
              ))}
            </>
          )}
        </nav>
      </div>
      {menu && (
        <div
          ref={menuView}
          className="agent-computer-files-menu"
          role="menu"
          aria-label={menu.row.name}
          onKeyDown={(event) => menuKeys(event, () => setMenu(null), menu.opener)}
        >
          {menuItems.map(({ label, act }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                // Focus leaves the menu for the file, unless what the item opens takes it.
                menu.opener.focus();
                act(menu);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The Files app: the account's Files, shared by every chat's Agent Computer. */
export function FilesApp({ chatServiceUrl }: { chatServiceUrl: string }) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settle = useCallback(
    (request: Promise<void>) => {
      request.then(async () => setFiles(await listFiles({ chatServiceUrl }))).catch((cause: Error) => setError(cause.message));
    },
    [chatServiceUrl],
  );
  const run = (request: () => Promise<void>) => {
    setError(null);
    settle(request());
  };

  useEffect(() => settle(Promise.resolve()), [settle]);

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
      onDelete={(name) => run(() => deleteFile(name, { chatServiceUrl }))}
      onRename={(path, name) => {
        // The new name stays in the file's folder; the Chat Service refuses an empty name, `.` and `..`.
        if (name.includes('/')) setError('A file name can’t contain “/”.');
        else run(() => renameFile(path, `${path.slice(0, path.lastIndexOf('/') + 1)}${name}`, { chatServiceUrl }));
      }}
      onReload={() => run(async () => undefined)}
    />
  );
}
