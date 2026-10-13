// @vitest-environment happy-dom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ViewerConfig {
  onConnectionEstablished: (connection: { disconnect: () => void }) => void;
  onDisconnect: (reason: string) => void;
  observers: { networkQualityChange?: (event: { quality: string }) => void };
}

const viewer = vi.hoisted(() => ({ config: undefined as ViewerConfig | undefined, sequence: 0 }));

vi.mock('dcv', () => ({
  default: {
    LogLevel: { INFO: 1 },
    setLogLevel: () => undefined,
    authenticate: (_url: string, callbacks: { success: (auth: unknown, sessions: { sessionId: string; authToken: string }[]) => void }) =>
      callbacks.success(null, [{ sessionId: 'dcv-session', authToken: 'dcv-token' }]),
  },
}));
vi.mock('dcv-ui', () => ({
  DCVViewer: ({ dcv }: { dcv: ViewerConfig }) => {
    viewer.config = dcv;
    return React.createElement('canvas');
  },
}));
vi.mock('./browser-live-view-url', () => ({
  fetchBrowserLiveViewSignedUrl: async () => `https://live.test/signed?session=${++viewer.sequence}`,
}));

import { BrowserLiveFrame, loadLiveView } from './browser-live-frame';
import { AgentComputer } from './agent-computer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    getExtension: () => ({ loseContext: () => undefined }),
  } as unknown as WebGLRenderingContext);
});
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  viewer.config = undefined;
  vi.restoreAllMocks();
});

function ComputerHost({ ended }: { ended: () => void }) {
  const [live, setLive] = useState(true);
  return live
    ? React.createElement(BrowserLiveFrame, {
      sessionId: 'browser-1',
      recoverOnStall: true,
      onEnded: () => { ended(); setLive(false); },
    })
    : React.createElement('div', null, 'Last screen');
}

async function renderHost(connected = true) {
  const host = document.createElement('div');
  const root = createRoot(host);
  roots.push(root);
  const ended = vi.fn();
  await act(async () => root.render(React.createElement(ComputerHost, { ended })));
  await act(async () => {
    await loadLiveView();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const config = viewer.config;
  if (!config) throw new Error('The DCV viewer did not mount');
  if (connected) {
    await act(async () => config.onConnectionEstablished({ disconnect: () => config.onDisconnect('Client disconnected') }));
  }
  expect(host.querySelector('canvas')).not.toBeNull();
  return { host, ended, config, root };
}

describe('the Computer live view at DCV data timeout', () => {
  it('opts the actual Computer into timeout recovery and retains its last screen', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    const ended = vi.fn();
    await act(async () => root.render(React.createElement(AgentComputer, {
      agentName: 'Test Agent', chatId: 'chat-1', app: 'Chrome', files: null,
      computer: { state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: 'data:image/png;base64,c2NyZWVu' },
      commands: [], control: 'agent', running: false, busy: false, error: null, notice: null,
      onTakeOver: vi.fn(), onHandBack: vi.fn(), starting: false, onStop: vi.fn(), onOpenApp: vi.fn(),
      onLiveEnded: ended,
    })));
    await act(async () => {
      await loadLiveView();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const config = viewer.config;
    if (!config) throw new Error('The DCV viewer did not mount');
    await act(async () => config.onConnectionEstablished({ disconnect: () => undefined }));
    expect(host.querySelector('canvas')).not.toBeNull();
    await act(async () => config.observers.networkQualityChange?.({ quality: 'WARNING' }));
    expect(host.querySelector('canvas')).toBeNull();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,c2NyZWVu');
    expect(ended).toHaveBeenCalledOnce();
  });

  it('returns to Last screen when the established stream warns, before its socket disconnects', async () => {
    const { host, ended, config } = await renderHost();

    await act(async () => config.observers.networkQualityChange?.({ quality: 'WARNING' }));

    expect(host.textContent).toBe('Last screen');
    expect(ended).toHaveBeenCalledOnce();
  });

  it.each(['ONLINE', 'CRITICAL'])('keeps a connected viewer at %s quality, then recovers at WARNING', async (quality) => {
    const { host, ended, config } = await renderHost();
    await act(async () => config.observers.networkQualityChange?.({ quality }));
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(ended).not.toHaveBeenCalled();

    await act(async () => config.observers.networkQualityChange?.({ quality: 'WARNING' }));
    expect(host.textContent).toBe('Last screen');
  });

  it('does not end a viewer warned before it connects', async () => {
    const { host, ended, config } = await renderHost(false);
    await act(async () => config.observers.networkQualityChange?.({ quality: 'WARNING' }));
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(ended).not.toHaveBeenCalled();

    await act(async () => config.onConnectionEstablished({ disconnect: () => undefined }));
    await act(async () => config.observers.networkQualityChange?.({ quality: 'WARNING' }));
    expect(host.textContent).toBe('Last screen');
  });

  it('reports one end when a warning is followed by repeated warnings and a late disconnect', async () => {
    const { host, ended, config } = await renderHost();
    await act(async () => {
      config.observers.networkQualityChange?.({ quality: 'WARNING' });
      config.observers.networkQualityChange?.({ quality: 'WARNING' });
      config.onDisconnect('Transport error');
    });
    expect(host.textContent).toBe('Last screen');
    expect(ended).toHaveBeenCalledOnce();
    await act(async () => {
      config.observers.networkQualityChange?.({ quality: 'WARNING' });
      config.onDisconnect('Transport error');
    });
    expect(ended).toHaveBeenCalledOnce();
  });

  it('reports a startup socket refusal as a connection error', async () => {
    const { host, ended, config } = await renderHost(false);
    await act(async () => config.onDisconnect('Connection failed'));
    expect(host.querySelector('.browser-view-error')?.textContent).toBe('The live view could not connect: Connection failed');
    expect(ended).not.toHaveBeenCalled();
  });

  it('keeps DCV warnings for a host that only recovers disconnects', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);
    const ended = vi.fn();
    await act(async () => root.render(React.createElement(BrowserLiveFrame, { sessionId: 'browser-normal', onEnded: ended })));
    await act(async () => {
      await loadLiveView();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const config = viewer.config;
    if (!config) throw new Error('The DCV viewer did not mount');
    expect(config.observers.networkQualityChange).toBeUndefined();
    await act(async () => config.onConnectionEstablished({ disconnect: () => undefined }));
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(ended).not.toHaveBeenCalled();
    await act(async () => config.onDisconnect('Transport error'));
    expect(ended).toHaveBeenCalledOnce();
    expect(host.querySelector('canvas')).not.toBeNull();
  });

  it('ignores quality and disconnect events after its host unmounts', async () => {
    const { ended, config, root } = await renderHost();
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await act(async () => {
      config.observers.networkQualityChange?.({ quality: 'WARNING' });
      config.onDisconnect('Transport error');
    });
    expect(ended).not.toHaveBeenCalled();
  });


  it('uses the current recovery callback when its host updates', async () => {
    const { host, ended, config, root } = await renderHost();
    const latest = vi.fn();
    await act(async () => root.render(React.createElement(ComputerHost, { ended: latest })));
    await act(async () => config.observers.networkQualityChange?.({ quality: 'WARNING' }));
    expect(host.textContent).toBe('Last screen');
    expect(latest).toHaveBeenCalledOnce();
    expect(ended).not.toHaveBeenCalled();
  });

});
