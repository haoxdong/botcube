"use client";

import { useEffect, useRef, useState } from 'react';
import type { BrowserLiveFrameProps } from 'botcube-ui-web/computer/browser-live-frame';
import { fetchBrowserLiveViewSignedUrl } from 'botcube-ui-web/computer/browser-live-view-url';
import { CHAT_SERVICE_URL } from './config';
import { Screen } from './screen';

/** The local browser supplies screenshots; hosted browsers use BotCube's default DCV transport. */
export function ScreenshotBrowserFrame(props: BrowserLiveFrameProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    const abort = new AbortController();
    fetchBrowserLiveViewSignedUrl(props.sessionId, { chatServiceUrl: CHAT_SERVICE_URL, signal: abort.signal }).then(
      (signed) => { if (!abort.signal.aborted) setUrl(signed); },
      (cause: Error) => { if (!abort.signal.aborted) { setError(cause.message); current.current.onError?.(); } },
    );
    return () => abort.abort();
  }, [props.sessionId]);
  return <Screen url={url} title="Agent Computer" cover={error ? <p role="alert">{error}</p> : <p role="status">Connecting…</p>}
    onFrame={() => { current.current.onConnection?.(null, true); current.current.onConnectionChange?.(true); }}
    onAsleep={() => current.current.onEnded?.()}
    onError={(message) => { setError(message); current.current.onError?.(); }} />;
}
