// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const liveConnection = vi.hoisted(() => ({
  established: undefined as ((connection: unknown) => void) | undefined,
  /** The viewer draws the browser's first frame. */
  paint: undefined as (() => void) | undefined,
  /** Holds the connection and the first frame until the test establishes and paints them. */
  held: false,
  viewers: 0,
  connection: { sendKeyboardShortcut: vi.fn(), setTrackpadMode: vi.fn(), getTrackpadMode: vi.fn(() => false), syncClipboards: vi.fn() },
  /** The DCV connection closes, or is refused before it connects, with the DCV Web Client's reason. */
  disconnect: undefined as ((reason: string) => void) | undefined,
}));

// The DCV boundary: like the DCV Web Client, connecting titles the page after the remote host, and the viewer adds its
// canvas as it draws the first frame.
vi.mock('bedrock-agentcore/browser/live-view', async () => {
  const { createElement, useEffect, useState } = await import('react');
  return {
    BrowserLiveView: ({
      onConnectionEstablished,
      onDisconnect,
    }: {
      onConnectionEstablished?: (connection: unknown) => void;
      onDisconnect?: (reason: string) => void;
    }) => {
      const [painted, setPainted] = useState(false);
      liveConnection.established = onConnectionEstablished;
      liveConnection.disconnect = onDisconnect;
      liveConnection.paint = () => setPainted(true);
      useEffect(() => {
        if (liveConnection.viewers !== 0) { onDisconnect?.('code 12: too many connections'); return; }
        liveConnection.viewers += 1;
        const release = () => { liveConnection.viewers -= 1; onDisconnect?.('Client disconnected'); };
        if (liveConnection.held) return release;
        document.title = '127.0.0.1 - Amazon DCV';
        liveConnection.established?.(liveConnection.connection);
        setPainted(true);
        return release;
      }, []);
      return painted ? createElement('canvas') : null;
    },
  };
});
const presign = vi.hoisted(() => ({ failure: null as Error | null, urls: [] as string[], pending: null as Promise<string> | null, signal: null as AbortSignal | null }));
vi.mock('./browser-live-view-url', () => ({
  fetchBrowserLiveViewSignedUrl: async (sessionId: string, { signal }: { signal: AbortSignal }) => {
    presign.signal = signal;
    const url = `https://live.test/${sessionId}/${presign.urls.length + 1}`;
    presign.urls.push(url);
    if (presign.pending) return presign.pending;
    if (presign.failure) throw presign.failure;
    return url;
  },
}));

import { BrowserLiveFrame } from './browser-live-frame';
import { AgentComputer } from './agent-computer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  presign.failure = null;
  presign.pending = null;
  presign.urls = [];
  Reflect.deleteProperty(document, 'hidden');
  liveConnection.established = undefined;
  liveConnection.paint = undefined;
  liveConnection.held = false;
  liveConnection.disconnect = undefined;
});

// The browser's WebGL, which the DCV decoders draw with: on unless a test turns it off. `lost` counts the contexts let go.
const webgl = { on: true, lost: 0 };
const loseContext = {
  loseContext: () => {
    webgl.lost += 1;
  },
};
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    ((kind: string) =>
      webgl.on && kind === 'webgl'
        ? { getExtension: (name: string) => (name === 'WEBGL_lose_context' ? loseContext : null) }
        : null) as unknown as HTMLCanvasElement['getContext'],
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  webgl.on = true;
  webgl.lost = 0;
});

