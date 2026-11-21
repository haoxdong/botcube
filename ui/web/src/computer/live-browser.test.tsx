// @vitest-environment happy-dom
import { EventType } from '@ag-ui/client';
import type { ComputerViewProps } from '../plugin/index.js';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The CopilotKit boundary: one chat agent whose CUSTOM events the test sends.
const kit = vi.hoisted(() => {
  const listeners = new Set<(params: { event: { name: string; value: unknown } }) => void>();
  const agent = {
    subscribe: (subscriber: { onCustomEvent: (params: { event: { name: string; value: unknown } }) => void }) => {
      listeners.add(subscriber.onCustomEvent);
      return { unsubscribe: () => listeners.delete(subscriber.onCustomEvent) };
    },
  };
  const copilotkit = { getAgent: (id: string) => (id === 'template' ? agent : undefined) };
  const send = (value: unknown, name = 'botcube:browser-live-view') => {
    for (const listener of listeners) listener({ event: { name, value } });
  };
  return { listeners, copilotkit, send };
});
vi.mock('@copilotkit/react-core/v2/headless', () => ({
  useCopilotKit: () => ({ copilotkit: kit.copilotkit }),
}));

vi.mock('bedrock-agentcore/browser/live-view', () => ({
  BrowserLiveView: () => { throw new Error('The screenshot view must not mount the DCV viewer'); },
}));

import { ComputerView } from './computer-view';
import { LiveBrowserPanel } from './live-browser-panel';
import { LiveBrowserWindow } from './live-browser-window';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHAT = 'http://localhost:8123';
type Answer = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
let answers: Record<string, Answer>;
let requests: string[];
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  requests = [];
  answers = {};
  kit.listeners.clear();
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const answer = answers[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (!answer) throw new Error(`Unexpected request ${init?.method ?? 'GET'} ${input}`);
    return answer(url, init);
  });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:frame');
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const settle = () => act(async () => vi.advanceTimersByTimeAsync(0));
const button = (name: string) => {
  const found = [...container.querySelectorAll('button')].find((candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent) === name);
  if (!found) throw new Error(`No ${name} button`);
  return found;
};
const asleep = () => Response.json({ state: 'asleep', screenshot: null });
// A local Agent Computer: its live view is a stream of screenshots.
const awake = () => Response.json({ state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null, liveView: 'screenshots' });
const frame = () => new Response(new Blob(['png']), { headers: { 'content-type': 'image/png' } });

