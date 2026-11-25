"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { besideOf, filesPath, nameOf } from '../app/files-path';
import { FilesWindow } from './files-explorer';
import { deleteFile, fileDownloadUrl, listFiles, moveIntoFolder, renameFile, uploadInto, type FileEntry } from './files-service';

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
        if (!name.includes('/')) return rename(path, nameOf(besideOf(filesPath(path), name)));
        setError('A file name can’t contain “/”.');
        return null;
      }}
      onMove={(path, folder) => run(async () => { await moveIntoFolder(path, folder, { chatServiceUrl }); })}
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