describe('the live view', () => {
  it("keeps the page's own title once the browser connects", async () => {
    document.title = 'Template Bot';
    const onConnection = vi.fn();
    const root = createRoot(document.createElement('div'));
    roots.push(root);

    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1', onConnection })));
    await vi.waitFor(() => expect(onConnection).toHaveBeenCalled());

    expect(document.title).toBe('Template Bot');
  });

  it('says why, and tells its host, when the live view cannot start', async () => {
    presign.failure = new Error('Live view URL request failed: 502');
    const onError = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);

    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1', onError })));

    expect(onError).toHaveBeenCalledOnce();
    expect(host.querySelector('.browser-view-error')?.textContent).toBe('Live view URL request failed: 502');
  });

  it("says the browser can't show it, and tells its host, when WebGL is off", async () => {
    // Chrome without hardware acceleration: the DCV decoders log that WebGL is disabled and the viewer spins forever.
    webgl.on = false;
    const onError = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);

    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1', onError })));

    expect(onError).toHaveBeenCalledOnce();
    expect(host.querySelector('.browser-view-error')?.textContent).toBe("This browser can't show the live view: WebGL is off");
    expect(host.textContent).not.toContain('Connecting');
    expect(liveConnection.established).toBeUndefined();
  });

  it('lets its WebGL probe go, so the probe never costs the viewer its own context', async () => {
    // Browsers cap live WebGL contexts and drop the oldest past the cap.
    const onConnection = vi.fn();
    const root = createRoot(document.createElement('div'));
    roots.push(root);

    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1', onConnection })));
    await vi.waitFor(() => expect(onConnection).toHaveBeenCalled());

    expect(webgl.lost).toBe(1);
  });

  it('forwards the live connection to the current callback after it changes', async () => {
    document.title = 'Template Bot';
    const initialConnection = vi.fn();
    const replacementConnection = vi.fn();
    const root = createRoot(document.createElement('div'));
    roots.push(root);

    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1', onConnection: initialConnection })));
    await vi.waitFor(() => expect(initialConnection).toHaveBeenCalledOnce());

    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1', onConnection: replacementConnection })));
    expect(replacementConnection).not.toHaveBeenCalled();

    const connection = { sendKeyboardShortcut: vi.fn(), setTrackpadMode: vi.fn(), getTrackpadMode: vi.fn(() => false), syncClipboards: vi.fn() };
    await act(async () => {
      document.title = '127.0.0.1 - Amazon DCV';
      liveConnection.established?.(connection);
    });

    expect(replacementConnection).toHaveBeenCalledExactlyOnceWith(connection, true);
    expect(initialConnection).toHaveBeenCalledOnce();
    expect(document.title).toBe('Template Bot');
  });

  it("shows only the page's part of a wider screen, scaled to fill the frame", async () => {
    // A phone's 350x702 page at the top left of AgentCore's 800x702 screen: the stream is laid out
    // 800/350 frames wide, so it scales 1:1 and the frame clips the rest of the screen.
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);

    await act(async () => root.render(React.createElement(BrowserLiveFrame, {
      sessionId: 'browser-1', remoteWidth: 800, remoteHeight: 702, page: { width: 350, height: 702 },
    })));

    const view = host.querySelector<HTMLElement>('.browser-live-view');
    expect([view?.style.width, view?.style.height]).toEqual(['228.57142857142858%', '100%']);
  });

  it("keeps the viewer's Connecting spinner inside the frame until the page streams", async () => {
    // The viewer centres its spinner and Connecting in its box; a box 800/350 frames wide put them past a phone's edge.
    liveConnection.held = true;
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);

    await act(async () => root.render(React.createElement(BrowserLiveFrame, {
      sessionId: 'browser-1', remoteWidth: 800, remoteHeight: 702, page: { width: 350, height: 702 },
    })));

    const view = () => host.querySelector<HTMLElement>('.browser-live-view');
    await vi.waitFor(() => expect(liveConnection.established).toBeDefined());
    expect([view()?.style.width, view()?.style.height]).toEqual(['', '']);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => liveConnection.established?.({}));
      expect([view()?.style.width, view()?.style.height]).toEqual(['', '']);
      // Shown with no frame after waiting for one, the viewer's own state stays centred in the frame too.
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect([view()?.style.width, view()?.style.height]).toEqual(['', '']);
    } finally {
      vi.useRealTimers();
    }

    await act(async () => liveConnection.paint?.());

    expect([view()?.style.width, view()?.style.height]).toEqual(['228.57142857142858%', '100%']);
  });

  it('reports the browser once its first frame is on screen, not when it connects', async () => {
    liveConnection.held = true;
    const onConnection = vi.fn();
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1', onConnection })));
    await vi.waitFor(() => expect(liveConnection.established).toBeDefined());
    const connection = { sendKeyboardShortcut: vi.fn(), setTrackpadMode: vi.fn(), getTrackpadMode: vi.fn(() => false), syncClipboards: vi.fn() };

    await act(async () => liveConnection.established?.(connection));
    expect(onConnection).not.toHaveBeenCalled();

    await act(async () => liveConnection.paint?.());

    expect(onConnection).toHaveBeenCalledExactlyOnceWith(connection, true);
  });

  it('reports the connection 10 s after it connects with no first frame, so the viewer shows its own failure', async () => {
    liveConnection.held = true;
    const onConnection = vi.fn();
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1', onConnection })));
    await vi.waitFor(() => expect(liveConnection.established).toBeDefined());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const connection = { sendKeyboardShortcut: vi.fn(), setTrackpadMode: vi.fn(), getTrackpadMode: vi.fn(() => false), syncClipboards: vi.fn() };
      await act(async () => liveConnection.established?.(connection));

      await act(async () => vi.advanceTimersByTimeAsync(9_999));
      expect(onConnection).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(onConnection).toHaveBeenCalledExactlyOnceWith(connection, false);

      // A frame the viewer draws after all is reported as the first frame, once.
      await act(async () => liveConnection.paint?.());
      expect(onConnection).toHaveBeenLastCalledWith(connection, true);
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(onConnection).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells its host when the stream it showed ends, which the DCV Web Client never recovers', async () => {
    // The browser went to sleep, or the phone dropped the stream's socket: DCV closes the connection and keeps its last
    // frame, under its "Network connection is unstable" box when the socket fell silent first.
    const onEnded = vi.fn();
    const onError = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1', onEnded, onError })));
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());

    await act(async () => liveConnection.disconnect?.('{"code":1006,"message":"Transport error"}'));

    expect(onEnded).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('says why, and tells its host, when the DCV Web Client refuses the stream before it connects', async () => {
    liveConnection.held = true;
    const onEnded = vi.fn();
    const onError = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1', onEnded, onError })));
    await vi.waitFor(() => expect(liveConnection.disconnect).toBeDefined());

    await act(async () => liveConnection.disconnect?.('Connection failed'));

    expect(onError).toHaveBeenCalledOnce();
    expect(onEnded).not.toHaveBeenCalled();
    expect(host.querySelector('.browser-view-error')?.textContent).toBe('The live view could not connect: Connection failed');
  });
});



