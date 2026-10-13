"use client";

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';

import { RemoteViewport } from './remote-viewport';

import { fetchBrowserLiveViewSignedUrl } from './browser-live-view-url';

/** Loads the live view's code, the DCV Web Client among it; once loaded, it is not loaded again. */
export const loadLiveView = () => import('bedrock-agentcore/browser/live-view').then((mod) => mod.BrowserLiveView);

const BrowserLiveView = dynamic(
  loadLiveView,
  {
    ssr: false,
    loading: () => <div className="browser-view-status">Connecting...</div>,
  },
);

/**
 * How long a connected live view may go without its first frame before it is shown anyway, so the viewer's own state
 * shows: the SDK reports no disconnect or failure after connecting. On dev, the first frame came 1.0–1.6 s after it.
 */
const FIRST_FRAME_WAIT_MS = 10_000;

// The DCV decoders draw with WebGL and, without it, leave the viewer connecting forever. The probe lets
// its context go, so it never counts towards the browser's cap on live contexts, which drops the oldest: the viewer's.
const hasWebGl = () =>
  ['webgl2', 'webgl'].some((kind) => {
    const context = document.createElement('canvas').getContext(kind) as WebGLRenderingContext | null;
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return context !== null;
  });

/** The DCV connection calls Take-over by touch uses (DCV Web Client SDK `Connection`). */
export interface LiveViewConnection {
  sendKeyboardShortcut(keys: { key: string; location: number }[]): void;
  setTrackpadMode(enabled: boolean): boolean;
  getTrackpadMode(): boolean;
  /** Copies the browser's clipboard to this device's; false when it has none yet. */
  syncClipboards(): boolean;
}

export interface BrowserLiveFrameProps {
  sessionId: string;
  expanded?: boolean;
  interactive?: boolean;
  lastScreen?: string | null;
  onReleased?: () => void;
  /** Connection availability, independent of the first frame being painted. */
  onConnectionChange?: (connected: boolean) => void;
  remoteWidth?: number;
  remoteHeight?: number;
  /** The part of the remote screen the page fills, from its top left; the frame shows only it. */
  page?: { width: number; height: number } | undefined;
  /**
   * The live view shows: the browser's first frame is on screen (`painted`), or, connected that long with none, the
   * viewer's own state, and then the first frame should it come after all.
   */
  onConnection?: (connection: LiveViewConnection | null, painted: boolean) => void;
  /** The live view could not start; the frame says why. */
  onError?: () => void;
  /**
   * The stream it showed ended, as when the browser goes to sleep or the phone drops its socket. The DCV
   * Web Client never connects again, and keeps its last frame, under its "Network connection is unstable" box when the
   * socket fell silent first.
   */
  onEnded?: () => void;
  recoverOnStall?: boolean;
}

export function BrowserLiveFrame(props: BrowserLiveFrameProps) {
  return <BrowserLiveFrameSession key={props.sessionId} {...props} />;
}

