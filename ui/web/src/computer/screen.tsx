"use client";

import React, { useEffect, useState, type ReactNode } from 'react';
import { Arrives } from '../app/motion';

import { ComputerAsleep, screenFrame } from './screenshots';

/** How long the screen waits after a frame before it asks for the next. */
const FRAME_MS = 1000;

/**
 * The Agent Computer's screen in a browser window's frame: each frame from `url` while it is set, else `cover`.
 * A computer that sleeps under it calls `onAsleep`; any other failure calls `onError` and stops asking.
 */
export function Screen({
  url,
  title,
  cover,
  actions,
  onAsleep,
  onFrame,
  onError,
}: {
  url: string | null;
  title: string;
  cover?: ReactNode;
  /** Controls at the end of the window's title bar. */
  actions?: ReactNode;
  onAsleep: () => void;
  onFrame?: () => void;
  onError: (message: string) => void;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  useEffect(() => {
    if (url === null) return undefined;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown: string | null = null;
    const next = () => {
      screenFrame(url, abort.signal).then(
        (image) => {
          if (shown !== null) URL.revokeObjectURL(shown);
          shown = image;
          setFrame(image);
          onFrame?.();
          timer = setTimeout(next, FRAME_MS);
        },
        (cause: Error) => {
          if (abort.signal.aborted) return;
          if (cause instanceof ComputerAsleep) onAsleep();
          else onError(cause.message);
        },
      );
    };
    next();
    return () => {
      abort.abort();
      clearTimeout(timer);
      if (shown !== null) URL.revokeObjectURL(shown);
      setFrame(null);
    };
    // Stryker disable next-line ArrayDeclaration: the callbacks are fresh closures each render; `url` names the screen
  }, [url]);

  const live = url !== null && frame !== null;
  return (
    <figure className="computer-screen" data-live={live || undefined}>
      <figcaption className="computer-screen-bar">
        <span className="computer-screen-lights" aria-hidden="true"><i /><i /><i /></span>
        <span className="computer-screen-title">{title}</span>
        {actions}
      </figcaption>
      <div className="computer-screen-glass">
        <Arrives state={live ? 'live' : 'cover'} className="computer-screen-face">
          {live ? <img className="computer-screen-image" src={frame} alt={`${title}'s screen`} /> : cover}
        </Arrives>
      </div>
    </figure>
  );
}