const visibility = async (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
};
const computerProps = {
  agentName: 'Astra', chatId: 'chat-1', app: 'Chrome' as const, files: null,
  computer: { state: 'awake' as const, browserSessionId: 'browser-1', control: 'user' as const, screenshot: 'data:image/jpeg;base64,c2hvdA==' },
  commands: [], control: 'user' as const, running: false, busy: false, error: null, notice: null,
  onTakeOver: vi.fn(), onHandBack: vi.fn(), starting: false, onStop: vi.fn(), onOpenApp: vi.fn(),
};

describe('a backgrounded Agent Computer', () => {
  it('shows Watch here immediately when its page starts hidden without a Starting cover', async () => {
    await visibility(true);
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(React.createElement(AgentComputer, computerProps)));
    expect(host.querySelector('.browser-live-watch')?.textContent).toBe('Watch here');
    expect(host.querySelector('.agent-computer-cover')).toBeNull();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,c2hvdA==');
    expect(presign.urls).toEqual([]);
  });
  it('frees its viewer slot and leaves the last screen until Watch here starts a fresh stream', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    const onLiveEnded = vi.fn();
    await act(async () => root.render(React.createElement(AgentComputer, { ...computerProps, onLiveEnded })));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="View computer"]')?.click());
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
    expect(liveConnection.viewers).toBe(1);
    await visibility(true);
    expect(liveConnection.viewers).toBe(0);
    await visibility(false);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,c2hvdA==');
    expect(host.querySelector('.agent-computer-starting')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Paste"]')?.disabled).toBe(true);
    expect(onLiveEnded).not.toHaveBeenCalled();
    const watch = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Watch here');
    expect(watch?.textContent).toBe('Watch here');
    expect(presign.urls).toEqual(['https://live.test/browser-1/1']);
    await act(async () => watch?.click());
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
    expect(liveConnection.viewers).toBe(1);
    expect(presign.urls).toEqual(['https://live.test/browser-1/1', 'https://live.test/browser-1/2']);
  });
});


