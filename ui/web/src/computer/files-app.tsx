"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { besideOf, filesPath, nameOf } from '../app/files-path';
import { FilesWindow } from './files-explorer';
import { itemsIn } from './files-items';
import {
  copyIntoFolder, deleteFile, fileDownloadUrl, listFolders, makeFolder, moveIntoFolder, renameFile, uploadCopyName, uploadInto, type FileEntry, type FolderEntry,
} from './files-service';

/** The name Windows gives a new folder: `New folder`, or the first `New folder (2)` the folder doesn't hold. */
function newFolderName(taken: ReadonlySet<string>): string {
  let copy = 1;
  const named = () => (copy === 1 ? 'New folder' : uploadCopyName('New folder', copy));
  while (taken.has(named())) copy += 1;
  return named();
}

/** A path moved from one folder to another, or itself when it is not in `from`. */
const moved = (path: string, from: string, to: string) => (path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path);

export function FilesApp({ chatServiceUrl, onLoad }: { chatServiceUrl: string; onLoad?: (outcome: 'ready' | 'failed') => void }) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  // The last folder made, which a rename of it waits for.
  const making = useRef<Promise<unknown>>(Promise.resolve());
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
        const { files, folders } = await listFolders({ chatServiceUrl });
        if (listing !== latestListing.current) return;
        setFiles(files);
        setFolders(folders);
      }).catch((cause: Error) => setError(cause.message));
    },
    [chatServiceUrl],
  );
  const run = (request: () => Promise<void>) => {
    setError(null);
    settle(request());
  };
  /** Runs a move or copy, answering the path it took. */
  const taking = (put: Promise<string>) => {
    run(async () => { await put; });
    return put;
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
  // A folder's rename shows at once, with everything in it; a refused one reloads the listing.
  const renameFolder = (from: string, to: string): string => {
    latestListing.current++;
    setFolders((listed) => listed.map((folder) => ({ ...folder, name: moved(folder.name, from, to) })));
    setFiles((listed) => listed && listed.map((file) => ({ ...file, name: moved(file.name, from, to) })));
    run(() => making.current.then(() => renameFile(from, to, { chatServiceUrl })).catch((cause: unknown) => {
      settle(Promise.resolve());
      throw cause;
    }));
    return `${to}/`;
  };
  // A new folder shows at once, as the next free `New folder` in its folder.
  const newFolder = (place: string): string => {
    const name = `${place}${newFolderName(new Set(itemsIn(files ?? [], place, folders).map((item) => item.name)))}`;
    latestListing.current++;
    setFolders((listed) => [...listed, { name, lastModified: new Date().toISOString() }]);
    const made = makeFolder(name, { chatServiceUrl });
    making.current = made.catch(() => undefined);
    run(() => made.catch((cause: unknown) => {
      settle(Promise.resolve());
      throw cause;
    }));
    return `${name}/`;
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
      folders={folders}
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
        // The new name stays in the item's folder; the Chat Service refuses an empty name, `.` and `..`.
        if (!name.includes('/') && path.endsWith('/')) return renameFolder(path.slice(0, -1), nameOf(besideOf(filesPath(path.slice(0, -1)), name)));
        if (!name.includes('/')) return rename(path, nameOf(besideOf(filesPath(path), name)));
        setError('A file name can’t contain “/”.');
        return null;
      }}
      onMove={(path, folder) => taking(moveIntoFolder(path, folder, { chatServiceUrl }))}
      onCopy={(path, folder) => taking(copyIntoFolder(path, folder, { chatServiceUrl }))}
      onNewFolder={newFolder}
      onReload={() => run(async () => undefined)}
      onUpload={(file, options, folder) => {
        const uploaded = uploadInto(file, options, folder, { chatServiceUrl });
        // A cancelled upload says nothing; a refused one says why, and the listing reloads either way.
        settle(uploaded.then(() => undefined, (cause: unknown) => {
          if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : String(cause));
        }));
        return uploaded;
      }}
      thumbnailUrl={thumbnailUrl}
    />
  );
}
