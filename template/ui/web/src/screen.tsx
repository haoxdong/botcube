"use client";

import React, { useEffect, useState, type ReactNode } from 'react';

import { ComputerAsleep, screenFrame } from './computer';

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
  onError,
}: {
  url: string | null;
  title: string;
  cover?: ReactNode;
  /** Controls at the end of the window's title bar. */
  actions?: ReactNode;
  onAsleep: () => void;
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
    <figure className="template-screen" data-live={live || undefined}>
      <figcaption className="template-screen-bar">
        <span className="template-screen-lights" aria-hidden="true"><i /><i /><i /></span>
        <span className="template-screen-title">{title}</span>
        {actions}
      </figcaption>
      <div className="template-screen-glass">
        {live ? <img className="template-screen-image" src={frame} alt={`${title}'s screen`} /> : cover}
      </div>
    </figure>
  );
}