describe('released viewer attempts', () => {
  it('renders the initial frame on the server without browser globals', () => {
    vi.stubGlobal('document', undefined);
    try {
      expect(renderToString(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1' }))).toContain('Connecting...');
    } finally { vi.unstubAllGlobals(); }
  });
  const mount = async (props: React.ComponentProps<typeof BrowserLiveFrame>) => {
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(React.createElement(BrowserLiveFrame, props)));
    return { host, root };
  };
  it('loads no signed URL while initially hidden and stays paused until explicitly watched', async () => {
    await visibility(true);
    const { host } = await mount({ sessionId: 'browser-hidden' });
    expect(host.textContent).toBe('Watch here');
    expect(presign.urls).toEqual([]);
    await visibility(false);
    expect(host.textContent).toBe('Watch here');
    await act(async () => host.querySelector('button')?.click());
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
    expect(presign.urls).toEqual(['https://live.test/browser-hidden/1']);
  });
  it('makes the single SDK slot available to the next visible page', async () => {
    const first = await mount({ sessionId: 'browser-1' });
    await vi.waitFor(() => expect(first.host.querySelector('canvas')).not.toBeNull());
    const refused = await mount({ sessionId: 'browser-1' });
    expect(refused.host.textContent).toBe('The live view could not connect: code 12: too many connections');
    await visibility(true);
    expect(liveConnection.viewers).toBe(0);
    await visibility(false);
    const next = await mount({ sessionId: 'browser-1' });
    await vi.waitFor(() => expect(next.host.querySelector('canvas')).not.toBeNull());
    expect(first.host.textContent).toBe('Watch here');
    expect(liveConnection.viewers).toBe(1);
  });
  it('aborts a pending URL and ignores its eventual failure when hidden', async () => {
    let reject!: (cause: Error) => void;
    presign.pending = new Promise((_, no) => { reject = no; });
    const onError = vi.fn();
    const { host } = await mount({ sessionId: 'browser-pending', onError });
    await visibility(true);
    expect(presign.signal?.aborted).toBe(true);
    await act(async () => reject(new Error('Expired old request')));
    expect(host.textContent).toBe('Watch here');
    expect(onError).not.toHaveBeenCalled();
    presign.pending = null;
    await visibility(false);
    await act(async () => host.querySelector('button')?.click());
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
  });
  it('ignores connection, disconnect and first-frame timeout callbacks from a released attempt', async () => {
    liveConnection.held = true;
    const onConnection = vi.fn();
    const onEnded = vi.fn();
    const onError = vi.fn();
    const { host } = await mount({ sessionId: 'browser-1', onConnection, onEnded, onError });
    const establish = liveConnection.established;
    const disconnect = liveConnection.disconnect;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => establish?.(liveConnection.connection));
      await visibility(true);
      await act(async () => {
        establish?.(liveConnection.connection);
        disconnect?.('Old transport error');
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(host.textContent).toBe('Watch here');
      expect(onConnection).not.toHaveBeenCalled();
      expect(onEnded).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
    liveConnection.held = false;
    await visibility(false);
    await act(async () => host.querySelector('button')?.click());
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
    expect(onConnection).toHaveBeenCalledExactlyOnceWith(liveConnection.connection, true);
  });
  it('resets for a new visible session and rejects callbacks from the old session', async () => {
    const onError = vi.fn();
    const { host, root } = await mount({ sessionId: 'browser-old', onError });
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
    const disconnect = liveConnection.disconnect;
    await visibility(true);
    await visibility(false);
    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-new', onError })));
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
    await act(async () => disconnect?.('Old session failed'));
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(presign.urls).toEqual(['https://live.test/browser-old/1', 'https://live.test/browser-new/2']);
    expect(onError).not.toHaveBeenCalled();
  });
  it('does not send a clipboard read that finishes after release to the stale connection', async () => {
    let resolve!: (text: string) => void;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => new Promise<string>((yes) => { resolve = yes; }) } });
    liveConnection.connection.sendKeyboardShortcut.mockClear();
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(React.createElement(AgentComputer, computerProps)));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="View computer"]')?.click());
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[aria-label="Paste"]')?.disabled).toBe(false));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Paste"]')?.click());
    await visibility(true);
    await act(async () => resolve('old'));
    expect(host.textContent).toContain('Watch here');
    expect(liveConnection.connection.sendKeyboardShortcut).not.toHaveBeenCalled();
    await visibility(false);
    await act(async () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Watch here')?.click());
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[aria-label="Paste"]')?.disabled).toBe(false));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Paste"]')?.click());
    await act(async () => resolve('a'));
    expect(liveConnection.connection.sendKeyboardShortcut).toHaveBeenCalledExactlyOnceWith([{ key: 'a', location: 0 }]);
    Reflect.deleteProperty(navigator, 'clipboard');
  });
});

