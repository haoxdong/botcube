'use client';

import { useContext, useEffect, useRef, useState } from 'react';
import { agentFiles } from './agent-files';
import { ReplyTurnRunning } from './reply-turn';

type FileAttempt = { path: string } & (
  | { status: 'ready'; url: string; recoverAfterTurn: boolean }
  | { status: 'error'; reason: string; recoverAfterTurn: boolean }
  | { status: 'refreshing'; reason: string }
);

export function useReplyFile(path: string | null) {
  const running = useContext(ReplyTurnRunning);
  const runningNow = useRef(running);
  runningNow.current = running;
  const [file, setFile] = useState<FileAttempt | null>(null);

  useEffect(() => {
    if (!path) return;
    let current = true;
    const recoverAfterTurn = runningNow.current;
    setFile(null);
    agentFiles.url(path).then(
      (url) =>
        current && setFile({ path, status: 'ready', url, recoverAfterTurn }),
      (error: unknown) =>
        current &&
        setFile({
          path,
          status: 'error',
          reason: error instanceof Error ? error.message : String(error),
          recoverAfterTurn,
        })
    );
    return () => {
      current = false;
    };
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
    let current = true;
    agentFiles.url(path).then(
      (url) =>
        current &&
        setFile({ path, status: 'ready', url, recoverAfterTurn: false }),
      (error: unknown) =>
        current &&
        setFile({
          path,
          status: 'error',
          reason: error instanceof Error ? error.message : String(error),
          recoverAfterTurn: false,
        })
    );
    return () => {
      current = false;
    };
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
  return { file: file?.path === path ? file : null, imageFailed };
}
