'use client';

import { useContext, useEffect, useRef, useState, type MouseEvent } from 'react';
import { attachmentAccountEpoch } from '../cartridge/file-account';
import { agentFiles } from './agent-files';
import { reason } from './composer-files';
import { ReplyTurnRunning } from './reply-turn';

type FileAttempt = { path: string } & (
  | { status: 'ready'; url: string; recoverAfterTurn: boolean }
  | { status: 'error'; reason: string; recoverAfterTurn: boolean }
  | { status: 'refreshing'; reason: string }
);

/**
 * Each path's last settled attempt, for this page and account: Main Chat's kept copy and then the live chat each mount
 * a reply's file link, and one that started at "(loading)" again changed its reply's height as it resolved. A
 * link mounts showing it, and still asks again. An attempt is kept under the account epoch it was asked in, which
 * every account change rotates (`withUploadsSettled`), so another account never sees its URL.
 */
const settled = new Map<string, { epoch: string | null; attempt: FileAttempt }>();
/** The account epoch, null before the page's first account change; undefined when storage fails, which keeps nothing. */
function accountEpoch(): string | null | undefined {
  try {
    return attachmentAccountEpoch();
  } catch {
    return undefined;
  }
}
const lastSettled = (path: string) => {
  const kept = settled.get(path);
  const epoch = accountEpoch();
  return kept !== undefined && epoch !== undefined && kept.epoch === epoch ? kept.attempt : null;
};
function remember(epoch: string | null | undefined, attempt: FileAttempt) {
  if (epoch !== undefined) settled.set(attempt.path, { epoch, attempt });
}

function ask(path: string, recoverAfterTurn: boolean, setFile: (attempt: FileAttempt) => void) {
  let current = true;
  const epoch = accountEpoch();
  const settle = (attempt: FileAttempt) => {
    remember(epoch, attempt);
    if (current) setFile(attempt);
  };
  agentFiles.url(path).then(
    (url) => settle({ path, status: 'ready', url, recoverAfterTurn }),
    (error: unknown) => settle({ path, status: 'error', reason: reason(error), recoverAfterTurn }),
  );
  return () => {
    current = false;
  };
}

export function useReplyFile(path: string | null) {
  const running = useContext(ReplyTurnRunning);
  const runningNow = useRef(running);
  runningNow.current = running;
  const [file, setFile] = useState<FileAttempt | null>(() => (path ? lastSettled(path) : null));

  useEffect(() => {
    if (!path) return;
    setFile(lastSettled(path));
    return ask(path, runningNow.current, setFile);
  }, [path]);

  useEffect(() => {
    if (
      !running &&
      file?.path === path &&
      file.status === 'error' &&
      file.recoverAfterTurn
    ) {
      setFile({ path: file.path, status: 'refreshing', reason: file.reason });
    }
  }, [running, file, path]);

  useEffect(() => {
    if (file?.status !== 'refreshing' || !path || file.path !== path) return;
    return ask(path, false, setFile);
  }, [path, file]);

  const imageFailed = () =>
    setFile((shown) =>
      shown?.status === 'ready' && shown.path === path
        ? {
            path: shown.path,
            status: 'error',
            reason: 'the browser could not show it',
            recoverAfterTurn: shown.recoverAfterTurn,
          }
        : shown
    );
  const [downloadError, setDownloadError] = useState<{ path: string; reason: string } | null>(null);
  const shown = file?.path === path ? file : null;
  const download = (event: MouseEvent) => {
    event.preventDefault();
    if (!path) return;
    setDownloadError(null);
    void agentFiles
      .url(path)
      .then((url) => window.location.assign(url))
      .catch((error: unknown) => setDownloadError({ path, reason: reason(error) }));
  };
  const unavailable = shown !== null && shown.status !== 'ready' ? shown.reason : null;
  const downloadFailure = downloadError?.path === path ? downloadError.reason : unavailable;
  return { file: shown, imageFailed, download, downloadFailure, unavailable };
}