describe('an inactive retained Agent Computer', () => {
  it('drops a pending paste after hiding and returning to the same connection, then accepts a fresh paste', async () => {
    let finishRead: (text: string) => void = () => { throw new Error('Clipboard read has not started'); };
    const readText = vi.fn(() => new Promise<string>((resolve) => { finishRead = resolve; }));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } });
    liveConnection.connection.sendKeyboardShortcut.mockClear();
    try {
      const host = document.createElement('div');
      const root = createRoot(host);
      roots.push(root);
      await act(async () => root.render(React.createElement(AgentComputer, computerProps)));
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="View computer"]')?.click());
      await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[aria-label="Paste"]')?.disabled).toBe(false));
      const canvas = host.querySelector('canvas');
      expect(canvas).not.toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Paste"]')?.click());
      expect(readText).toHaveBeenCalledOnce();
      const finishOldRead = finishRead;

      await act(async () => root.render(React.createElement(AgentComputer, { ...computerProps, active: false })));
      expect(host.querySelector('[role="toolbar"]')).toBeNull();
      await act(async () => root.render(React.createElement(AgentComputer, { ...computerProps, active: true })));
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="View computer"]')?.click());
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Paste"]')?.disabled).toBe(false);
      await act(async () => finishOldRead('old'));

      expect(liveConnection.connection.sendKeyboardShortcut).not.toHaveBeenCalled();
      expect(host.querySelector('canvas')).toBe(canvas);
      expect(presign.urls).toEqual(['https://live.test/browser-1/1']);
      expect(liveConnection.viewers).toBe(1);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Paste"]')?.click());
      await act(async () => finishRead('a'));
      expect(readText).toHaveBeenCalledTimes(2);
      expect(liveConnection.connection.sendKeyboardShortcut).toHaveBeenCalledExactlyOnceWith([{ key: 'a', location: 0 }]);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('ends an active remote touch once when its chat hides and reuses the viewer on return', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(React.createElement(AgentComputer, computerProps)));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="View computer"]')?.click());
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
    const canvas = host.querySelector('canvas');
    if (canvas === null) throw new Error('The live browser canvas is missing');
    const delivered: string[] = [];
    for (const type of ['touchstart', 'touchmove', 'touchend']) canvas.addEventListener(type, () => delivered.push(type));
    const first = new Touch({ identifier: 1, target: canvas, clientX: 100, clientY: 100 });
    const moved = new Touch({ identifier: 1, target: canvas, clientX: 120, clientY: 100 });
    await act(async () => {
      canvas.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [first] }));
      canvas.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [moved] }));
    });
    expect(delivered).toEqual(['touchstart', 'touchmove']);

    await act(async () => root.render(React.createElement(AgentComputer, { ...computerProps, active: false })));
    expect(delivered).toEqual(['touchstart', 'touchmove', 'touchend']);
    expect(host.querySelector('[role="toolbar"]')).toBeNull();
    await act(async () => root.render(React.createElement(AgentComputer, { ...computerProps, active: true })));
    expect(delivered).toEqual(['touchstart', 'touchmove', 'touchend']);
    expect(host.querySelector('canvas')).toBe(canvas);
    expect(presign.urls).toEqual(['https://live.test/browser-1/1']);
    expect(liveConnection.viewers).toBe(1);
  });
});