function BrowserLiveFrameSession(props: BrowserLiveFrameProps) {
  const [phase, setPhase] = useState<'viewing' | 'released'>(() => typeof document !== 'undefined' && document.hidden ? 'released' : 'viewing');
  const active = useRef(phase === 'viewing');
  const released = useRef(props.onReleased);
  released.current = props.onReleased;
  const connectionChanged = useRef(props.onConnectionChange);
  connectionChanged.current = props.onConnectionChange;
  useEffect(() => {
    if (!active.current) {
      connectionChanged.current?.(false);
      released.current?.();
    }
    const hide = () => {
      if (!document.hidden || !active.current) return;
      active.current = false;
      setPhase('released');
      connectionChanged.current?.(false);
      released.current?.();
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);
  if (phase === 'released') return (
    <div className="browser-live-host browser-live-released">
      {props.lastScreen && <img className="agent-computer-screenshot" src={props.lastScreen} alt="The last screen" />}
      <button type="button" className="browser-live-watch" onClick={() => {
        if (document.hidden) return;
        active.current = true;
        setPhase('viewing');
      }}>Watch here</button>
    </div>
  );
  return <ConnectedLiveFrame {...props} active={active} />;
}

function ConnectedLiveFrame({ sessionId, expanded = false, interactive = true, remoteWidth = 1280, remoteHeight = 720, page, onConnection, onConnectionChange, onError, onEnded, recoverOnStall = false, active }: BrowserLiveFrameProps & { active: { current: boolean } }) {
  const mounted = useRef(true);
  const inputConnection = useRef<LiveViewConnection | null>(null);
  const completeTouch = (end: () => void) => {
    const connection = inputConnection.current;
    const trackpad = connection?.getTrackpadMode() ?? false;
    // A trackpad end generates a click. Complete a canceled touch in direct mode, then restore the user's mode.
    if (trackpad) connection?.setTrackpadMode(false);
    try { end(); } finally { if (trackpad) connection?.setTrackpadMode(true); }
  };
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  // Connecting retitles the page after the remote host ("127.0.0.1 - Amazon DCV"); the page keeps its own.
  const pageTitle = useRef('');
  const failed = useRef(onError);
  failed.current = onError;
  const shown = useRef(onConnection);
  shown.current = onConnection;
  const connectionChanged = useRef(onConnectionChange);
  connectionChanged.current = onConnectionChange;
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const phase = useRef<'waiting' | 'open' | 'ended'>('waiting');
  const view = useRef<HTMLDivElement>(null);
  const firstFrame = useRef<MutationObserver | null>(null);
  const firstFrameWait = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopWaiting = useCallback(() => {
    firstFrame.current?.disconnect();
    clearTimeout(firstFrameWait.current);
  }, []);
  // The viewer adds its canvas as it draws the browser's first frame: the frame is live from then, not
  // from the connection, which comes a second or two before it.
  const connected = useCallback((connection: LiveViewConnection) => {
    if (!mounted.current || !active.current || phase.current === 'ended') return;
    document.title = pageTitle.current;
    phase.current = 'open';
    inputConnection.current = connection;
    connectionChanged.current?.(true);
    stopWaiting();
    const box = view.current;
    if (box === null) throw new Error('The live view connected outside its frame');
    const show = (painted: boolean) => {
      if (!mounted.current || !active.current) return;
      // Until a frame comes the viewer keeps the frame's size, its own state centred in it.
      if (painted) {
        stopWaiting();
        setLive(true);
      }
      shown.current?.(connection, painted);
    };
    const drawn = () => box.querySelector('canvas') !== null;
    if (drawn()) return show(true);
    firstFrame.current = new MutationObserver(() => drawn() && show(true));
    firstFrame.current.observe(box, { childList: true, subtree: true });
    firstFrameWait.current = setTimeout(() => show(false), FIRST_FRAME_WAIT_MS);
  }, [active, stopWaiting]);
  const endStream = useCallback(() => {
    if (!mounted.current || !active.current || phase.current !== 'open') return;
    phase.current = 'ended';
    inputConnection.current = null;
    stopWaiting();
    connectionChanged.current?.(false);
    ended.current?.();
  }, [active, stopWaiting]);
  const disconnected = useCallback((reason: unknown) => {
    if (!mounted.current || !active.current || phase.current === 'ended') return;
    if (phase.current === 'open') return endStream();
    mounted.current = false;
    stopWaiting();
    inputConnection.current = null;
    setError(`The live view could not connect: ${String(reason)}`);
    connectionChanged.current?.(false);
    failed.current?.();
  }, [active, endStream, stopWaiting]);

  useEffect(() => {
    mounted.current = true;
    pageTitle.current = document.title;
    phase.current = 'waiting';
    inputConnection.current = null;
    setSignedUrl(null);
    setError(null);
    setLive(false);
    if (!hasWebGl()) {
      setError("This browser can't show the live view: WebGL is off");
      connectionChanged.current?.(false);
      failed.current?.();
      return;
    }
    const controller = new AbortController();

    async function loadSignedUrl() {
      const url = await fetchBrowserLiveViewSignedUrl(sessionId, { signal: controller.signal });
      if (!controller.signal.aborted && active.current) setSignedUrl(url);
    }

    loadSignedUrl().catch((err: unknown) => {
      if (controller.signal.aborted || !active.current) return;
      setError(err instanceof Error ? err.message : 'Live view URL request failed');
      connectionChanged.current?.(false);
      failed.current?.();
    });

    return () => {
      mounted.current = false;
      inputConnection.current = null;
      controller.abort();
      stopWaiting();
    };
  }, [sessionId, active, stopWaiting]);

  if (error) {
    return <div className="browser-view-status browser-view-error">{error}</div>;
  }

  if (!signedUrl) {
    return <div className="browser-view-status">Connecting...</div>;
  }

  return (
    <RemoteViewport completeTouch={completeTouch} sessionId={sessionId} expanded={expanded} interactive={interactive}>
    <div className="browser-live-host">
      <div className="browser-view-status">Connecting...</div>
      {/* The live view fits the whole screen into its box: a box as many frames wide and tall as the screen is pages
          puts the page over the frame, and the host clips the rest. Until its first frame the box is the frame, so the
          viewer's own Connecting spinner, or its own failure, stays centred in it. */}
      <div
        ref={view}
        className="browser-live-view"
        style={page && live ? { width: `${(100 * remoteWidth) / page.width}%`, height: `${(100 * remoteHeight) / page.height}%` } : undefined}
      >
        <BrowserLiveView signedUrl={signedUrl} remoteWidth={remoteWidth} remoteHeight={remoteHeight} onConnectionEstablished={connected} onDisconnect={disconnected} {...(recoverOnStall ? { onStreamStalled: endStream } : {})} />
      </div>
    </div>
    </RemoteViewport>
  );
}