describe('the Computer tab on a local Agent Computer', () => {
  const activity: ComputerViewProps['activity'] = {
    messages: [], running: false, stop: null,
    subscribeToCustomEvents: (listener) => {
      const receive = ({ event }: { event: { name: string; value: unknown } }) => listener({ type: EventType.CUSTOM, ...event });
      kit.listeners.add(receive);
      return () => { kit.listeners.delete(receive); };
    },
  };
  const show = (shown = true, chat = 'chat-1') =>
    act(async () => root.render(<ComputerView activity={activity} agentId="template" agentName="BotCube" conversation={{ id: chat, service: 'chat-service' }} shown={shown} chatServiceUrl={CHAT} />));

  beforeEach(() => {
    answers['GET /browser-live-view-url'] = () => Response.json({ signedUrl: `${CHAT}/agent-computer/view?thread_id=chat-1` });
  });

  it('wakes a sleeping computer and paints its local screenshot through the generic desktop', async () => {
    answers['GET /agent-computer'] = asleep;
    answers['POST /agent-computer/wake'] = awake;
    answers['GET /agent-computer/view'] = frame;
    await show();
    await settle();
    expect(requests.slice(0, 4)).toEqual([
      'GET /agent-computer?thread_id=chat-1',
      'POST /agent-computer/wake?thread_id=chat-1',
      'GET /browser-live-view-url?session_id=browser-1',
      'GET /agent-computer/view?thread_id=chat-1',
    ]);
    expect(container.querySelector('.agent-computer')).not.toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:frame');
    expect(container.textContent).toContain('BotCube has control');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(requests.filter((request) => request.startsWith('GET /agent-computer/view'))).toHaveLength(2);
  });

  it('keeps a stream that sleeps under the open tab asleep until the tab opens again', async () => {
    answers['GET /agent-computer'] = awake;
    answers['GET /agent-computer/view'] = () => new Response(null, { status: 409 });
    await show();
    await settle();
    expect(requests.filter((request) => request.startsWith('POST'))).toEqual([]);
    answers['GET /agent-computer'] = asleep;
    answers['POST /agent-computer/wake'] = awake;
    answers['GET /agent-computer/view'] = frame;
    await show(false);
    await show(true);
    await settle();
    expect(requests).toContain('POST /agent-computer/wake?thread_id=chat-1');
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('under liveView none, wakes the computer but requests no live view and shows its static state', async () => {
    answers['GET /agent-computer'] = asleep;
    answers['POST /agent-computer/wake'] = () => Response.json({ state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null, liveView: 'none' });
    await show();
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(requests).toEqual(['GET /agent-computer?thread_id=chat-1', 'POST /agent-computer/wake?thread_id=chat-1']);
    expect(container.querySelector('.agent-computer-notice')?.textContent).toBe('Live view is off in this deployment.');
    expect(container.textContent).not.toContain('Connecting…');
    expect(container.textContent).not.toContain('Take over');
  });

  it('explains a wake before the first message starts its computer', async () => {
    answers['GET /agent-computer'] = asleep;
    answers['POST /agent-computer/wake'] = () => Response.json({ detail: "The computer starts with this chat's first message." }, { status: 404 });
    await show();
    await settle();
    expect(container.querySelector('.agent-computer-notice')?.textContent).toBe("The computer starts with this chat's first message.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('reports failed wakes and retries when the tab opens again', async () => {
    answers['GET /agent-computer'] = asleep;
    answers['POST /agent-computer/wake'] = () => Response.json({ detail: 'Agent Computer task is stopping' }, { status: 503 });
    await show();
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Agent Computer task is stopping. Reopen the Computer tab to try again.');
    answers['POST /agent-computer/wake'] = awake;
    answers['GET /agent-computer/view'] = frame;
    await show(false);
    await show(true);
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('uses the generic Files app and preserves failed listings', async () => {
    answers['GET /agent-computer'] = awake;
    answers['GET /agent-computer/view'] = frame;
    answers['GET /files'] = () => Response.json({ detail: 'Files unavailable' }, { status: 503 });
    await show();
    await settle();
    await act(async () => button('Files').click());
    await settle();
    expect(container.querySelector('.agent-computer-files')).not.toBeNull();
    expect(container.textContent).toContain('Files unavailable');
  });

});

describe('the live browser panel', () => {
  const panel = (chat = 'chat-1') =>
    act(async () => root.render(<LiveBrowserPanel agentId="template" conversation={{ id: chat, service: 'chat-service' }} />));

  it('floats the screen while a Turn drives the browser, and leaves when the browser closes', async () => {
    answers['GET /agent-computer/view'] = frame;
    await panel();
    expect(container.innerHTML).toBe('');
    await act(async () => kit.send({ open: true, sessionId: 'browser-1' }));
    await settle();
    expect(container.querySelector('[aria-label="Live browser"] img')).not.toBeNull();
    await act(async () => kit.send({ open: false }));
    expect(container.innerHTML).toBe('');
  });

  it('closes on request and when the computer sleeps, and ignores other events', async () => {
    answers['GET /agent-computer/view'] = frame;
    await panel();
    await act(async () => kit.send({ open: true, sessionId: 'browser-1' }, 'another-event'));
    expect(container.innerHTML).toBe('');
    await act(async () => kit.send({ open: true, sessionId: 'browser-1' }));
    await settle();
    await act(async () => button('Close live browser').click());
    expect(container.innerHTML).toBe('');
    answers['GET /agent-computer/view'] = () => new Response(null, { status: 409 });
    await act(async () => kit.send({ open: true, sessionId: 'browser-1' }));
    await settle();
    expect(container.innerHTML).toBe('');
  });

  it('shows why the screen failed, and rejects a malformed event', async () => {
    answers['GET /agent-computer/view'] = () => Response.json({ detail: 'Agent Computer idle cleanup failed' }, { status: 503 });
    await panel();
    await act(async () => kit.send({ open: true, sessionId: 'browser-1' }));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not show the screen (HTTP 503): Agent Computer idle cleanup failed');
    expect(() => kit.send({ open: true })).toThrow('The browser live-view event is malformed');
  });

  it("keeps one chat's browser out of another chat", async () => {
    answers['GET /agent-computer/view'] = frame;
    await panel('chat-1');
    await act(async () => kit.send({ open: true, sessionId: 'browser-1' }));
    await panel('chat-2');
    expect(container.innerHTML).toBe('');
  });
});

describe('the pop-out window', () => {
  const popOut = async (search: string) => {
    window.history.replaceState(null, '', `/browser-view${search}`);
    // Each pop-out is its own window, reading its Session once as it opens.
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<LiveBrowserWindow agentName="BotCube" />));
    await settle();
  };

  it("shows the owner's browser Session through its live-view URL", async () => {
    answers['GET /browser-live-view-url'] = () => Response.json({ signedUrl: `${CHAT}/agent-computer/view?thread_id=chat-1` });
    answers['GET /agent-computer/view'] = frame;
    await popOut('?session_id=browser-1');
    expect(requests).toEqual(['GET /browser-live-view-url?session_id=browser-1', 'GET /agent-computer/view?thread_id=chat-1']);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe("BotCube's computer's screen");
  });

  it('says why it shows nothing: no Session, a refused one, or a computer gone to sleep', async () => {
    await popOut('');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This window names no browser Session.');
    answers['GET /browser-live-view-url'] = () => Response.json({ detail: "Not this account's Agent Computer" }, { status: 403 });
    await popOut('?session_id=browser-9');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not open the live view (HTTP 403): Not this account's Agent Computer");
    answers['GET /browser-live-view-url'] = () => Response.json({ signedUrl: `${CHAT}/agent-computer/view?thread_id=chat-1` });
    answers['GET /agent-computer/view'] = () => new Response(null, { status: 409 });
    await popOut('?session_id=browser-1');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The computer went to sleep. Wake it from the Computer tab, then pop it out again.');
  });
});
