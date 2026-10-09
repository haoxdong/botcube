// @vitest-environment happy-dom
import { EventType } from '@ag-ui/client';
import type { ComputerViewProps } from 'botcube-ui-web/cartridge';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The CopilotKit boundary: one chat agent whose CUSTOM events the test sends, and the chat's own tool renderers.
const kit = vi.hoisted(() => {
  const listeners = new Set<(params: { event: { name: string; value: unknown } }) => void>();
  const renderers: { name: string; render: (props: Record<string, unknown>) => unknown }[] = [];
  const registered: { name: string; render: (props: Record<string, unknown>) => unknown }[] = [];
  const agent = {
    subscribe: (subscriber: { onCustomEvent: (params: { event: { name: string; value: unknown } }) => void }) => {
      listeners.add(subscriber.onCustomEvent);
      return { unsubscribe: () => listeners.delete(subscriber.onCustomEvent) };
    },
  };
  const copilotkit = { getAgent: (id: string) => (id === 'template' ? agent : undefined), renderToolCalls: renderers };
  const send = (value: unknown, name = 'botcube:browser-live-view') => {
    for (const listener of listeners) listener({ event: { name, value } });
  };
  return { listeners, renderers, registered, copilotkit, send };
});
vi.mock('@copilotkit/react-core/v2/headless', () => ({
  useCopilotKit: () => ({ copilotkit: kit.copilotkit }),
  useRenderTool: (config: { name: string; render: (props: Record<string, unknown>) => unknown }) => {
    kit.registered.push(config);
  },
}));

import { TEMPLATE_IDENTITY } from '../../../identity';
import { TemplateAuthProvider, SignInsTab } from './auth-provider';
import { BrowserPanel } from './browser-panel';
import { BrowserView } from './browser-view';
import { ComputerView } from './computer-view';
import { webUiPlugin } from './index';
import { SiteDataResult } from './site-data-result';

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
  kit.registered.length = 0;
  kit.renderers.length = 0;
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
const awake = () => Response.json({ state: 'awake', browserSessionId: 'browser-1', control: 'agent', screenshot: null });
const frame = () => new Response(new Blob(['png']), { headers: { 'content-type': 'image/png' } });

describe('the template web UI plugin', () => {
  it("fills every slot with BotCube's default name, theme and views", () => {
    expect(webUiPlugin.config).toEqual({
      agentId: 'template', chatServiceUrl: CHAT,
      title: TEMPLATE_IDENTITY.name, agentName: TEMPLATE_IDENTITY.name,
      subtitle: 'A local agent built with BotCube.',
      disclaimer: 'This local template uses stand-ins for external services.',
      loginLabel: 'Connect', relinkLabel: 'Reconnect', logoutLabel: 'Reset', accountLabel: 'Account',
      agentOptions: { effortLevels: [{ key: 'medium', label: 'Medium' }], defaultEffort: 'medium' },
    });
    expect(TEMPLATE_IDENTITY.name).toBe('BotCube');
    expect(webUiPlugin.toolResultRenderers).toEqual([SiteDataResult]);
    expect(webUiPlugin.auxiliaryPanels).toEqual([BrowserPanel]);
    expect(webUiPlugin.AuxiliaryView).toBe(BrowserView);
    expect(webUiPlugin.ComputerView).toBe(ComputerView);
    expect(webUiPlugin.AuthProvider).toBe(TemplateAuthProvider);
    expect(webUiPlugin.agentProfileTabs).toEqual({ 'Sign-ins': SignInsTab });
    expect(webUiPlugin.fileUrl).toEqual(expect.any(Function));
    expect(webUiPlugin.theme).toEqual(TEMPLATE_IDENTITY.theme);
    expect(webUiPlugin.theme).toEqual({ '--color-blue': '#2563eb', '--color-blue-soft': '#eff6ff' });
  });

  it("resolves an agent file's encoded path through the Chat Service and fails loud", async () => {
    const { fileUrl } = webUiPlugin;
    if (!fileUrl) throw new Error('The plugin has no file URL slot');
    answers['GET /files/download-url'] = (url) =>
      url.searchParams.get('name') === 'sample.txt' ? Response.json({ url: `${CHAT}/files/sample.txt` }) : new Response(null, { status: 404 });
    await expect(fileUrl('/sample%2Etxt')).resolves.toBe(`${CHAT}/files/sample.txt`);
    expect(requests).toEqual(['GET /files/download-url?name=sample.txt']);
    await expect(fileUrl('/missing.txt')).rejects.toThrow('File download failed: 404');
    await expect(fileUrl('sample.txt')).rejects.toThrow('Agent file path must start with /');
    await expect(fileUrl('/%ZZ')).rejects.toThrow(URIError);
    answers['GET /files/download-url'] = () => Response.json({});
    await expect(fileUrl('/sample.txt')).rejects.toThrow('File download returned no URL');
  });
});