describe('computer connection availability', () => {
  it('reports establishment before the first frame and keeps that connection while inactive', async () => {
    liveConnection.held = true;
    const onConnectionChange = vi.fn();
    const onLive = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    const props = { ...computerProps, onConnectionChange, onLive };
    await act(async () => root.render(React.createElement(AgentComputer, props)));
    await vi.waitFor(() => expect(liveConnection.established).toBeDefined());
    await act(async () => liveConnection.established?.(liveConnection.connection));
    expect(onConnectionChange).toHaveBeenLastCalledWith(true);
    expect(host.querySelector('.agent-computer-cover')).not.toBeNull();
    expect(onLive).not.toHaveBeenCalled();

    await act(async () => root.render(React.createElement(AgentComputer, { ...props, active: false })));
    expect(liveConnection.viewers).toBe(1);
    expect(onConnectionChange.mock.calls).toEqual([[false], [true]]);
    await act(async () => liveConnection.paint?.());
    const canvas = host.querySelector('canvas');
    expect(canvas).not.toBeNull();
    await act(async () => root.render(React.createElement(AgentComputer, props)));
    expect(host.querySelector('canvas')).toBe(canvas);
    expect(host.querySelector('.agent-computer-cover')).toBeNull();
    expect(presign.urls).toEqual(['https://live.test/browser-1/1']);
    expect(onLive).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(['ended', 'released'])('reports a hidden %s stream as disconnected without another viewer URL', async (event) => {
    const onConnectionChange = vi.fn();
    const onLiveEnded = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    const props = { ...computerProps, onConnectionChange, onLiveEnded };
    await act(async () => root.render(React.createElement(AgentComputer, props)));
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
    await act(async () => root.render(React.createElement(AgentComputer, { ...props, active: false })));
    if (event === 'ended') await act(async () => liveConnection.disconnect?.('Transport ended'));
    else await visibility(true);
    expect(host.querySelector('canvas')).toBeNull();
    expect(liveConnection.viewers).toBe(0);
    expect(onConnectionChange.mock.calls).toEqual([[false], [true], [false]]);
    expect(presign.urls).toEqual(['https://live.test/browser-1/1']);
    expect(onLiveEnded).toHaveBeenCalledTimes(event === 'ended' ? 1 : 0);
    if (event === 'released') expect(host.textContent).toContain('Watch here');
  });

  it('reports a failed connection without reporting establishment', async () => {
    liveConnection.held = true;
    const onConnectionChange = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-1', onConnectionChange })));
    await vi.waitFor(() => expect(liveConnection.disconnect).toBeDefined());
    await act(async () => liveConnection.disconnect?.('Connection refused'));
    expect(host.querySelector('.browser-view-error')?.textContent).toBe('The live view could not connect: Connection refused');
    expect(onConnectionChange.mock.calls).toEqual([[false]]);
    expect(presign.urls).toEqual(['https://live.test/browser-1/1']);
  });

  it.each(['sleep', 'exhaustion'])('reports disconnection when %s removes the current viewer', async (reason) => {
    const onConnectionChange = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(React.createElement(AgentComputer, { ...computerProps, onConnectionChange })));
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
    await act(async () => root.render(React.createElement(AgentComputer, {
      ...computerProps,
      ...(reason === 'sleep' ? { computer: { state: 'asleep', screenshot: null } } : { liveViewExhausted: true }),
      onConnectionChange,
    })));
    expect(host.querySelector('canvas')).toBeNull();
    expect(liveConnection.viewers).toBe(0);
    expect(onConnectionChange.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('ignores old-session callbacks after replacement and does not synthesize disconnection on unmount', async () => {
    const onConnectionChange = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    const props = { ...computerProps, onConnectionChange };
    await act(async () => root.render(React.createElement(AgentComputer, props)));
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
    const oldDisconnect = liveConnection.disconnect;
    const oldEstablish = liveConnection.established;
    await act(async () => root.render(React.createElement(AgentComputer, {
      ...props, computer: { ...props.computer, browserSessionId: 'browser-2' },
    })));
    await vi.waitFor(() => expect(host.querySelector('canvas')).not.toBeNull());
    const current = host.querySelector('canvas');
    await act(async () => {
      oldDisconnect?.('Old stream failed');
      oldEstablish?.(liveConnection.connection);
    });
    expect(host.querySelector('canvas')).toBe(current);
    expect(onConnectionChange.mock.calls).toEqual([[false], [true], [false], [true]]);
    expect(presign.urls).toEqual(['https://live.test/browser-1/1', 'https://live.test/browser-2/2']);
    await act(async () => root.unmount());
    roots.pop();
    expect(liveConnection.viewers).toBe(0);
    expect(onConnectionChange.mock.calls).toEqual([[false], [true], [false], [true]]);
  });
});