describe('the Computer tab', () => {
  const activity: ComputerViewProps['activity'] = {
    messages: [], running: false, stop: null,
    subscribeToCustomEvents: (listener) => {
      const receive = ({ event }: { event: { name: string; value: unknown } }) => listener({ type: EventType.CUSTOM, ...event });
      kit.listeners.add(receive);
      return () => { kit.listeners.delete(receive); };
    },
  };
  const show = (shown = true, chat = 'chat-1') =>
    act(async () => root.render(<ComputerView activity={activity} agentId="template" agentName="BotCube" conversation={{ id: chat, service: 'chat-service' }} shown={shown} />));

  it('wakes a sleeping computer when it shows, then shows its screen live', async () => {
    answers['GET /agent-computer'] = asleep;
    answers['POST /agent-computer/wake'] = awake;
    answers['GET /agent-computer/view'] = frame;
    await show();
    await settle();
    expect(requests.slice(0, 3)).toEqual([
      'GET /agent-computer?thread_id=chat-1',
      'POST /agent-computer/wake?thread_id=chat-1',
      'GET /agent-computer/view?thread_id=chat-1',
    ]);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:frame');
    expect(container.querySelector('.status-pill')?.textContent).toBe('Awake');
    expect(container.textContent).toContain('BotCube is driving');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(requests.filter((request) => request.startsWith('GET /agent-computer/view'))).toHaveLength(2);

    const open = vi.fn();
    vi.stubGlobal('open', open);
    await act(async () => button('Pop out').click());
    expect(open).toHaveBeenCalledWith('/browser-view?session_id=browser-1', '_blank', 'popup,width=1280,height=840');
  });

  it('stays asleep when the computer sleeps under the open tab, until the user wakes it', async () => {
    answers['GET /agent-computer'] = awake;
    answers['GET /agent-computer/view'] = () => new Response(null, { status: 409 });
    await show();
    await settle();
    expect(container.querySelector('.status-pill')?.textContent).toBe('Asleep');
    expect(container.textContent).toContain("BotCube's browser sleeps after ten idle minutes. Wake it to look again.");
    expect(requests.filter((request) => request.startsWith('POST'))).toEqual([]);
    answers['POST /agent-computer/wake'] = awake;
    answers['GET /agent-computer/view'] = frame;
    await act(async () => button('Wake').click());
    await settle();
    expect(requests).toContain('POST /agent-computer/wake?thread_id=chat-1');
    expect(container.querySelector('img')).not.toBeNull();
  });

  it("explains a chat whose first message has not started its computer", async () => {
    answers['GET /agent-computer'] = () => Response.json({ detail: 'This account does not own the Session' }, { status: 404 });
    await show();
    await settle();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("The computer starts with this chat's first message.");
    expect(button('Wake').disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('names a failed wake with the Chat Service reason and retries on request', async () => {
    answers['GET /agent-computer'] = asleep;
    answers['POST /agent-computer/wake'] = () => Response.json({ detail: 'Agent Computer task is stopping' }, { status: 503 });
    await show();
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not wake the Agent Computer (HTTP 503): Agent Computer task is stopping');
    expect(container.querySelector('.status-pill')?.textContent).toBe('Unavailable');
    answers['POST /agent-computer/wake'] = awake;
    answers['GET /agent-computer/view'] = frame;
    await act(async () => button('Retry').click());
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('rejects an unknown computer state rather than showing it asleep', async () => {
    answers['GET /agent-computer'] = () => Response.json({ state: 'dreaming' });
    await show();
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The Agent Computer answered with an unknown state');
  });

  it('asks nothing while hidden, and goes live when a Turn opens the browser under the open tab', async () => {
    await show(false);
    await settle();
    expect(requests).toEqual([]);
    answers['GET /agent-computer'] = () => Response.json({ detail: 'This account does not own the Session' }, { status: 404 });
    await show(true);
    await settle();
    answers['GET /agent-computer/view'] = frame;
    await act(async () => kit.send({ open: true, sessionId: 'browser-2' }));
    await settle();
    expect(container.querySelector('img')).not.toBeNull();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await act(async () => button('Pop out').click());
    expect(open).toHaveBeenCalledWith('/browser-view?session_id=browser-2', '_blank', 'popup,width=1280,height=840');
  });
});

describe('the live browser panel', () => {
  const panel = (chat = 'chat-1') =>
    act(async () => root.render(<BrowserPanel agentId="template" conversation={{ id: chat, service: 'chat-service' }} />));

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
    await act(async () => root.render(<BrowserView />));
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

describe('the template site data renderer', () => {
  const render = async (props: Record<string, unknown>) => {
    kit.renderers.push({ name: '*', render: ({ name, status }) => <p className="row">{`${String(name)} ${String(status)}`}</p> });
    await act(async () => root.render(<SiteDataResult />));
    const registered = kit.registered.at(-1);
    if (!registered) throw new Error('The renderer registered nothing');
    expect(registered.name).toBe('execute');
    await act(async () => root.render(<>{registered.render({ name: 'execute', toolCallId: 'call-1', ...props }) as React.ReactNode}</>));
  };

  it("shows the site's items under the chat's own row", async () => {
    await render({ status: 'complete', parameters: { command: 'template-cli data' }, result: '{"items": [{"name": "Sample item", "value": 42}]}\n' });
    expect(container.querySelector('.row')?.textContent).toBe('execute complete');
    expect([...container.querySelectorAll('.template-site-data-item')].map((item) => item.textContent)).toEqual(['Sample item42']);
    expect(container.querySelector('.template-site-data-count')?.textContent).toBe('1 item');
  });

  it("leaves every other shell call, and a failed read, to the chat's own row", async () => {
    await render({ status: 'complete', parameters: { command: 'echo hi' }, result: '{"items": []}' });
    expect(container.querySelector('.row')?.textContent).toBe('execute complete');
    expect(container.querySelector('.template-site-data')).toBeNull();
    await render({ status: 'executing', parameters: { command: 'template-cli data' }, result: undefined });
    expect(container.querySelector('.template-site-data')).toBeNull();
    await render({ status: 'complete', parameters: { command: 'template-cli data' }, result: 'Template site sign-in needed.\n[Command failed with exit code 1]' });
    expect(container.querySelector('.template-site-data, [role="alert"]')).toBeNull();
  });

  it('says so when a successful read printed something other than the site data', async () => {
    await render({ status: 'complete', parameters: { command: 'template-cli data' }, result: 'not json' });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Template site data is not JSON');
    await render({ status: 'complete', parameters: { command: 'template-cli data' }, result: '{"items": [{"name": "Sample item"}]}' });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Template site data has no items');
  });

  it("refuses to render without the chat's own row to extend", async () => {
    await act(async () => root.render(<SiteDataResult />));
    const [registered] = kit.registered;
    if (!registered) throw new Error('The renderer registered nothing');
    expect(() => registered.render({ name: 'execute', toolCallId: 'call-1', status: 'complete', parameters: { command: 'echo hi' }, result: '' }))
      .toThrow("The chat registered no tool-call renderer for the template's to extend");
  });
});
