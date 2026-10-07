import type { HttpAgent, Message } from '@ag-ui/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Window as HappyDomWindow } from 'happy-dom';
import type { ButtonHTMLAttributes, ComponentType, ReactElement, ReactNode } from 'react';
import { Component, Fragment, createElement, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthUiState, AuxiliaryPanelHostProps, WebUiPlugin } from '../cartridge/index.js';
import { ChatServiceError, type ConversationEntry, type SavedTurnFailure } from './conversations';

// The CopilotKit boundary: fakes that record what the page hands CopilotKit and render a chat input
// shaped like CopilotChat's (a textarea and a send cell), whose send cell a test can hold back.
const copilot = vi.hoisted(() => ({
  kits: [] as { selfManagedAgents: Record<string, HttpAgent>; properties: Record<string, unknown> }[],
  mounts: 0,
  chat: undefined as Record<string, unknown> | undefined,
  renderTool: undefined as ((props: Record<string, unknown>) => ReactElement) | undefined,
  sendCellShown: true,
  running: false,
  reply: '',
  messages: [] as Message[],
  // Whether the message view lays out a row for each of the open agent's messages, as CopilotKit's does.
  rows: false,
  // Whether each row comes between custom-message slots, as CopilotKit 1.61 lays them out, rendering nothing.
  slots: false,
  rowMounts: 0,
  jumps: 0,
  listeners: new Set<() => void>(),
  runAgent: undefined as unknown as ReturnType<typeof vi.fn<(options: { agent: HttpAgent | undefined }) => void>>,
}));

vi.mock('@copilotkit/react-core/v2', async () => {
  const { Streamdown } = await import('streamdown');
  // Like CopilotChatMessageView: an assistant message slot renders its markdown. It virtualizes a long chat's rows
  // unless a `children` render prop lays out its
  // message elements.
  const MessageRow = ({ id }: { id: string }) => {
    useEffect(() => {
      copilot.rowMounts += 1;
    }, []);
    return <div data-message-row={id} />;
  };
  type MessageViewParts = { messageElements: ReactNode[]; messages: Message[]; isRunning: boolean; interruptElement: ReactNode };
  const CopilotChatMessageView = Object.assign(
    ({ assistantMessage, children }: { assistantMessage?: { markdownRenderer?: ComponentType<{ content: string }> }; children?: (parts: MessageViewParts) => ReactNode }) => {
      const agentMessages = copilot.kits.at(-1)?.selfManagedAgents['research-agent']?.messages ?? [];
      const rows = copilot.rows
        ? agentMessages.flatMap((message) => {
            const row = message.role === 'tool' ? [] : [<MessageRow key={message.id} id={message.id} />];
            return copilot.slots ? [<Fragment key={`${message.id}-custom-before`} />, ...row, <Fragment key={`${message.id}-custom-after`} />] : row;
          })
        : [];
      const Renderer = assistantMessage?.markdownRenderer;
      const messageElements = copilot.reply === '' ? rows : [...rows, Renderer ? <Renderer key="reply" content={copilot.reply} /> : <Streamdown key="reply">{copilot.reply}</Streamdown>];
      const messages = copilot.rows ? agentMessages : copilot.messages;
      if (children) return <>{children({ messageElements, messages, isRunning: copilot.running, interruptElement: null })}</>;
      return <div data-testid="copilot-message-list" data-virtualized>{messageElements}</div>;
    },
    { Cursor: () => <div data-testid="copilot-loading-cursor" /> },
  );
  const CopilotChatInput = ({ isRunning = false, sendButton, addMenuButton, onSubmitMessage, onStop, textArea }: { textArea?: Record<string, unknown>; isRunning?: boolean; sendButton?: Record<string, unknown> | ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>; addMenuButton?: ButtonHTMLAttributes<HTMLButtonElement> | ComponentType; onSubmitMessage?: (message: string) => void; onStop?: () => void }) => {
    const sendCellShown = useSyncExternalStore(
      (listener) => {
        copilot.listeners.add(listener);
        return () => copilot.listeners.delete(listener);
      },
      () => copilot.sendCellShown,
    );
    // Like CopilotChatInput: its text box sits in a centered column inside a full-width container.
    return (
      <div className="cpk:pointer-events-none cpk:relative cpk:z-20">
        <div className="cpk:max-w-3xl cpk:mx-auto cpk:py-0 cpk:px-4 cpk:sm:px-0 cpk:pointer-events-auto">
          <div className="copilotKitInput">
            <div data-layout="compact">
              {sendCellShown && <div className="cpk:col-start-1" data-testid="add-cell">{typeof addMenuButton === 'function' ? createElement(addMenuButton) : <button type="button" disabled aria-label="Add files" {...addMenuButton} />}</div>}
              <textarea aria-label="Message" {...textArea} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !event.shiftKey) { if (isRunning && !event.currentTarget.value.trim()) onStop?.(); else onSubmitMessage?.(event.currentTarget.value); } }} />
              {sendCellShown && (
                <div className="cpk:col-start-3" data-testid="send-cell">
                  {typeof sendButton === 'function'
                    ? createElement(sendButton, { onClick: () => { if (isRunning) onStop?.(); }, children: isRunning ? <svg data-icon="square" /> : undefined })
                    : <button type="button" onClick={() => { if (isRunning) onStop?.(); }} {...sendButton}><svg data-icon={isRunning ? 'square' : 'arrow-up'} /></button>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };
  CopilotChatInput.SendButton = ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" data-testid="copilot-send-button" {...props}>{children ?? <svg data-icon="arrow-up" />}</button>;
  CopilotChatInput.StartTranscribeButton = (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props}><svg data-icon="mic" /></button>;
  const ScrollToBottomButton = (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" data-testid="copilot-scroll-to-bottom" {...props} />;
  // Like CopilotChatView.ScrollView: a StickToBottom that scrolls to the latest message on mount (`initial`) and
  // as the content grows (`resize`), smoothly unless a scroll view slot object overrides them. It scrolls itself; its
  // content wrapper is styled to scroll too, but is as tall as its content, so it never does. Its jump-to-bottom button
  // slot sits beside it, its click CopilotKit's own jump, which here only counts itself.
  const CopilotChatScrollView = ({
    children,
    initial = 'smooth',
    resize = 'smooth',
    scrollToBottomButton: JumpButton = ScrollToBottomButton,
  }: {
    children: ReactNode;
    initial?: unknown;
    resize?: unknown;
    scrollToBottomButton?: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>;
  }) => (
    <>
      <div data-testid="copilot-scroll-view" data-initial={String(initial)} data-resize={String(resize)} style={{ overflowY: 'auto' }}>
        {children}
      </div>
      <JumpButton onClick={() => { copilot.jumps += 1; }} />
    </>
  );
  return {
    CopilotChatAssistantMessage: { MarkdownRenderer: ({ content, ...props }: { content: string }) => <Streamdown {...props}>{content}</Streamdown> },
    CopilotKit: ({ children, ...props }: { children: ReactNode } & (typeof copilot.kits)[number]) => {
      copilot.kits.push(props);
      useEffect(() => {
        copilot.mounts += 1;
      }, []);
      return <>{children}</>;
    },
    // Like CopilotChat: its message view slot, CopilotChatMessageView unless replaced, scrolls in its scroll view
    // slot above an overlay pinned to the chat's bottom, which holds its input slot, CopilotChatInput unless replaced.
    CopilotChat: (
      props: { input?: ComponentType<{ isRunning: boolean }>; messageView?: ComponentType; scrollView?: Record<string, unknown> } & Record<string, unknown>,
    ) => {
      copilot.chat = props;
      const MessageView = props.messageView ?? CopilotChatMessageView;
      const Input = props.input ?? CopilotChatInput;
      return (
        <>
          <CopilotChatScrollView {...props.scrollView}>
            <div data-testid="copilot-scroll-content" style={{ overflowY: 'auto' }}>
              <MessageView />
            </div>
          </CopilotChatScrollView>
          <div data-testid="copilot-input-overlay">
            <Input isRunning={copilot.running} onSubmitMessage={(content: string) => {
              const submittedAgent = copilot.kits.at(-1)?.selfManagedAgents['research-agent'];
              submittedAgent?.addMessage({ id: 'submitted', role: 'user', content });
              copilot.runAgent({ agent: submittedAgent });
            }} />
          </div>
        </>
      );
    },
    CopilotChatInput,
    CopilotChatMessageView,
    CopilotChatView: { ScrollToBottomButton },
    useDefaultRenderTool: (config: { render: typeof copilot.renderTool }, deps?: unknown[]) => {
      useEffect(() => { copilot.renderTool = config.render; }, [JSON.stringify(deps ?? [])]);
    },
    useCopilotKit: () => ({ copilotkit: { runAgent: copilot.runAgent } }),
  };
});

// The cartridge: every slot filled with values unlike the default cartridge's.
const cartridge = vi.hoisted(() => ({
  auth: undefined as unknown as AuthUiState,
  authChatServiceUrl: undefined as string | undefined,
  panels: [] as AuxiliaryPanelHostProps[],
  computerMounts: 0,
}));

vi.mock('@cartridge-ui', () => {
  const webUiPlugin: WebUiPlugin = {
    config: {
      agentId: 'research-agent',
      chatServiceUrl: 'http://chat.test',
      title: 'Research Bot',
      agentName: 'Ada',
      subtitle: 'Ask about markets',
      disclaimer: 'Check your sources.',
      loginLabel: 'Sign in',
      relinkLabel: 'Relink account',
      logoutLabel: 'Sign out',
      accountLabel: 'Research Account',
      agentOptions: {
        effortLevels: [
          { key: 'low', label: 'Low' },
          { key: 'high', label: 'High' },
        ],
        defaultEffort: 'max',
      },
    },
    toolResultRenderers: [() => <p>tool result renderer</p>],
    auxiliaryPanels: [
      (props) => {
        cartridge.panels.push(props);
        return <p>panel for {props.conversation.id}</p>;
      },
    ],
    ComputerView: ({ agentId, agentName, conversation }) => {
      useEffect(() => {
        cartridge.computerMounts += 1;
      }, []);
      return (
        <p>
          {agentName}: {agentId} computer for {conversation.id}
        </p>
      );
    },
    AuthProvider: ({ chatServiceUrl, children }) => {
      cartridge.authChatServiceUrl = chatServiceUrl;
      return <>{children(cartridge.auth)}</>;
    },
    agentProfileTabs: { 'Sign-ins': () => <p>the cartridge&apos;s Sign-ins</p> },
    // Files has no `/missing.svg`.
    fileUrl: (path) => (path === '/missing.svg' ? Promise.reject(new Error('Files download failed: 404')) : Promise.resolve(`https://files.test${path}?signed`)),
    theme: { '--accent': 'rebeccapurple' },
  };
  return { webUiPlugin };
});

const rum = vi.hoisted(() => ({ config: vi.fn(() => null as null | { appMonitorId: string; identityPoolId: string; region: string }), start: vi.fn(() => Promise.resolve()) }));
vi.mock('./rum', () => ({ rumConfig: rum.config, startRum: rum.start }));

const { default: Page } = await import('./page');

function auth(overrides: Partial<AuthUiState> = {}): AuthUiState {
  return {
    sessionStatus: 'ready',
    status: 'authed',
    error: null,
    login: vi.fn(),
    relink: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
}

function sideChat(id: string, title: string): ConversationEntry {
  return { id, title, created_at: '2026-07-01T09:00:00.000Z', updated_at: '2026-07-01T10:00:00.000Z' };
}

/**
 * The Chat Service as the page sees it: the Main Chat, the Side Chats, and each Session's replayed messages. Any other request is a warmup.
 */
const service = {
  mainChat: { id: 'main-1', messages: [] as Message[] } as {
    id: string;
    provider?: string;
    messages: Message[];
    running?: boolean;
    runId?: string;
    failure?: SavedTurnFailure;
  },
  sideChats: [] as ConversationEntry[],
  replies: new Map<string, Message[]>(),
  runIds: new Map<string, string>(),
  /** Each replayed Session's model provider, when it has one. */
  providers: new Map<string, string>(),
  /** The Side Chats whose latest Turn still runs on the server. */
  running: new Set<string>(),
  activity: [] as { title?: string; summary: string; failed?: string; completedAt: string }[],
  scheduled: [] as Record<string, unknown>[],
  /** Requests answered with this status instead. */
  failing: new Map<string, number>(),
  agentIdentity: { name: 'Ada Bot', character: 'A research assistant', vibe: 'Warm', avatar: '' },
  soul: 'Be candid.',
  memory: [] as { id: string; text: string }[],
  agentPicture: null as string | null,
  models: [] as { key: string; label: string; description?: string; provider: string }[],
};

// Each read parses a new body, as fetch does.
const answer = (status: number, body?: unknown) =>
  ({ ok: status < 400, status, json: async () => structuredClone(body) }) as Response;

/** The Chat Service's scheduled-task routes; undefined for any other route. */
function scheduledTasks(route: string, pathname: string, init?: RequestInit): Response | undefined {
  if (route === 'GET /scheduled-tasks') return answer(200, { tasks: service.scheduled });
  if (route === 'POST /scheduled-tasks') {
    return answer(201, { id: 'task-new', ...JSON.parse(init?.body as string), paused: false });
  }
  const task = service.scheduled.find(({ id }) => pathname === `/scheduled-tasks/${String(id)}`);
  if (route.startsWith('PATCH /scheduled-tasks/') && task !== undefined) {
    return answer(200, { ...task, ...JSON.parse(init?.body as string) });
  }
  return undefined;
}

/** The agent's Memory: listed, and each line edited or deleted by its record ID. */
function memoryService(pathname: string, init?: RequestInit): Response {
  const method = init?.method ?? 'GET';
  if (method === 'GET') return answer(200, { lines: service.memory });
  const id = pathname.replace('/agent/memory/', '');
  if (method === 'PUT') {
    const { text } = JSON.parse(init?.body as string) as { text: string };
    service.memory = service.memory.map((line) => (line.id === id ? { ...line, text } : line));
  } else {
    service.memory = service.memory.filter((line) => line.id !== id);
  }
  return answer(204);
}

/** The Agent Profile, and the agent's picture kept on PUT and cleared on DELETE; undefined for any other route. */
function profileService(route: string, init?: RequestInit): Response | undefined {
  if (route === 'GET /agent') {
    const { name, avatar } = service.agentIdentity;
    return answer(200, { name, avatar, picture: service.agentPicture, status: 'online' });
  }
  if (route === 'GET /agent/identity') return answer(200, service.agentIdentity);
  if (route === 'GET /agent/models') return answer(200, { models: service.models });
  if (route === 'GET /agent/soul') return answer(200, { content: service.soul });
  if (!route.endsWith(' /agent/picture')) return undefined;
  service.agentPicture = init?.method === 'PUT' ? (JSON.parse(init.body as string) as { picture: string }).picture : null;
  return answer(204);
}

async function chatService(url: string, init?: RequestInit): Promise<Response> {
  const { pathname } = new URL(url);
  const route = `${init?.method ?? 'GET'} ${pathname}`;
  const failure = service.failing.get(route);
  if (failure !== undefined) return answer(failure);
  if (route === 'GET /main-chat') return answer(200, service.mainChat);
  const profile = profileService(route, init);
  if (profile !== undefined) return profile;
  if (route === 'GET /activity') return answer(200, { tasks: service.activity });
  if (pathname.startsWith('/agent/memory')) return memoryService(pathname, init);
  if (route === 'PUT /agent/identity') {
    service.agentIdentity = JSON.parse(init?.body as string);
    return answer(204);
  }
  if (route === 'PUT /agent/soul') {
    service.soul = (JSON.parse(init?.body as string) as { content: string }).content;
    return answer(204);
  }
  const scheduled = scheduledTasks(route, pathname, init);
  if (scheduled !== undefined) return scheduled;
  if (route === 'GET /threads') {
    return answer(200, { threads: service.sideChats });
  }
  const thread = /^\/threads\/([^/]+)/.exec(pathname)?.[1];
  if (route.startsWith('GET /threads/') && thread !== undefined) {
    return answer(200, { provider: service.providers.get(thread), messages: service.replies.get(thread) ?? [], running: service.running.has(thread), runId: service.runIds.get(thread) });
  }
  return answer(204);
}

/** The paths of the Chat Service requests made so far, warmups and the agent profile left out. */
const requests = () =>
  fetchMock.mock.calls
    .filter(([url]) => url !== 'http://chat.test/warmup' && !url.startsWith('http://chat.test/agent'))
    .map(([url, init]) => `${init?.method ?? 'GET'} ${url.replace('http://chat.test', '')}`);

/** The methods of the requests made to this Chat Service path so far. */
const requestsTo = (path: string) =>
  fetchMock.mock.calls
    .filter(([url]) => url === `http://chat.test${path}`)
    .map(([, init]) => init?.method ?? 'GET');

/** A value the test needs, failing the test by name when it is missing. */
function present<T>(value: T, what: string): NonNullable<T> {
  assert.exists(value, `${what} is missing`);
  return value;
}

const kit = () => present(copilot.kits.at(-1), 'a CopilotKit');
const agent = () => {
  const researchAgent = kit().selfManagedAgents['research-agent'];
  assert.isDefined(researchAgent, 'research-agent is not registered');
  return researchAgent;
};
const sidebar = () => within(present(document.querySelector('aside'), 'the sidebar'));
const recents = () => [...document.querySelectorAll('.sidebar-item-btn')].map((item) => item.textContent);
const welcome = () => document.querySelector('.welcome-screen');
const picker = () => present(present(screen.getByText('Deep').closest('.chat-model-picker'), 'the model picker').parentElement, 'the model picker cell');
const warmups = () => fetchMock.mock.calls
  .filter(([url]) => url === 'http://chat.test/warmup')
  .map(([url, init]) => {
    const request = present(init, 'warmup request');
    if (typeof request.body !== 'string') throw new Error('warmup body is not a string');
    return [url, { ...request, body: request.body }] as const;
  });

async function renderPage(state: AuthUiState = auth()) {
  await import("./chat-surface");
  cartridge.auth = state;
  const view = render(<Page />);
  await settle();
  return view;
}

/** Let the page finish its Chat Service requests. */
async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      // eslint-disable-next-line no-await-in-loop -- each tick lets one more chained request settle
      await Promise.resolve();
    }
  });
}

async function sendMessage(text: string) {
  const textarea = screen.getByLabelText<HTMLTextAreaElement>('Message');
  textarea.value = text;
  fireEvent.keyDown(textarea, { key: 'Enter' });
  await settle();
}

async function agentAddsMessage(message: Message) {
  await act(async () => {
    agent().addMessage(message);
  });
}

let fetchMock: ReturnType<typeof vi.fn<typeof chatService>>;
let uuids: number;

beforeEach(() => {
  localStorage.clear();
  copilot.kits = [];
  copilot.mounts = 0;
  copilot.jumps = 0;
  copilot.chat = undefined;
  copilot.runAgent = vi.fn();
  copilot.renderTool = undefined;
  copilot.sendCellShown = true;
  copilot.running = false;
  copilot.reply = '';
  copilot.messages = [];
  copilot.rows = false;
  copilot.slots = false;
  copilot.rowMounts = 0;
  cartridge.panels = [];
  cartridge.computerMounts = 0;
  service.mainChat = { id: 'main-1', messages: [] };
  service.sideChats = [];
  service.replies = new Map();
  service.providers = new Map();
  service.running = new Set();
  service.activity = [];
  service.scheduled = [];
  service.failing = new Map();
  service.agentIdentity = { name: 'Ada Bot', character: 'A research assistant', vibe: 'Warm', avatar: '' };
  service.soul = 'Be candid.';
  service.agentPicture = null;
  service.models = [
    { key: 'deep', label: 'Deep', description: 'Slower, more thorough', provider: 'anthropic' },
    { key: 'fast', label: 'Fast', provider: 'anthropic' },
  ];
  service.memory = [
    { id: 'mem-copper', text: 'Trades copper futures' },
    { id: 'mem-paris', text: 'Lives in Paris' },
  ];
  window.history.replaceState(null, '', '/');
  uuids = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `new-${++uuids}`);
  fetchMock = vi.fn(chatService);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('cartridge wiring', () => {
  it('runs the chat on the cartridge agent id against the cartridge Chat Service', async () => {
    await renderPage();

    expect(cartridge.authChatServiceUrl).toBe('http://chat.test');
    expect(copilot.chat).toMatchObject({
      agentId: 'research-agent',
      threadId: 'main-1',
      labels: { chatInputPlaceholder: 'Ask anything', chatDisclaimerText: 'Check your sources.' },
    });
    expect(Object.keys(kit().selfManagedAgents).sort()).toEqual(['default', 'research-agent']);
    for (const direct of Object.values(kit().selfManagedAgents)) {
      expect(direct.threadId).toBe('main-1');
      expect(direct.messages).toEqual([]);
      expect(direct.url).toBe('http://chat.test');
    }
  });

  it("offers the account's models and the cartridge effort levels, starting from the first model and the default effort", async () => {
    await renderPage();

    const pill = present(screen.getByText('Deep').closest('button'), 'the model pill');
    expect(pill).toHaveTextContent(/^Deepmax$/);
    expect(kit().properties).toEqual({ model: 'deep', effort: 'max', sandbox: true });

    await userEvent.click(pill);
    expect(
      [...document.querySelectorAll('.mep-dropdown .mep-option-name')].map((option) => option.textContent),
    ).toEqual(['Deep', 'Fast', 'Effort']);
    expect(document.body.textContent).not.toMatch(/sonnet/i);
  });

  it('shows the cartridge panels, result renderers, theme and overlay', async () => {
    await renderPage(auth({ overlay: <p>account overlay</p> }));

    expect(screen.getByText('panel for main-1')).toBeInTheDocument();
    expect(cartridge.panels.at(-1)).toEqual({ agentId: 'research-agent', conversation: { id: 'main-1', service: 'chat-service' } });
    expect(screen.getByText('tool result renderer')).toBeInTheDocument();
    expect(screen.getByText('account overlay')).toBeInTheDocument();
    expect((document.querySelector('.app-layout') as HTMLElement).style.getPropertyValue('--accent')).toBe('rebeccapurple');
  });

  it("puts the cartridge's composer accessory with the composer, above its text box", async () => {
    await renderPage(auth({ composerAccessory: <button type="button">🔒 Sign in</button> }));

    const accessory = screen.getByRole('button', { name: '🔒 Sign in' });
    const textBox = present(screen.getByLabelText('Message').closest('.copilotKitInput'), 'the composer text box');
    expect(accessory.closest('[data-testid="copilot-input-overlay"]')).not.toBeNull();
    expect(textBox.contains(accessory)).toBe(false);
    expect(accessory.compareDocumentPosition(textBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // In the overlay's full width, the chip sat ~15px left of the text box in CopilotChatInput's column.
  it("lines the composer accessory up with the text box, in a column like CopilotChatInput's", async () => {
    await renderPage(auth({ composerAccessory: <button type="button">🔒 Sign in</button> }));

    const box = present(screen.getByRole('button', { name: '🔒 Sign in' }).closest('.composer-accessory'), 'the accessory box');
    const textBox = present(screen.getByLabelText('Message').closest('.copilotKitInput'), 'the composer text box');
    // The column's width and side padding; `.composer-accessory` sizes itself in it as `.copilotKitInput` does.
    const column = (element: Element) =>
      [...(element.parentElement?.classList ?? [])].filter((name) => /^cpk:(sm:)?(max-w|mx|px)-/.test(name));
    expect(column(box)).toEqual(['cpk:max-w-3xl', 'cpk:mx-auto', 'cpk:px-4', 'cpk:sm:px-0']);
    expect(column(box)).toEqual(column(textBox));
  });

  it("warms the requester's agent for the Main Chat as it opens, then for each chat with its model and effort", async () => {
    await renderPage();

    expect(warmups()).toEqual([
      [
        'http://chat.test/warmup',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{"mainChat":true,"effort":"max"}' },
      ],
      [
        'http://chat.test/warmup',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{"threadId":"main-1","model":"deep","effort":"max"}' },
      ],
    ]);

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));

    expect(warmups().at(-1)?.[1].body).toBe('{"threadId":"new-1","model":"deep","effort":"max"}');
  });

  it('serializes Main Chat warmups while its Sandbox provisions, then prepares the selected model', async () => {
    let provisioning = true;
    let finishBoot!: (response: Response) => void;
    let warmupCalls = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup') {
        if (++warmupCalls === 1) return new Promise<Response>((resolve) => { finishBoot = resolve; });
        // Chat Service classifies AgentCore's provisioning conflict (409) as a failed warmup (502).
        if (provisioning) return answer(502);
      }
      return chatService(url, init);
    });

    await renderPage();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(warmups()).toHaveLength(1);
    await act(async () => { provisioning = false; finishBoot(answer(200)); });
    await settle();

    expect(warmups()).toHaveLength(2);
    expect(warmups().at(-1)?.[1].body).toBe('{"threadId":"main-1","model":"deep","effort":"max"}');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the latest selected effort when Main Chat warmups wait for provisioning', async () => {
    let finishBoot!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup' && init?.body === '{"mainChat":true,"effort":"max"}') {
        return new Promise<Response>((resolve) => { finishBoot = resolve; });
      }
      return chatService(url, init);
    });
    await renderPage();
    await userEvent.click(present(document.querySelector<HTMLElement>('.mep-pill'), 'model picker'));
    const dropdown = within(present(document.querySelector<HTMLElement>('.mep-dropdown'), 'model dropdown'));
    await userEvent.click(dropdown.getByText('Effort'));
    await userEvent.click(dropdown.getByText('High'));
    expect(warmups()).toHaveLength(1);

    await act(async () => { finishBoot(answer(200)); });
    await settle();

    expect(warmups()).toHaveLength(2);
    expect(warmups().at(-1)?.[1].body).toBe('{"threadId":"main-1","model":"deep","effort":"high"}');
  });

  it('does not dispatch a queued warmup after an account switch starts before rerender', async () => {
    let current = true;
    let finishBoot!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup' && init?.body === '{"mainChat":true,"effort":"max"}') {
        return new Promise<Response>((resolve) => { finishBoot = resolve; });
      }
      return chatService(url, init);
    });
    await renderPage(Object.assign(auth({ accountId: 'acct-first' }), { isAccountCurrent: () => current }));
    current = false;
    await act(async () => { finishBoot(answer(200)); });
    await settle();

    expect(warmups()).toHaveLength(1);
  });

  it('prepares a Side Chat independently of a provisioning Main Chat', async () => {
    let finishBoot!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup' && init?.body === '{"mainChat":true,"effort":"max"}') {
        return new Promise<Response>((resolve) => { finishBoot = resolve; });
      }
      return chatService(url, init);
    });
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    await settle();

    expect(warmups().at(-1)?.[1].body).toBe('{"threadId":"new-1","model":"deep","effort":"max"}');
    const before = warmups().length;
    await act(async () => { finishBoot(answer(200)); });
    await settle();
    expect(warmups()).toHaveLength(before);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("warms the next account's Main Chat after an account switch", async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    const before = warmups().filter(([, init]) => init.body.includes('"mainChat":true')).length;

    cartridge.auth = auth({ accountId: 'acct-second' });
    view.rerender(<Page />);
    await settle();

    expect(warmups().filter(([, init]) => init.body.includes('"mainChat":true'))).toHaveLength(before + 1);
  });

  it('reports a failed agent warmup while keeping the chat open', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup') throw new Error('offline');
      return chatService(url, init);
    });

    await renderPage();

    expect(screen.getByText('Research Bot', { selector: '.welcome-title' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Your agent could not be prepared: offline');

    fetchMock.mockImplementation(chatService);
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("lets only the latest warmup report, so an older one's failure does not hide a newer success", async () => {
    const pending: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup') return new Promise<Response>((resolve) => pending.push(resolve));
      return chatService(url, init);
    });
    await renderPage();
    const older = pending.splice(0);

    fetchMock.mockImplementation(chatService);
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    await settle();
    await act(async () => { for (const finish of older) finish(answer(502)); });

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not show a previous account warmup failure on the current account', async () => {
    const pending: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup' && cartridge.auth.accountId === 'acct-first') {
        return new Promise<Response>((resolve) => pending.push(resolve));
      }
      return chatService(url, init);
    });
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    expect(pending).toHaveLength(1);

    cartridge.auth = auth({ accountId: 'acct-second' });
    view.rerender(<Page />);
    await settle();
    await act(async () => { for (const finish of pending) finish(answer(502)); });

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports an agent build the warmup rejects with 502', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup') return answer(502);
      return chatService(url, init);
    });

    await renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('Your agent could not be prepared: Failed to prepare the agent: 502');
  });
});

describe('account session gate', () => {
  it.each(['loading', 'parked', 'error'] as const)('shows only the session gate while the session is %s', async (sessionStatus) => {
    await renderPage(auth({ sessionStatus }));

    expect(document.querySelector('.account-session-gate')).toHaveTextContent(/^Research Bot/);
    expect(document.querySelector('aside')).toBeNull();
    expect(copilot.chat).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens the Main Chat once the session is ready', async () => {
    const view = await renderPage(auth({ sessionStatus: 'loading' }));

    cartridge.auth = auth();
    view.rerender(<Page />);
    await settle();

    expect(document.querySelector('.account-session-gate')).toBeNull();
    expect(copilot.chat?.threadId).toBe('main-1');
    expect(requests()).toEqual(['GET /main-chat', 'GET /threads']);
  });
});

describe('welcome screen', () => {
  it('greets a signed-in user by first name', async () => {
    await renderPage(auth({ user: { name: 'Ada Lovelace' } }));

    expect(welcome()).toHaveTextContent(/^Hi Ada, how can I help you\?$/);
  });

  it('invites a user without a name to message, with the cartridge title and subtitle', async () => {
    await renderPage();

    expect(welcome()).toHaveTextContent(/^Research BotAsk about markets$/);
  });

  it.each([
    ['signed out', 'unauthed'],
    ['signing in', 'loading'],
    ['whose sign-in failed', 'error'],
  ] as const)('offers no sign-in to a user %s', async (_, status) => {
    await renderPage(auth({ status, error: status === 'error' ? 'Account locked' : null }));

    expect(welcome()).toHaveTextContent(/^Research BotAsk about markets$/);
    expect(within(welcome() as HTMLElement).queryByRole('button')).toBeNull();
  });
});

describe('account errors in a conversation', () => {
  async function renderConversation(state: AuthUiState) {
    await renderPage(state);
    await sendMessage('What moved rates?');
  }
  const header = () => present(document.querySelector('main > header'), "the chat's header");

  it('offers a signed-out user no sign-in in the chat', async () => {
    await renderConversation(auth({ status: 'unauthed' }));

    expect(within(present(document.querySelector('main'), 'the chat')).queryByText('Sign in')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['signed out', 'unauthed', 'Account locked'],
    ['whose sign-in failed', 'error', 'Provider sign-in failed'],
    ['signed in', 'authed', 'Logout failed'],
  ] as const)('shows a user %s the account error below the header', async (_, status, error) => {
    await renderConversation(auth({ status, error }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(new RegExp(`^${error}$`));
    expect(header().nextElementSibling).toBe(alert);
  });

  it('shows the account error on the empty chat too', async () => {
    await renderPage(auth({ status: 'unauthed', error: 'Account locked' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/^Account locked$/);
  });
});

describe('sending a message', () => {
  it("names CopilotChat's icon-only send button Stop while the agent runs", async () => {
    const idle = await renderPage();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    idle.unmount();

    copilot.running = true;
    await renderPage();

    expect(within(screen.getByTestId('send-cell')).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  // The send-acknowledged moment runs from the send to the running cursor.
  it('times a send until the running cursor shows', async () => {
    performance.clearMeasures();
    copilot.runAgent = vi.fn(() => {
      copilot.running = true;
    });
    await renderPage();
    expect(performance.getEntriesByName('latency:send-acknowledged', 'measure')).toEqual([]);

    await sendMessage('What moved rates?');

    expect(screen.getByTestId('copilot-loading-cursor')).toBeInTheDocument();
    expect(performance.getEntriesByName('latency:send-acknowledged', 'measure')).toHaveLength(1);
  });

  it('hides the welcome screen and refreshes the Side Chats at once and a second later', async () => {
    vi.useFakeTimers();
    await renderPage();

    await sendMessage('  What moved rates?  ');
    expect(welcome()).toBeNull();
    expect(requests()).toEqual(['GET /main-chat', 'GET /threads', 'GET /threads']);

    service.sideChats = [sideChat('other-tab', 'From another tab')];
    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    await settle();
    expect(recents()).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await settle();
    expect(recents()).toEqual(['From another tab']);
  });

  it('refreshes the Side Chats only for the first message of a conversation', async () => {
    vi.useFakeTimers();
    await renderPage();
    await sendMessage('first');
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await settle();

    service.sideChats = [sideChat('other-tab', 'From another tab')];
    await sendMessage('second');
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await settle();

    expect(recents()).toEqual([]);
  });

  it('drops the second refresh once the chat is gone', async () => {
    vi.useFakeTimers();
    const { unmount } = await renderPage();
    await sendMessage('What moved rates?');
    unmount();

    vi.advanceTimersByTime(1000);
    await settle();

    expect(requests()).toEqual(['GET /main-chat', 'GET /threads', 'GET /threads']);
  });

  it.each([
    ['an empty message', '   ', {}],
    ['a line break', 'draft', { shiftKey: true }],
  ])('does not count %s as sent', async (_case, text, modifiers) => {
    await renderPage();
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Message');
    textarea.value = text;

    fireEvent.keyDown(textarea, { key: 'Enter', ...modifiers });

    expect(welcome()).not.toBeNull();
  });

  it('does not count other keys as sending', async () => {
    await renderPage();
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Message');
    textarea.value = 'draft';

    fireEvent.keyDown(textarea, { key: 'a' });

    expect(welcome()).not.toBeNull();
  });
});

describe('an assistant reply of a bare list marker', () => {
  // Markdown parses a line that is only "4." as an empty list item, so the answer "4." showed an empty list.
  it.each(['4.', '2026.', '-'])('shows %s as text, not an empty list', async (reply) => {
    copilot.reply = reply;

    await renderPage();

    const messages = screen.getByTestId('copilot-message-list');
    expect(within(messages).queryByRole('list')).toBeNull();
    expect(messages.textContent).toBe(reply);
  });

  it('keeps a list whose items have text a list', async () => {
    copilot.reply = '1. foo\n2. bar';

    await renderPage();

    const messages = screen.getByTestId('copilot-message-list');
    expect(within(messages).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['foo', 'bar']);
  });
});

// Markdown joins single-newline lines into one paragraph, so a 4-line poem showed as one run-on line.
it('keeps each line of an assistant reply on its own line', async () => {
  copilot.reply = 'Beneath the yield\nThe coupon paid';

  await renderPage();

  const paragraph = within(screen.getByTestId('copilot-message-list')).getByText(/Beneath the yield/);
  expect(paragraph.innerHTML).toBe('Beneath the yield<br>\nThe coupon paid');
});

// A Turn the agent failed (RUN_ERROR) reached CopilotKit's onError, which the page left unset.
describe('a failed Turn', () => {
  const failTurn = async (message: string) => {
    const onError = present(copilot.chat?.onError, 'the chat onError') as (event: { error: Error; code: string }) => void;
    await act(async () => {
      onError({ error: new Error(message), code: 'agent_run_error_event' });
    });
  };

  it('shows why the Turn failed in the chat', async () => {
    await renderPage();
    await sendMessage('remind me to stretch');

    await failTurn('ValidationException: toolResult blocks exceed toolUse blocks');

    expect(screen.getByRole('alert')).toHaveTextContent('ValidationException: toolResult blocks exceed toolUse blocks');
  });

  it('shows a content load failure for a DOM error event', async () => {
    await renderPage();
    const onError = present(copilot.chat?.onError, 'the chat onError') as (event: { type: string }) => void;

    await act(async () => onError({ type: 'error' }));

    expect(screen.getByRole('alert')).toHaveTextContent('The agent could not answer: Chat content failed to load');
  });

  // Pinned over the chat, the error covered the user's message just above it.
  it('shows the error in the message flow, below the messages', async () => {
    await renderPage();
    await sendMessage('remind me to stretch');

    await failTurn('the run failed');

    const alert = screen.getByRole('alert');
    expect(alert.previousElementSibling).toBe(screen.getByTestId('copilot-message-list'));
    expect(screen.getByTestId('copilot-scroll-content').contains(alert)).toBe(true);
  });

  // A Stop the server takes ends the Turn's stream with the Harness's TURN_STOPPED run error, which a newer
  // Turn replacing this one also sends.
  it.each([
    ['shows nothing when the Harness ends the Turn the user stopped here', true, null],
    ['says why when a newer Turn replaced the one streaming here', false, /^The agent could not answer: The Turn was stopped, or a newer Turn on this Session replaced it$/],
  ])('%s', async (_label, stoppedHere, alert) => {
    await renderPage();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' ? new Promise<Response>(() => undefined) : chatService(url, init),
    );
    void agent().runAgent().catch(() => undefined);
    await settle();
    if (stoppedHere) agent().abortRun();

    const onError = present(copilot.chat?.onError, 'the chat onError') as (event: { error: Error; code: string }) => void;
    await act(async () => {
      onError({
        error: Object.assign(new Error('The Turn was stopped, or a newer Turn on this Session replaced it'), { code: 'TURN_STOPPED' }),
        code: 'agent_run_error_event',
      });
    });

    if (alert === null) expect(screen.queryByRole('alert')).toBeNull();
    else expect(screen.getByRole('alert')).toHaveTextContent(alert);
  });

  // Stop aborts the Turn's stream; Chrome reports that as an AbortError, which is no failure to explain.
  it('shows nothing when the user stopped the Turn', async () => {
    await renderPage();
    await sendMessage('summarize six pages');

    const onError = present(copilot.chat?.onError, 'the chat onError') as (event: { error: Error; code: string }) => void;
    await act(async () => {
      onError({ error: new DOMException('BodyStreamBuffer was aborted', 'AbortError'), code: 'agent_run_failed_event' });
    });

    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Enter and CopilotChat's Send button both submit by adding the user's message to the agent.
  it('clears the error when the next message is sent', async () => {
    await renderPage();
    await failTurn('the run failed');

    await agentAddsMessage({ id: 'retry', role: 'user', content: 'try again' });
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Offline, the send's fetch rejects with the browser's raw TypeError, and the message was lost.
  it('says the Chat Service could not be reached, and resends the message on Retry', async () => {
    await renderPage();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await sendMessage('What is 2+2? One word.');
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(agent().messages).not.toContainEqual(expect.objectContaining({ content: 'What is 2+2? One word.' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/^Couldn't reach Research Bot\. Check your connection\.$/);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(copilot.runAgent).not.toHaveBeenCalled();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(copilot.runAgent).toHaveBeenCalledExactlyOnceWith({ agent: agent() });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a question after a 502 with actionable copy and no resend', async () => {
    await renderPage();
    const question = 'Without using any tools: reply with just the word DELTA.';
    await sendMessage(question);
    await act(async () => { agent().setMessages([]); });
    const onError = present(copilot.chat?.onError, 'the chat onError') as (event: { error: Error; code: string }) => void;
    await act(async () => {
      const error = Object.assign(new Error('HTTP 502: {"message":"Bad Gateway"}'), { status: 502 });
      onError({ error, code: 'agent_run_failed_event' });
      onError({ error, code: 'agent_run_failed' });
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/^Research Bot couldn't confirm your message was received\. Check this chat before sending it again\.$/);
    expect(screen.getByText(question)).toBeVisible();
    expect(present(document.querySelector('.chat-failed-question'), 'the retained question')).toHaveTextContent(question);
    expect(screen.getByText(question)).toHaveStyle({ whiteSpace: 'pre-wrap' });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(copilot.runAgent).toHaveBeenCalledExactlyOnceWith({ agent: agent() });
  });

  it.each([new TypeError('Failed to fetch'), ...[502, 503, 504].map((status) => Object.assign(new Error(`HTTP ${status}`), { status }))])(
    'does not resend a dispatched Turn whose accepted response was lost: %s', async (error) => {
    await renderPage();
    await sendMessage('create one scheduled reminder');
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const onError = present(copilot.chat?.onError, 'the chat onError') as (event: { error: Error; code: string }) => void;
    await act(async () => {
      onError({ error, code: 'agent_run_failed_event' });
    });

    expect(screen.getByRole('alert')).toHaveTextContent(error instanceof TypeError
      ? `The agent could not answer: ${error.message}`
      : "Research Bot couldn't confirm your message was received. Check this chat before sending it again.");
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(copilot.runAgent).toHaveBeenCalledExactlyOnceWith({ agent: agent() });
  });

  it('keeps recovery text after saved history replaces messages, then clears it on the next send', async () => {
    await renderPage();
    await sendMessage('original question');
    const onError = present(copilot.chat?.onError, 'the chat onError') as (event: { error: Error; code: string }) => void;
    await act(async () => {
      onError({ error: Object.assign(new Error('HTTP 502'), { status: 502 }), code: 'agent_run_failed_event' });
      agent().setMessages([]);
    });

    expect(screen.getByText('original question')).toBeVisible();
    await sendMessage('new intentional question');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('.chat-failed-question')).toBeNull();
    expect(agent().messages).toEqual([{ id: 'submitted', role: 'user', content: 'new intentional question' }]);
  });

  it('does not carry a failed question into a new chat', async () => {
    await renderPage();
    await sendMessage('original question');
    const onError = present(copilot.chat?.onError, 'the chat onError') as (event: { error: Error; code: string }) => void;
    await act(async () => {
      onError({ error: Object.assign(new Error('HTTP 502'), { status: 502 }), code: 'agent_run_failed_event' });
    });
    expect(document.querySelector('.chat-failed-question')).toHaveTextContent('original question');

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    expect(document.querySelector('.chat-failed-question')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves an agent diagnosis that mentions HTTP 502', async () => {
    await renderPage();
    const onError = present(copilot.chat?.onError, 'the chat onError') as (event: { error: Error; code: string }) => void;
    await act(async () => {
      onError({ error: Object.assign(new Error('The tool returned HTTP 502'), { status: 502 }), code: 'agent_run_error_event' });
    });

    expect(screen.getByRole('alert')).toHaveTextContent('The agent could not answer: The tool returned HTTP 502');
    expect(document.querySelector('.chat-failed-question')).toBeNull();
  });

  it('offers no Retry for a Turn the agent failed', async () => {
    await renderPage();
    await failTurn('the run failed');

    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('keeps the error when a non-user message arrives', async () => {
    await renderPage();
    await failTurn('the run failed');

    await agentAddsMessage({ id: 'later', role: 'assistant', content: 'still thinking' });
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('the run failed');
  });
});

describe('an assistant reply', () => {
  // Streamdown showed a citation whose link is no URL, such as a ref, as "[3] [blocked]".
  it('shows a citation to a ref as its text alone, and keeps a URL a link', async () => {
    copilot.reply = 'See [[3]](@s1.c3) and [the docs](https://example.com).';

    await renderPage();

    const messages = screen.getByTestId('copilot-message-list');
    await waitFor(() => expect(messages).toHaveTextContent(/^See \[3\] and the docs\.$/));
    expect(within(messages).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['https://example.com/']);
  });

  it('keeps unsafe URLs and HTML inert while showing their link text', async () => {
    copilot.reply = '[unsafe](javascript:alert%281%29) <a href="javascript:alert(1)">raw</a> and [the docs](https://example.com).';

    await renderPage();

    const messages = screen.getByTestId('copilot-message-list');
    await waitFor(() => expect(messages).toHaveTextContent(/^unsafe raw and the docs\.$/));
    expect(within(messages).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(['https://example.com/']);
  });

  // A chart the agent wrote to its files, embedded by its path, loaded from the web's own origin and 404ed.
  it("shows an image it embeds by a path from the agent's files", async () => {
    copilot.reply = '![SPX closes](/spx-closes.svg)';

    await renderPage();

    const image = await within(screen.getByTestId('copilot-message-list')).findByRole('img', { name: 'SPX closes' });
    await waitFor(() => expect(image).toHaveAttribute('src', 'https://files.test/spx-closes.svg?signed'));
  });

  it('shows and downloads an image embedded by a bare file name', async () => {
    copilot.reply = '![Japan versus Germany headline inflation over the last three years](japan-germany-headline-inflation.svg)\n\n[Download the SVG image](japan-germany-headline-inflation.svg)';

    await renderPage();

    const messages = screen.getByTestId('copilot-message-list');
    expect(await within(messages).findByRole('img', { name: 'Japan versus Germany headline inflation over the last three years' })).toHaveAttribute('src', 'https://files.test/japan-germany-headline-inflation.svg?signed');
    expect(await within(messages).findByRole('link', { name: 'Download the SVG image' })).toHaveAttribute('href', 'https://files.test/japan-germany-headline-inflation.svg?signed');
  });

  it('loads encoded bare file names from Files', async () => {
    copilot.reply = '![Chart](chart%20one.svg)\n\n[Download](chart%20one.svg)';
    await renderPage();
    const list = screen.getByTestId('copilot-message-list');
    expect(await within(list).findByRole('img', { name: 'Chart' })).toHaveAttribute('src', 'https://files.test/chart%20one.svg?signed');
    expect(await within(list).findByRole('link', { name: 'Download' })).toHaveAttribute('href', 'https://files.test/chart%20one.svg?signed');
  });

  it('keeps unsafe paths and unrelated relative references out of Files', async () => {
    const { webUiPlugin } = await import('@cartridge-ui');
    const lookup = vi.spyOn(webUiPlugin, 'fileUrl');
    copilot.reply = ['../chart.svg', '%2e%2e%2fchart.svg', '/%2e%2e/chart.svg', '//external.test/chart.svg', 'folder/chart.svg', 'chart.svg?query', 'chart.svg#fragment', 'bad%ZZ.svg', 'javascript:alert%281%29', 'data:image/svg+xml,evil', '@s1.c3', 'reference'].map((path, index) => `![unsafe ${index}](${path}) [unsafe ${index}](${path})`).join('\n\n') + '\n\n![Safe](safe.svg) [Safe download](safe.svg)';
    await renderPage();
    const list = screen.getByTestId('copilot-message-list');
    expect(await within(list).findByRole('img', { name: 'Safe' })).toHaveAttribute('src', 'https://files.test/safe.svg?signed');
    expect(await within(list).findByRole('link', { name: 'Safe download' })).toHaveAttribute('href', 'https://files.test/safe.svg?signed');
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenNthCalledWith(1, '/safe.svg');
    expect(lookup).toHaveBeenNthCalledWith(2, '/safe.svg');
    expect(within(list).getAllByRole('img')).toHaveLength(1);
    expect(within(list).getAllByRole('link')).toHaveLength(1);
  });

  it('preserves external images and links without a Files lookup', async () => {
    const { webUiPlugin } = await import('@cartridge-ui');
    const lookup = vi.spyOn(webUiPlugin, 'fileUrl');
    copilot.reply = '![External](https://example.com/chart.svg) [External download](https://example.com/chart.svg)';
    await renderPage();
    const list = screen.getByTestId('copilot-message-list');
    expect(await within(list).findByRole('img', { name: 'External' })).toHaveAttribute('src', 'https://example.com/chart.svg');
    expect(within(list).getByRole('link', { name: 'External download' })).toHaveAttribute('href', 'https://example.com/chart.svg');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('names a missing bare file for both its image and download', async () => {
    copilot.reply = '![Missing](missing.svg) [Download missing](missing.svg)';
    await renderPage();
    const list = screen.getByTestId('copilot-message-list');
    await waitFor(() => expect(within(list).getAllByRole('alert')).toHaveLength(2));
    expect(list).toHaveTextContent('Missing could not load: Files download failed: 404');
    expect(list).toHaveTextContent('Download missing could not download: Files download failed: 404');
    expect(within(list).queryByRole('img')).toBeNull();
    expect(within(list).queryByRole('link')).toBeNull();
  });

  it('requests a fresh URL when a file download link is clicked', async () => {
    const { webUiPlugin } = await import('@cartridge-ui');
    const lookup = vi.spyOn(webUiPlugin, 'fileUrl');
    assert(webUiPlugin.fileUrl);
    vi.mocked(webUiPlugin.fileUrl).mockResolvedValueOnce('https://files.test/chart.svg?initial').mockRejectedValueOnce(new Error('Files download failed: 403'));
    copilot.reply = '[Download chart](chart.svg)';
    await renderPage();
    const list = screen.getByTestId('copilot-message-list');
    const link = await within(list).findByRole('link', { name: 'Download chart' });
    expect(link).toHaveAttribute('href', 'https://files.test/chart.svg?initial');
    await userEvent.click(link);
    expect(await within(list).findByRole('alert')).toHaveTextContent('Download chart could not download: Files download failed: 403');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each(['/', ''])('shows an image once its streamed %s file path is complete', async (prefix) => {
    const markdown = `![Japan versus Germany headline inflation](${prefix}japan-germany-headline-inflation.svg)`;
    copilot.reply = markdown.slice(0, markdown.indexOf(']') + 1);
    const view = await renderPage();
    for (let length = copilot.reply.length + 1; length <= markdown.length; length += 1) {
      copilot.reply = markdown.slice(0, length);
      view.rerender(<Page />);
      // eslint-disable-next-line no-await-in-loop -- each streamed prefix must render before the next one
      await settle();
    }
    expect(await within(screen.getByTestId('copilot-message-list')).findByRole('img', { name: 'Japan versus Germany headline inflation' })).toHaveAttribute('src', 'https://files.test/japan-germany-headline-inflation.svg?signed');
  });

  it("names an image from the agent's files that could not load, in place of a broken image", async () => {
    copilot.reply = '![SPX closes](/missing.svg)';

    await renderPage();

    const list = screen.getByTestId('copilot-message-list');
    expect(await within(list).findByRole('alert')).toHaveTextContent('SPX closes could not load: Files download failed: 404');
    expect(within(list).queryByRole('img')).toBeNull();
  });

  it("names an image from the agent's files the browser could not show, in place of a broken image", async () => {
    copilot.reply = '![SPX closes](/spx-closes.svg)';

    await renderPage();

    const list = screen.getByTestId('copilot-message-list');
    fireEvent.error(await within(list).findByRole('img', { name: 'SPX closes' }));
    expect(await within(list).findByRole('alert')).toHaveTextContent('SPX closes could not load: the browser could not show it');
    expect(within(list).queryByRole('img')).toBeNull();
  });

  it('recovers a live chart image when the Turn finishes', async () => {
    copilot.running = true;
    copilot.reply = '![Japan versus Germany headline inflation](/japan-germany-headline-inflation.svg)';
    const view = await renderPage();
    const list = screen.getByTestId('copilot-message-list');
    fireEvent.error(await within(list).findByRole('img', { name: 'Japan versus Germany headline inflation' }));
    expect(await within(list).findByRole('alert')).toHaveTextContent('Japan versus Germany headline inflation could not load: the browser could not show it');

    copilot.running = false;
    view.rerender(<Page />);
    await settle();

    expect(await within(list).findByRole('img', { name: 'Japan versus Germany headline inflation' })).toHaveAttribute('src', 'https://files.test/japan-germany-headline-inflation.svg?signed');
  });

  it('recovers a browser failure arriving just after the Turn finishes', async () => {
    copilot.running = true;
    copilot.reply = '![Chart](/chart.svg)';
    const view = await renderPage();
    const list = screen.getByTestId('copilot-message-list');
    const initialImage = await within(list).findByRole('img', { name: 'Chart' });
    copilot.running = false;
    view.rerender(<Page />);
    await settle();
    fireEvent.error(initialImage);
    await settle();
    expect(await within(list).findByRole('img', { name: 'Chart' })).toHaveAttribute('src', 'https://files.test/chart.svg?signed');
    expect(within(list).getByRole('img', { name: 'Chart' })).not.toBe(initialImage);
  });

  it('keeps the final browser failure visible and does not retry another Turn', async () => {
    copilot.running = true;
    copilot.reply = '![Chart](/chart.svg)';
    const view = await renderPage();
    const list = screen.getByTestId('copilot-message-list');
    fireEvent.error(await within(list).findByRole('img', { name: 'Chart' }));
    copilot.running = false;
    view.rerender(<Page />);
    await settle();
    const refreshed = await within(list).findByRole('img', { name: 'Chart' });
    expect(refreshed).toHaveAttribute('src', 'https://files.test/chart.svg?signed');
    fireEvent.error(refreshed);
    copilot.running = true;
    view.rerender(<Page />);
    await settle();
    copilot.running = false;
    view.rerender(<Page />);
    await settle();
    expect(await within(list).findByRole('alert')).toHaveTextContent('Chart could not load: the browser could not show it');
    expect(within(list).queryByRole('img')).toBeNull();
  });

  it('keeps a failed refreshed file lookup visible', async () => {
    const { webUiPlugin } = await import('@cartridge-ui');
    vi.spyOn(webUiPlugin, 'fileUrl');
    assert(webUiPlugin.fileUrl);
    vi.mocked(webUiPlugin.fileUrl).mockResolvedValueOnce('https://files.test/chart.svg?signed').mockRejectedValueOnce(new Error('Files download failed: 403'));
    copilot.running = true;
    copilot.reply = '![Chart](/chart.svg)';
    const view = await renderPage();
    const list = screen.getByTestId('copilot-message-list');
    fireEvent.error(await within(list).findByRole('img', { name: 'Chart' }));
    copilot.running = false;
    view.rerender(<Page />);
    expect(await within(list).findByText('Chart could not load: Files download failed: 403')).toHaveAttribute('role', 'alert');
    expect(within(list).queryByRole('img')).toBeNull();
  });

  it('keeps a healthy live image when the Turn finishes without another lookup', async () => {
    const { webUiPlugin } = await import('@cartridge-ui');
    const lookup = vi.spyOn(webUiPlugin, 'fileUrl');
    copilot.running = true;
    copilot.reply = '![Chart](/chart.svg)';
    const view = await renderPage();
    const list = screen.getByTestId('copilot-message-list');
    const image = await within(list).findByRole('img', { name: 'Chart' });
    fireEvent.load(image);
    copilot.running = false;
    view.rerender(<Page />);
    await settle();
    expect(within(list).getByRole('img', { name: 'Chart' })).toHaveAttribute('src', 'https://files.test/chart.svg?signed');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps an idle history image failure through a later Turn', async () => {
    copilot.reply = '![Chart](/chart.svg)';
    const view = await renderPage();
    const list = screen.getByTestId('copilot-message-list');
    const image = await within(list).findByRole('img', { name: 'Chart' });
    expect(image).toHaveAttribute('src', 'https://files.test/chart.svg?signed');
    copilot.running = true;
    view.rerender(<Page />);
    fireEvent.error(image);
    copilot.running = false;
    view.rerender(<Page />);
    await settle();
    expect(await within(list).findByRole('alert')).toHaveTextContent('Chart could not load: the browser could not show it');
    expect(within(list).queryByRole('img')).toBeNull();
  });

  it('keeps an image whose download failed, and names the failure', async () => {
    copilot.reply = '![logo](https://example.com/logo.png)';
    await renderPage();
    const chatService = present(fetchMock.getMockImplementation(), 'the Chat Service');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (url === 'https://example.com/logo.png' ? Promise.reject(new TypeError('Failed to fetch')) : chatService(url, init)));

    const list = screen.getByTestId('copilot-message-list');
    await userEvent.click(await within(list).findByTitle('Download image'));

    expect(await within(list).findByRole('alert')).toHaveTextContent('logo could not download: Failed to fetch');
    expect(within(list).getByRole('img', { name: 'logo' })).toHaveAttribute('src', 'https://example.com/logo.png');
  });

  it('keeps an image it embeds by a URL as it is', async () => {
    copilot.reply = '![logo](https://example.com/logo.png)';

    await renderPage();

    const image = await within(screen.getByTestId('copilot-message-list')).findByRole('img', { name: 'logo' });
    expect(image).toHaveAttribute('src', 'https://example.com/logo.png');
  });
});

/** Where the page keeps its Main Chat copy in this browser. */
const KEY = 'botcube.main-chat';

describe('Main Chat kept in this browser', () => {
  const earlier: Message[] = [
    { id: 'm1', role: 'user', content: 'Earlier question' },
    { id: 'm2', role: 'assistant', content: 'Earlier answer' },
  ];
  const holdMainChat = () => {
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    return held;
  };
  const kept = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown;

  // The Main Chat waited on its load, about 2 s, before showing any of its history.
  it('shows the copy it kept of the Main Chat at once, then the loaded one, on the same agent', async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', provider: 'openai', messages: earlier }));
    const held = holdMainChat();

    await renderPage(auth({ accountId: 'acct-first' }));

    expect(copilot.chat?.threadId).toBe('main-1');
    expect(agent().messages).toEqual(earlier);
    expect(welcome()).toBeNull();
    const shown = agent();
    const reply: Message = { id: 'm3', role: 'assistant', content: 'A scheduled post' };
    await act(async () => {
      present(held[0], 'the Main Chat load')(answer(200, { id: 'main-1', provider: 'openai', messages: [...earlier, reply] }));
    });
    await settle();
    expect(agent()).toBe(shown);
    expect(agent().messages).toEqual([...earlier, reply]);
    expect(kept()).toEqual({ accountId: 'acct-first', id: 'main-1', provider: 'openai', messages: [...earlier, reply] });
  });

  // The copy reconciled history but discarded the server Turn and its failure.
  it.each([false, true])('keeps Stop available when the Main Chat loads an active server Turn (copy: %s)', async (copy) => {
    if (copy) localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', provider: 'openai', messages: earlier }));
    service.mainChat = { id: 'main-1', provider: 'openai', messages: earlier, running: true, runId: 'background-run' };
    await renderPage(auth({ accountId: 'acct-first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/threads/main-1/stop', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ runId: 'background-run' }),
    }));
  });

  it.each(['', '  '])('keeps an active Turn running on empty Enter (%j) and stops it only with Stop', async (content) => {
    service.mainChat = { id: 'main-1', provider: 'openai', messages: earlier, running: true, runId: 'background-run' };
    await renderPage(auth({ accountId: 'acct-first' }));
    const stopsSent = () => fetchMock.mock.calls.filter(([url]) => url === 'http://chat.test/threads/main-1/stop').map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown);
    const composer = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(composer, { target: { value: content } });
    expect(fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: 'Enter', keyCode: 229 })).toBe(true);
    fireEvent.keyDown(composer, { key: 'Enter' });
    await settle();
    expect(stopsSent()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    expect(stopsSent()).toEqual([{ runId: 'background-run' }]);
  });

  it('reloads an active server Turn after reconciling the Main Chat copy', async () => {
    vi.useFakeTimers();
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: earlier }));
    service.mainChat = { id: 'main-1', messages: earlier, running: true, runId: 'background-run' };
    await renderPage(auth({ accountId: 'acct-first' }));
    const reply: Message = { id: 'new-reply', role: 'assistant', content: 'The completed answer' };
    service.mainChat = { id: 'main-1', messages: [...earlier, reply], running: false };
    await act(async () => { vi.advanceTimersByTime(3_000); });
    await settle();
    expect(agent().messages).toEqual([...earlier, reply]);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('shows a saved Turn failure when reconciling the Main Chat copy', async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: earlier }));
    service.mainChat = { id: 'main-1', messages: earlier, failure: { runId: 'failed-run', code: 'PROVIDER_ERROR', message: 'The provider failed' } };
    await renderPage(auth({ accountId: 'acct-first' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The agent could not answer: The provider failed');
  });

  it('preserves a newer local Turn when the held Main Chat copy load answers', async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: earlier }));
    const held = holdMainChat();
    await renderPage(auth({ accountId: 'acct-first' }));
    const shown = agent();
    const question: Message = { id: 'new-question', role: 'user', content: 'A new question' };
    shown.addMessage(question);
    const heldService = present(fetchMock.getMockImplementation(), 'held Chat Service');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' && new URL(url).pathname === '/'
        ? new Response([
            { type: 'RUN_STARTED', threadId: shown.threadId, runId: 'new-run' },
            { type: 'RUN_FINISHED', threadId: shown.threadId, runId: 'new-run' },
          ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
        : heldService(url, init),
    );
    await act(async () => { await shown.runAgent({ runId: 'new-run' }); });
    await act(async () => {
      present(held[0], 'old Main Chat load')(answer(200, {
        id: 'main-1', messages: earlier, running: true, runId: 'older-run',
        failure: { runId: 'older-run', code: 'PROVIDER_ERROR', message: 'Old failure' },
      }));
    });
    await settle();
    expect(agent()).toBe(shown);
    expect(shown.messages).toContainEqual(question);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a copy only of its latest Turns', async () => {
    service.mainChat = {
      id: 'main-1',
      messages: Array.from({ length: 120 }, (_, index): Message => ({ id: `m${index}`, role: index % 3 ? 'assistant' : 'user', content: `Message ${index}` })),
    };

    await renderPage(auth({ accountId: 'acct-first' }));

    const { messages } = kept() as { messages: Message[] };
    // The copy starts at a Turn's first message, so no reply is kept without the question it answers.
    expect(messages.map(({ id }) => id)).toEqual(Array.from({ length: 39 }, (_, index) => `m${81 + index}`));
  });

  it('keeps no Turn too large for its copy', async () => {
    service.mainChat = {
      id: 'main-1',
      messages: [
        { id: 'u1', role: 'user', content: 'Long question' },
        { id: 'a1', role: 'assistant', content: 'x'.repeat(1_000_000) },
        { id: 'u2', role: 'user', content: 'Short question' },
        { id: 'a2', role: 'assistant', content: 'Short answer' },
      ],
    };

    await renderPage(auth({ accountId: 'acct-first' }));
    expect((kept() as { messages: Message[] }).messages.map(({ id }) => id)).toEqual(['u2', 'a2']);

    service.mainChat = { id: 'main-1', messages: [...service.mainChat.messages, { id: 'a3', role: 'assistant', content: 'y'.repeat(1_000_000) }] };
    await userComesBack('focus');
    expect(kept()).toBeNull();
  });

  it('opens the Main Chat when this browser blocks its storage, saying why in the console', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const blocked = new DOMException('The operation is insecure.', 'SecurityError');
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw blocked; });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw blocked; });
    service.mainChat = { id: 'main-1', messages: earlier };

    await renderPage(auth({ accountId: 'acct-first' }));

    expect(agent().messages).toEqual(earlier);
    expect(error).toHaveBeenCalledWith(blocked);
    vi.restoreAllMocks();
  });

  it.each([200, 503])("clears the previous account's mounted copy while the new account loads (%s)", async (status) => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-first', messages: earlier }));
    const held = holdMainChat();
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    expect(agent().messages).toEqual(earlier);
    expect(screen.getByTestId('copilot-message-list')).toBeInTheDocument();
    const previous = agent();

    cartridge.auth = auth({ accountId: 'acct-second' });
    view.rerender(<Page />);
    await settle();

    expect(screen.queryByTestId('copilot-message-list')).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading Main Chat' })).toBeInTheDocument();
    expect(kept()).toBeNull();
    // A late previous-account response cannot put its messages back on screen.
    await act(async () => { present(held[0], 'the first account load')(answer(200, { id: 'main-first', messages: earlier })); });
    await settle();
    expect(screen.queryByTestId('copilot-message-list')).toBeNull();
    const next: Message[] = [{ id: 'second', role: 'user', content: 'Second account question' }];
    await act(async () => { present(held[1], 'the second account load')(answer(status, { id: 'main-second', messages: next })); });
    await settle();
    if (status === 200) {
      expect(copilot.chat?.threadId).toBe('main-second');
      expect(agent()).not.toBe(previous);
      expect(agent().messages).toEqual(next);
    } else {
      expect(screen.queryByTestId('copilot-message-list')).toBeNull();
      expect(screen.getByText('Your Main Chat could not be opened.')).toBeInTheDocument();
    }
  });

  it("forgets another account's copy, never showing it", async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-other', id: 'main-other', messages: earlier }));
    holdMainChat();

    await renderPage(auth({ accountId: 'acct-first' }));

    expect(copilot.chat).toBeUndefined();
    expect(kept()).toBeNull();
  });

  // The copy waited on the account session, about 1 s on a phone's network, before showing.
  it('shows the copy while the account session loads, then loads the Main Chat into it', async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', provider: 'openai', messages: earlier }));
    const view = await renderPage(auth({ sessionStatus: 'loading' }));

    expect(document.querySelector('.account-session-gate')).toBeNull();
    expect(copilot.chat?.threadId).toBe('main-1');
    expect(agent().messages).toEqual(earlier);
    expect(fetchMock).not.toHaveBeenCalled();
    const shown = agent();

    const reply: Message = { id: 'm3', role: 'assistant', content: 'A scheduled post' };
    service.mainChat = { id: 'main-1', provider: 'openai', messages: [...earlier, reply] };
    cartridge.auth = auth({ accountId: 'acct-first' });
    view.rerender(<Page />);
    await settle();

    expect(agent()).toBe(shown);
    expect(agent().messages).toEqual([...earlier, reply]);
    expect(requests()).toEqual(['GET /main-chat', 'GET /threads']);
  });

  it("takes another account's copy off screen and forgets it once the session answers", async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-other', id: 'main-other', messages: earlier }));
    holdMainChat();
    const view = await renderPage(auth({ sessionStatus: 'loading' }));
    expect(agent().messages).toEqual(earlier);

    cartridge.auth = auth({ accountId: 'acct-first' });
    view.rerender(<Page />);
    await settle();

    expect(screen.queryByTestId('copilot-message-list')).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading Main Chat' })).toBeInTheDocument();
    expect(kept()).toBeNull();
  });

  it.each(['error', 'parked'] as const)('takes the copy off screen for the session gate when the session is %s', async (sessionStatus) => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: earlier }));
    const view = await renderPage(auth({ sessionStatus: 'loading' }));
    expect(agent().messages).toEqual(earlier);

    cartridge.auth = auth({ sessionStatus });
    view.rerender(<Page />);
    await settle();

    expect(document.querySelector('.account-session-gate')).toHaveTextContent(/^Research Bot/);
    expect(screen.queryByTestId('copilot-message-list')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the session gate for a link to a Side Chat while the session loads', async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: earlier }));
    window.history.replaceState(null, '', '/?chat=side-1');

    await renderPage(auth({ sessionStatus: 'loading' }));

    expect(document.querySelector('.account-session-gate')).not.toBeNull();
    expect(copilot.chat).toBeUndefined();
  });

  it('forgets its copy as the account signs out', async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: earlier }));
    holdMainChat();
    const state = auth({ accountId: 'acct-first', user: { name: 'Ada Lovelace' } });
    await renderPage(state);
    expect(agent().messages).toEqual(earlier);

    await userEvent.click(screen.getByLabelText('Account'));
    await userEvent.click(screen.getByText('Sign out'));

    expect(state.logout).toHaveBeenCalledOnce();
    expect(kept()).toBeNull();
  });

  // ADR 0030: a purge that failed silently would leave one account's copy for the next to open.
  it("fails to open the Main Chat when it cannot forget another account's copy, saying why", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = new DOMException('The operation is insecure.', 'SecurityError');
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-other', id: 'main-other', messages: earlier }));
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw refused; });
    service.mainChat = { id: 'main-1', messages: [{ id: 'mine', role: 'user', content: 'My question' }] };

    await renderPage(auth({ accountId: 'acct-first' }));

    expect(copilot.chat).toBeUndefined();
    expect(screen.getByText('Your Main Chat could not be opened.')).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith(refused);
    vi.restoreAllMocks();
  });

  it("takes the previous account's chat off screen when it cannot forget that account's copy", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = new DOMException('The operation is insecure.', 'SecurityError');
    service.mainChat = { id: 'main-first', messages: earlier };
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    expect(agent().messages).toEqual(earlier);
    expect(kept()).not.toBeNull();
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw refused; });

    cartridge.auth = auth({ accountId: 'acct-second' });
    view.rerender(<Page />);
    await settle();

    expect(screen.queryByTestId('copilot-message-list')).toBeNull();
    expect(screen.getByText('Your Main Chat could not be opened.')).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith(refused);
    vi.restoreAllMocks();
  });

  it('signs out when it cannot forget its copy, reporting why', async () => {
    const refused = new DOMException('The operation is insecure.', 'SecurityError');
    const reported: unknown[] = [];
    const report = (event: ErrorEvent) => { event.preventDefault(); reported.push(event.error); };
    window.addEventListener('error', report);
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: earlier }));
    holdMainChat();
    const state = auth({ accountId: 'acct-first', user: { name: 'Ada Lovelace' } });
    await renderPage(state);
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw refused; });

    await userEvent.click(screen.getByLabelText('Account'));
    await userEvent.click(screen.getByText('Sign out'));

    expect(state.logout).toHaveBeenCalledOnce();
    expect(reported).toEqual([refused]);
    window.removeEventListener('error', report);
    vi.restoreAllMocks();
  });

  it('says why when the load after its copy fails, still showing the copy', async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: earlier }));
    service.failing.set('GET /main-chat', 503);

    await renderPage(auth({ accountId: 'acct-first' }));

    expect(agent().messages).toEqual(earlier);
    expect(screen.getByText('Your Main Chat could not be opened.')).toBeInTheDocument();
  });
});

// The history moments run from the page's opening to the Main Chat's history on screen, once per page load.
describe('the history moments', () => {
  const earlier: Message[] = [
    { id: 'm1', role: 'user', content: 'Earlier question' },
    { id: 'm2', role: 'assistant', content: 'Earlier answer' },
  ];
  // The frames the page asked for, run as the browser paints the next one.
  let frames: FrameRequestCallback[] = [];
  const nextFrame = () => {
    const due = frames;
    frames = [];
    for (const frame of due) frame(performance.now());
  };
  /** The history moments measured, once the next frame has run. */
  const measured = () => {
    nextFrame();
    return {
      returning: performance.getEntriesByName('latency:history-returning', 'measure').length,
      firstVisit: performance.getEntriesByName('latency:history-first-visit', 'measure').length,
    };
  };

  beforeEach(() => {
    performance.clearMeasures();
    copilot.rows = true;
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
  });

  it('times an opening with a kept copy to its rows, before the account session answers, once', async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: earlier }));
    const view = await renderPage(auth({ sessionStatus: 'loading' }));

    expect(document.querySelector('[data-message-row="m2"]')).not.toBeNull();
    // Measured in the frame after its rows commit, not before.
    expect(performance.getEntriesByName('latency:history-returning', 'measure')).toEqual([]);
    expect(measured()).toEqual({ returning: 1, firstVisit: 0 });

    service.mainChat = { id: 'main-1', messages: [...earlier, { id: 'm3', role: 'assistant', content: 'A scheduled post' }] };
    cartridge.auth = auth({ accountId: 'acct-first' });
    view.rerender(<Page />);
    await settle();

    expect(document.querySelector('[data-message-row="m3"]')).not.toBeNull();
    expect(measured()).toEqual({ returning: 1, firstVisit: 0 });
  });

  it('times a first visit to the loaded rows, once', async () => {
    service.mainChat = { id: 'main-1', messages: earlier };
    const view = await renderPage(auth({ sessionStatus: 'loading' }));
    expect(measured()).toEqual({ returning: 0, firstVisit: 0 });

    cartridge.auth = auth({ accountId: 'acct-first' });
    view.rerender(<Page />);
    await settle();

    expect(document.querySelector('[data-message-row="m2"]')).not.toBeNull();
    expect(measured()).toEqual({ returning: 0, firstVisit: 1 });

    // The account session parks and comes back, the copy now kept: the page has not opened again.
    cartridge.auth = auth({ sessionStatus: 'parked' });
    view.rerender(<Page />);
    cartridge.auth = auth({ accountId: 'acct-first' });
    view.rerender(<Page />);
    await settle();

    expect(document.querySelector('[data-message-row="m2"]')).not.toBeNull();
    expect(measured()).toEqual({ returning: 0, firstVisit: 1 });
  });

  it('times a first visit to an empty Main Chat to its welcome screen', async () => {
    await renderPage();

    expect(welcome()).not.toBeNull();
    expect(measured()).toEqual({ returning: 0, firstVisit: 1 });
  });

  it('times neither for a link to a Side Chat, nor once the user goes on to the Main Chat', async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: earlier }));
    service.replies.set('saved', [{ id: 's1', role: 'user', content: 'Saved question' }]);
    window.history.replaceState(null, '', '/?chat=saved');

    await renderPage(auth({ accountId: 'acct-first' }));
    expect(copilot.chat?.threadId).toBe('saved');
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await settle();

    expect(copilot.chat?.threadId).toBe('main-1');
    expect(measured()).toEqual({ returning: 0, firstVisit: 0 });
  });

  it.each(['error', 'parked'] as const)('times neither when the account session is %s before any history shows, nor once it is ready', async (sessionStatus) => {
    service.mainChat = { id: 'main-1', messages: earlier };
    const view = await renderPage(auth({ sessionStatus: 'loading' }));

    cartridge.auth = auth({ sessionStatus });
    view.rerender(<Page />);
    await settle();
    expect(document.querySelector('.account-session-gate')).not.toBeNull();
    cartridge.auth = auth({ accountId: 'acct-first' });
    view.rerender(<Page />);
    await settle();

    expect(document.querySelector('[data-message-row="m2"]')).not.toBeNull();
    expect(measured()).toEqual({ returning: 0, firstVisit: 0 });
  });

  it('times neither when the user opens a new chat before the Main Chat loads, nor once it shows', async () => {
    service.mainChat = { id: 'main-1', messages: earlier };
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await renderPage();

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await act(async () => {
      for (const resolve of held) resolve(answer(200, service.mainChat));
    });
    await settle();

    expect(document.querySelector('[data-message-row="m2"]')).not.toBeNull();
    expect(measured()).toEqual({ returning: 0, firstVisit: 0 });
  });

  it('times neither when the Main Chat fails to load, nor after its Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service.failing.set('GET /main-chat', 503);
    await renderPage();
    expect(screen.getByText('Your Main Chat could not be opened.')).toBeInTheDocument();

    service.failing.delete('GET /main-chat');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();

    expect(copilot.chat?.threadId).toBe('main-1');
    expect(measured()).toEqual({ returning: 0, firstVisit: 0 });
  });
});

describe('Main Chat', () => {
  it('lands in the Main Chat with its messages so far', async () => {
    const messages: Message[] = [
      { id: 'm1', role: 'user', content: 'Earlier question' },
      { id: 'm2', role: 'assistant', content: 'Earlier answer' },
    ];
    service.mainChat = { id: 'main-1', messages };

    await renderPage();

    expect(copilot.chat?.threadId).toBe('main-1');
    for (const direct of Object.values(kit().selfManagedAgents)) {
      expect(direct.threadId).toBe('main-1');
      expect(direct.messages).toEqual(messages);
    }
    expect(welcome()).toBeNull();
    expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveClass('sidebar-nav-item', 'sidebar-nav-item-active');
  });

  // CopilotKit's scroll view smooth-scrolled each opened chat down from its top to the latest message.
  // A long chat still scrolled through as its rows measured after opening, each growth smooth-scrolled, from
  // estimated row heights while CopilotKit virtualized it.
  it('opens at the latest message and stays there as the chat grows', async () => {
    service.mainChat = { id: 'main-1', messages: [{ id: 'm1', role: 'user', content: 'Earlier question' }] };

    await renderPage();

    expect(screen.getByTestId('copilot-scroll-view')).toHaveAttribute('data-initial', 'instant');
    expect(screen.getByTestId('copilot-scroll-view')).toHaveAttribute('data-resize', 'instant');
    expect(screen.getByTestId('copilot-message-list')).not.toHaveAttribute('data-virtualized');
  });

  // Laying out every message of a long Main Chat before its first paint took seconds.
  describe('a long chat', () => {
    // Like an IntersectionObserver: each observer reports its target once as it starts observing, then as the target
    // comes into or goes out of view.
    const observed: { target: Element; callback: IntersectionObserverCallback }[] = [];
    const report = (isIntersecting: boolean) =>
      act(async () => {
        for (const { target, callback } of [...observed]) {
          callback([{ target, isIntersecting } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
        }
      });
    // The user scrolls up from below the first row laid out to the top of it.
    const scrollToTop = async () => {
      await report(false);
      await report(true);
    };
    const rows = () => [...document.querySelectorAll('[data-message-row]')].map((row) => row.getAttribute('data-message-row'));
    const scrollView = () => screen.getByTestId('copilot-scroll-view');
    // Like a ResizeObserver: the list reports each time the rows in it grow.
    const resized: ResizeObserverCallback[] = [];
    const grow = () => act(async () => { for (const callback of [...resized]) callback([], {} as ResizeObserver); });
    // Each row 100px tall unless `height` says otherwise, laid out from the list's top, in a scroll view 300px tall: the
    // row being read moves down by the rows joining above it.
    const layOut = (height: (row: string | null) => number = () => 100) => {
      const all = () => [...document.querySelectorAll('[data-message-row]')];
      const sum = (laid: Element[]) => laid.reduce((total, row) => total + height(row.getAttribute('data-message-row')), 0);
      Object.defineProperty(scrollView(), 'clientHeight', { configurable: true, value: 300 });
      Object.defineProperty(scrollView(), 'scrollHeight', { configurable: true, get: () => sum(all()) });
      return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        if (this === scrollView()) return { top: 0, bottom: 300 } as DOMRect;
        const index = all().indexOf(this);
        const top = (index === -1 ? -100 : sum(all().slice(0, index))) - scrollView().scrollTop;
        return { top, bottom: index === -1 ? top : top + height(this.getAttribute('data-message-row')) } as DOMRect;
      });
    };

    beforeEach(() => {
      observed.length = 0;
      resized.length = 0;
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(private readonly callback: ResizeObserverCallback) {}
          observe() {
            resized.push(this.callback);
          }
          disconnect() {
            resized.splice(0, resized.length, ...resized.filter((callback) => callback !== this.callback));
          }
        },
      );
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(private readonly callback: IntersectionObserverCallback) {}
          observe(target: Element) {
            observed.push({ target, callback: this.callback });
          }
          disconnect() {
            observed.splice(0, observed.length, ...observed.filter(({ callback }) => callback !== this.callback));
          }
        },
      );
      copilot.rows = true;
      service.mainChat = {
        id: 'main-1',
        messages: Array.from({ length: 87 }, (_, index): Message => ({ id: `m${index}`, role: index % 2 ? 'assistant' : 'user', content: `Message ${index}` })),
      };
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('opens at its latest messages alone, and lays out earlier ones as the user scrolls up to them', async () => {
      await renderPage();

      expect(rows()).toEqual(['m83', 'm84', 'm85', 'm86']);
      const layout = layOut();
      await report(false);
      expect(rows()).toHaveLength(4);
      await report(true);
      expect(rows()).toEqual(['m79', 'm80', 'm81', 'm82', 'm83', 'm84', 'm85', 'm86']);
      // The scroll view, not its content wrapper, keeps the row being read in place.
      expect(scrollView().scrollTop).toBe(400);
      layout.mockRestore();
      // The rows already laid out stay as they are.
      expect(copilot.rowMounts).toBe(8);
      await agentAddsMessage({ id: 'm87', role: 'user', content: 'Next question' });
      expect(rows().at(0)).toBe('m79');
      for (let page = 0; page < 20; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- each scroll lays out the next earlier rows
        await scrollToTop();
      }
      expect(rows()).toHaveLength(88);
      expect(observed).toEqual([]);
    });

    it('shows history rows at once as the chat opens and as earlier rows join, and lets other animations play', async () => {
      class CSSAnimation {
        constructor(readonly animationName: string) {}
        finish = vi.fn();
      }
      vi.stubGlobal('CSSAnimation', CSSAnimation);
      const played: { animationName: string; finish: () => void }[] = [];
      vi.spyOn(Element.prototype, 'getAnimations').mockImplementation(function (this: Element, options?: GetAnimationsOptions) {
        if (this !== screen.queryByTestId('copilot-message-list') || options?.subtree !== true) return [];
        // A row's entrance, another CSS animation, and a script's animation that shares the entrance's name.
        const animations = [new CSSAnimation('messageIn'), new CSSAnimation('loadPulse'), { animationName: 'messageIn', finish: vi.fn() }];
        played.push(...animations);
        return animations as unknown as Animation[];
      });
      const finished = () => played.map(({ animationName, finish }) => `${animationName}${vi.mocked(finish).mock.calls.length}`);

      await renderPage();
      expect(finished()).toEqual(['messageIn1', 'loadPulse0', 'messageIn0']);

      layOut();
      await scrollToTop();
      expect(finished()).toEqual(['messageIn1', 'loadPulse0', 'messageIn0', 'messageIn1', 'loadPulse0', 'messageIn0']);

      // A message arriving plays its entrance.
      await agentAddsMessage({ id: 'm87', role: 'user', content: 'Next question' });
      expect(played).toHaveLength(6);
    });

    // CopilotKit lays out custom-message slots around each message's row, so 4 elements held barely 2 messages.
    it('opens at its 4 latest messages and lays out 4 earlier ones at a time, between their custom-message slots', async () => {
      copilot.slots = true;
      await renderPage();

      expect(rows()).toEqual(['m83', 'm84', 'm85', 'm86']);
      layOut();
      await scrollToTop();
      expect(rows()).toEqual(['m79', 'm80', 'm81', 'm82', 'm83', 'm84', 'm85', 'm86']);
    });

    // An answer's markdown renders after its row joins, and grew it by up to 360px, moving the row being read.
    it('keeps the row being read in place as the rows joined above it grow', async () => {
      let rendered = false;
      await renderPage();
      layOut((row) => (rendered && ['m79', 'm81'].includes(row ?? '') ? 460 : 100));
      await scrollToTop();
      expect(scrollView().scrollTop).toBe(400);

      rendered = true;
      await grow();

      expect(scrollView().scrollTop).toBe(1120);
    });

    // The user scrolled to the top before the rows that joined last had rendered, and as they grew, the row
    // the user had been reading below them, held in place, carried the view thousands of pixels down with it.
    it('keeps the view where the user scrolled it as rows render above the row they scrolled away from', async () => {
      let rendered = false;
      await renderPage();
      layOut((row) => (rendered && ['m79', 'm81'].includes(row ?? '') ? 460 : 100));
      await scrollToTop();
      expect(scrollView().scrollTop).toBe(400);

      scrollView().scrollTop = 0;
      await act(async () => scrollView().dispatchEvent(new Event('scroll')));
      rendered = true;
      await grow();

      expect(scrollView().scrollTop).toBe(0);
    });

    describe('after the jump-to-bottom button', () => {
      const frames: FrameRequestCallback[] = [];
      const frame = () => act(async () => { for (const callback of frames.splice(0)) callback(0); });
      const scrollTo = (top: number) => act(async () => {
        scrollView().scrollTop = top;
        scrollView().dispatchEvent(new Event('scroll'));
      });
      const jump = async () => {
        await renderPage();
        layOut();
        scrollView().scrollTop = 50;
        frames.length = 0;
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        fireEvent.click(screen.getByTestId('copilot-scroll-to-bottom'));
      };

      // A click as the chat still coasted up did nothing: CopilotKit's jump stopped at the coast's next
      // scroll up, which it took for the user's.
      it("jumps immediately, runs CopilotKit's jump, and holds the bottom until 3 frames pass without movement", async () => {
        await jump();
        expect(copilot.jumps).toBe(1);
        expect(scrollView().scrollTop).toBe(100);

        await scrollTo(40);
        expect(scrollView().scrollTop).toBe(100);
        await frame();
        await frame();
        await scrollTo(90);
        expect(scrollView().scrollTop).toBe(100);
        await frame();
        await frame();
        await frame();
        await scrollTo(70);

        expect(scrollView().scrollTop).toBe(70);
      });

      it('lands at the bottom when a coalesced spring and coast scroll ends 3px short', async () => {
        await jump();
        await scrollTo(97);
        await frame();
        await frame();
        await frame();

        expect(scrollView().scrollTop).toBe(100);
      });

      it('lets the user scroll the chat up once they press on it', async () => {
        await jump();
        await scrollTo(100);

        await act(async () => scrollView().dispatchEvent(new Event('pointerdown')));
        await scrollTo(70);

        expect(scrollView().scrollTop).toBe(70);
      });
    });

    // The rows that joined last rendered nothing, so the top stayed in view, never came into view again, and
    // no earlier row joined however far the user scrolled.
    it('lays out earlier rows while the rows that joined leave the top in view', async () => {
      await renderPage();
      layOut((row) => (['m79', 'm80', 'm81', 'm82'].includes(row ?? '') ? 0 : 100));
      await scrollToTop();
      expect(rows()).toHaveLength(8);

      await report(true);

      expect(rows()).toHaveLength(12);
    });

    // As rows joined again at once above rows that rendered nothing, the hold moved up to those rows, so the
    // row the user was reading moved as they rendered after.
    it('keeps the row being read in place as rows join again above rows that render nothing', async () => {
      let rendered = false;
      await renderPage();
      layOut((row) => (['m79', 'm80', 'm81', 'm82'].includes(row ?? '') ? (rendered && row === 'm79' ? 50 : 0) : 100));
      await scrollToTop();
      await report(true);
      expect(rows()).toHaveLength(12);
      expect(scrollView().scrollTop).toBe(400);

      rendered = true;
      await grow();

      expect(scrollView().scrollTop).toBe(450);
    });

    // At 440×956 a chat's 4 latest rows overflowed the scroll view by 20px, so its top stayed in view at the
    // bottom, where it opened, and no earlier row ever joined.
    it('lays out earlier rows while the user cannot scroll the top out of view, at the bottom of a barely overflowing chat', async () => {
      await renderPage();
      layOut();
      Object.defineProperty(scrollView(), 'clientHeight', { configurable: true, value: 380 });
      scrollView().scrollTop = 20;

      await report(true);

      expect(rows()).toEqual(['m79', 'm80', 'm81', 'm82', 'm83', 'm84', 'm85', 'm86']);
      expect(scrollView().scrollTop).toBe(420);
    });

    // At the chat's bottom, a row above the one being read shrank by a pixel as a row below grew by as much,
    // and the hold scrolled the view up off its bottom. CopilotKit's scroll view took that for the user scrolling up and
    // stopped keeping to its bottom, so as the rows' markdown rendered below, the view stayed 20,000px above it.
    it('leaves the view at its bottom as a row above the one being read shrinks', async () => {
      let rendered = false;
      await renderPage();
      layOut((row) => (rendered && row === 'm79' ? 99 : rendered && row === 'm86' ? 101 : 100));
      // At its bottom as CopilotKit's scroll view keeps it, 1px short.
      Object.defineProperty(scrollView(), 'clientHeight', { configurable: true, value: 379 });
      scrollView().scrollTop = 20;
      await report(true);
      expect(scrollView().scrollTop).toBe(420);

      rendered = true;
      await grow();

      expect(scrollView().scrollTop).toBe(420);
    });

    // Above the bottom, the hold still follows a row above shrinking, as the user reads there.
    it('keeps the row being read in place as a row above it shrinks, above the bottom', async () => {
      let rendered = false;
      await renderPage();
      layOut((row) => (rendered && row === 'm79' ? 60 : 100));
      await scrollToTop();
      expect(scrollView().scrollTop).toBe(400);

      rendered = true;
      await grow();

      expect(scrollView().scrollTop).toBe(360);
    });

    // Its latest rows not filling the scroll view, there is no scrolling up to the earlier ones.
    it('lays out earlier rows until they fill the scroll view', async () => {
      await renderPage();

      await report(true);
      expect(rows()).toHaveLength(8);
      await report(true);
      expect(rows()).toHaveLength(12);
    });
  });

  // Laying the messages out itself, the page keeps CopilotKit's pulsing cursor below them while a Turn runs.
  it('shows the running cursor below the messages while a Turn runs', async () => {
    copilot.running = true;

    await renderPage();

    expect(within(screen.getByTestId('copilot-message-list')).getByTestId('copilot-loading-cursor')).toBeInTheDocument();
  });

  it('shows no running cursor when no Turn runs', async () => {
    await renderPage();

    expect(screen.queryByTestId('copilot-loading-cursor')).toBeNull();
  });

  // Like CopilotKit's list: a streaming reasoning message shows its own indicator, so no cursor joins it.
  it('shows no running cursor below a reasoning message', async () => {
    copilot.running = true;
    copilot.messages = [{ id: 'r1', role: 'reasoning', content: 'Weighing the curve' }];

    await renderPage();

    expect(screen.queryByTestId('copilot-loading-cursor')).toBeNull();
  });

  it('returns to the Main Chat from a Side Chat', async () => {
    service.sideChats = [sideChat('side', 'Side question')];
    await renderPage();
    await userEvent.click(sidebar().getByText('Side question'));
    expect(sidebar().getByRole('button', { name: 'Main Chat' })).not.toHaveClass('sidebar-nav-item-active');

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await settle();

    expect(copilot.chat?.threadId).toBe('main-1');
    expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveClass('sidebar-nav-item-active');
    expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('.sidebar-item-active')).toBeNull();
  });

  // Customize, under Main chat, opens a screen of the extension kinds to come, each a placeholder (#3638).
  it('opens the Customize screen in place of the chat, and returns to the Main Chat', async () => {
    await renderPage();

    await userEvent.click(sidebar().getByRole('button', { name: 'Customize' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Customize' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Connectors', 'MCP servers', 'Skills']);
    expect(screen.getAllByText('Coming soon')).toHaveLength(3);
    expect(sidebar().getByRole('button', { name: 'Customize' })).toHaveClass('sidebar-nav-item-active');
    expect(sidebar().getByRole('button', { name: 'Main Chat' })).not.toHaveClass('sidebar-nav-item-active');
    expect(document.querySelector('.chat-header')?.closest('main')).not.toBeVisible();

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await settle();

    expect(screen.queryByRole('heading', { name: 'Customize' })).toBeNull();
    expect(copilot.chat?.threadId).toBe('main-1');
    expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveClass('sidebar-nav-item-active');
  });

  it("shows a skeleton under the agent's header while the Main Chat opens, laid out as the opened chat", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>(() => {}) : chatService(url, init),
    );

    await renderPage();

    expect(copilot.chat).toBeUndefined();
    const chatArea = within(present(document.querySelector<HTMLElement>('main.app-shell'), 'the chat area'));
    expect(chatArea.getByRole('status')).toHaveAccessibleName('Loading Main Chat');
    expect(chatArea.queryByRole('alert')).toBeNull();
    // With no header, the skeleton sat under a phone's menu button and the page jumped on load.
    const header = present(document.querySelector<HTMLElement>('main.app-shell > header.chat-header'), 'the chat header');
    // The Agent Profile opens on a chat, so its button waits for the Main Chat to open.
    expect(within(header).getByRole('button', { name: 'Agent profile' })).toBeDisabled();
    expect(header.nextElementSibling).toBe(chatArea.getByRole('status'));
  });

  it('says why the Main Chat could not be opened, and opens it on Retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    service.failing.set('GET /main-chat', 503);

    await renderPage();

    expect(copilot.chat).toBeUndefined();
    const chatArea = within(present(document.querySelector<HTMLElement>('main.app-shell'), 'the chat area'));
    expect(chatArea.getByRole('alert')).toHaveTextContent(/^Your Main Chat could not be opened\.$/);
    expect(chatArea.queryByRole('status')).toBeNull();
    expect(error).toHaveBeenCalledWith(new ChatServiceError('open the Main Chat', 503));
    expect(sidebar().getByRole('button', { name: 'Main Chat' })).not.toHaveClass('sidebar-nav-item-active');

    service.failing.delete('GET /main-chat');
    await userEvent.click(chatArea.getByRole('button', { name: 'Retry' }));
    await settle();

    expect(copilot.chat?.threadId).toBe('main-1');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('opens the Main Chat from the sidebar after it could not be opened', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service.failing.set('GET /main-chat', 503);
    await renderPage();

    service.failing.delete('GET /main-chat');
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await settle();

    expect(copilot.chat?.threadId).toBe('main-1');
  });
});

// A scheduled task posts to the Main Chat on the server, which the open chat showed only after a reload.
/** The user coming back to the page: its window regains focus, or the page turns visible. */
const comeBack = {
  focus: () => window.dispatchEvent(new Event('focus')),
  visibilitychange: () => document.dispatchEvent(new Event('visibilitychange')),
};
const comeBackEvents = Object.keys(comeBack) as (keyof typeof comeBack)[];
const userComesBack = async (event: keyof typeof comeBack = 'focus') => {
  await act(async () => {
    comeBack[event]();
  });
  await settle();
};
const mainChatLoads = () => requestsTo('/main-chat').length;
const sideChatLoads = () => requestsTo('/threads').length;

describe('a scheduled post to the open Main Chat', () => {
  const post: Message = { id: 'post', role: 'user', content: 'Scheduled task "Rates": the 10y rose 4bp.' };

  it.each(comeBackEvents)('shows once the user comes back to the page (%s)', async (event) => {
    await renderPage();
    service.mainChat = { id: 'main-1', messages: [post] };

    await userComesBack(event);

    expect(agent().messages).toEqual([post]);
    expect(welcome()).toBeNull();
  });

  it.each(['older-first', 'newer-first'])('keeps the newest scheduled post from overlapping refreshes (%s)', async (order) => {
    await renderPage();
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userComesBack('visibilitychange');
    await userComesBack('focus');
    expect(held).toHaveLength(2);
    const responses = [
      () => present(held[0], 'the older Main Chat load')(answer(200, { id: 'main-1', messages: [] })),
      () => present(held[1], 'the newer Main Chat load')(answer(200, { id: 'main-1', messages: [post] })),
    ];
    if (order === 'newer-first') responses.reverse();
    await act(async () => { present(responses[0], 'the first response')(); });
    await settle();
    await act(async () => { present(responses[1], 'the second response')(); });
    await settle();
    expect(agent().messages).toEqual([post]);
  });

  it('drops an older refresh failure after the newer refresh succeeds', async () => {
    await renderPage();
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userComesBack('visibilitychange');
    await userComesBack('focus');
    await act(async () => {
      present(held[1], 'the newer Main Chat load')(answer(200, { id: 'main-1', messages: [post] }));
    });
    await settle();
    await act(async () => {
      present(held[0], 'the older Main Chat load')(answer(503));
    });
    await settle();
    expect(agent().messages).toEqual([post]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retries after the latest overlapping refresh fails', async () => {
    await renderPage();
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userComesBack('visibilitychange');
    await userComesBack('focus');
    await act(async () => {
      present(held[0], 'the older Main Chat load')(answer(200, { id: 'main-1', messages: [] }));
      present(held[1], 'the newer Main Chat load')(answer(503));
    });
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('The Main Chat could not refresh');
    fetchMock.mockImplementation(chatService);
    service.mainChat = { id: 'main-1', messages: [post] };
    await userComesBack();
    expect(agent().messages).toEqual([post]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // A focused page never showed a scheduled run's post.
  it('shows within 30 s while the user stays on the page, along with the Side Chat the run made', async () => {
    vi.useFakeTimers();
    await renderPage();
    service.mainChat = { id: 'main-1', messages: [post] };
    service.sideChats = [sideChat('run', 'Rates')];

    await act(async () => {
      vi.advanceTimersByTime(29_999);
    });
    await settle();
    expect(agent().messages).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await settle();

    expect(agent().messages).toEqual([post]);
    expect(recents()).toEqual(['Rates']);
  });

  it('leaves the chat as it is when nothing new has arrived', async () => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [post] };
    await renderPage();
    const shown = agent().messages;

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await settle();

    expect(mainChatLoads()).toBe(2);
    expect(agent().messages).toBe(shown);
  });

  it('waits while the page is hidden', async () => {
    await renderPage();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    await userComesBack('visibilitychange');

    expect(mainChatLoads()).toBe(1);
    expect(sideChatLoads()).toBe(1);
  });

  it('keeps the draft in the composer', async () => {
    await renderPage();
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Message');
    textarea.value = 'half-written question';
    service.mainChat = { id: 'main-1', messages: [post] };

    await userComesBack();

    expect(agent().messages).toEqual([post]);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message')).toBe(textarea);
    expect(textarea.value).toBe('half-written question');
  });

  it('leaves a running Turn alone', async () => {
    await renderPage();
    agent().isRunning = true;
    service.mainChat = { id: 'main-1', messages: [post] };

    await userComesBack();

    expect(mainChatLoads()).toBe(1);
    expect(sideChatLoads()).toBe(1);
    expect(agent().messages).toEqual([]);
  });

  it('drops a history that arrives once a Turn has started', async () => {
    await renderPage();
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userComesBack();

    agent().isRunning = true;
    await act(async () => {
      present(held[0], 'the held Main Chat load')(answer(200, { id: 'main-1', messages: [post] }));
    });
    await settle();

    expect(agent().messages).toEqual([]);
  });

  it('keeps a Turn that finishes before the held history arrives', async () => {
    await renderPage();
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userComesBack();

    const completed: Message[] = [
      { id: 'question', role: 'user', content: 'What changed?' },
      { id: 'answer', role: 'assistant', content: 'The latest answer.' },
    ];
    await act(async () => {
      agent().isRunning = true;
      agent().setMessages(completed);
      agent().isRunning = false;
      present(held[0], 'the held Main Chat load')(answer(200, { id: 'main-1', messages: [post] }));
    });
    await settle();

    expect(agent().messages).toEqual(completed);
  });

  it('keeps an in-place question after its Turn fails before any stream event', async () => {
    await renderPage();
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userComesBack();

    const question: Message = { id: 'failed-question', role: 'user', content: 'Keep my question after the failed attempt.' };
    const messagesBeforeTurn = agent().messages;
    await act(async () => {
      agent().isRunning = true;
      // CopilotKit submits with the real AG-UI addMessage, which appends in place before running the Turn.
      agent().addMessage(question);
      agent().isRunning = false;
    });
    expect(agent().messages).toBe(messagesBeforeTurn);
    await act(async () => {
      present(held[0], 'the held Main Chat load')(answer(200, { id: 'main-1', messages: [post] }));
    });
    await settle();

    expect(agent().messages).toEqual([question]);
  });

  it('says why the Main Chat could not refresh, until it refreshes', async () => {
    await renderPage();
    service.failing.set('GET /main-chat', 503);

    await userComesBack();

    expect(screen.getByRole('alert')).toHaveTextContent(/^The Main Chat could not refresh: Failed to open the Main Chat: 503$/);
    expect(agent().messages).toEqual([]);

    service.failing.delete('GET /main-chat');
    service.mainChat = { id: 'main-1', messages: [post] };
    await userComesBack();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(agent().messages).toEqual([post]);
  });

  it('refreshes only the Main Chat, dropping its failure in a Side Chat', async () => {
    service.sideChats = [sideChat('side', 'Side question')];
    await renderPage();
    service.failing.set('GET /main-chat', 503);
    await userComesBack();
    expect(screen.getByRole('alert')).toHaveTextContent('The Main Chat could not refresh');

    await userEvent.click(sidebar().getByText('Side question'));
    await settle();
    await userComesBack();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(mainChatLoads()).toBe(2);
  });

  it('drops a failure that arrives once a Side Chat is open', async () => {
    service.sideChats = [sideChat('side', 'Side question')];
    await renderPage();
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userComesBack();

    await userEvent.click(sidebar().getByText('Side question'));
    await settle();
    await act(async () => {
      present(held[0], 'the held Main Chat load')(answer(503));
    });
    await settle();

    expect(copilot.chat?.threadId).toBe('side');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(comeBackEvents)('stops listening once the chat is gone (%s)', async (event) => {
    const { unmount } = await renderPage();
    unmount();

    await userComesBack(event);

    expect(mainChatLoads()).toBe(1);
    expect(sideChatLoads()).toBe(1);
  });
});

// A scheduled run makes a Side Chat on the server, which the sidebar listed only after a reload.
describe("a scheduled run's Side Chat", () => {
  const scheduled = sideChat('scheduled', 'Rates');

  it.each(comeBackEvents)('is listed once the user comes back to the page (%s)', async (event) => {
    await renderPage();
    service.sideChats = [scheduled];

    await userComesBack(event);

    expect(recents()).toEqual(['Rates']);
  });

  it('is listed while a Side Chat is open, which stays open and selected', async () => {
    service.sideChats = [sideChat('side', 'Side question')];
    await renderPage();
    await userEvent.click(sidebar().getByText('Side question'));
    await settle();
    service.sideChats = [scheduled, sideChat('side', 'Side question')];

    await userComesBack();

    expect(recents()).toEqual(['Rates', 'Side question']);
    expect(document.querySelector('.sidebar-item-active')).toHaveTextContent('Side question');
    expect(copilot.chat?.threadId).toBe('side');
    expect(copilot.mounts).toBe(2);
  });

  it('says why the Side Chats could not load, until they load', async () => {
    service.sideChats = [sideChat('side', 'Side question')];
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    service.failing.set('GET /threads', 503);

    await userComesBack();

    expect(sidebar().getByRole('alert')).toHaveTextContent(/^Side Chats could not load: Failed to fetch threads: 503$/);

    service.failing.delete('GET /threads');
    service.sideChats = [scheduled, sideChat('side', 'Side question')];
    await userComesBack();

    expect(sidebar().queryByRole('alert')).toBeNull();
    expect(recents()).toEqual(['Rates', 'Side question']);
  });

  it('loads the Side Chats on reconnect after the initial chat load failed offline', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    expect(copilot.kits).toEqual([]);
    expect(sidebar().getByRole('alert')).toHaveTextContent('Side Chats could not load: Failed to fetch');
    const initialMainLoads = mainChatLoads();
    service.sideChats = [sideChat('side', 'Side question')];
    fetchMock.mockImplementation(chatService);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();

    expect(sidebar().queryByRole('alert')).toBeNull();
    expect(recents()).toEqual(['Side question']);
    expect(mainChatLoads()).toBe(initialMainLoads);
    expect(copilot.kits).toEqual([]);
  });

  // The error from a load while offline stayed in the drawer after the connection came back, until a reload.
  it('loads the Side Chats again once the connection is back', async () => {
    service.sideChats = [sideChat('side', 'Side question')];
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    await userComesBack();
    expect(sidebar().getByRole('alert')).toHaveTextContent('Side Chats could not load: Failed to fetch');

    fetchMock.mockImplementation(chatService);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await settle();

    expect(sidebar().queryByRole('alert')).toBeNull();
    expect(recents()).toEqual(['Side question']);
  });
});

// A page reloaded mid-Turn showed the reply only at the next focus or refresh.
describe('a Turn that runs on the server after a reload', () => {
  const question: Message = { id: 'q', role: 'user', content: 'What moved the 10y?' };
  const reply: Message = { id: 'a', role: 'assistant', content: 'CPI came in hot.' };

  /** The Stops sent for the Main Chat's Turn so far. */
  const stopsSent = () =>
    fetchMock.mock.calls
      .filter(([url]) => url === 'http://chat.test/threads/main-1/stop')
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown);

  async function threeSecondsPass() {
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await settle();
  }

  it.each([
    ['Main Chat', 'replay'],
    ['Side Chat', 'replay'],
    ['Main Chat', 'dropped stream'],
    ['Side Chat', 'dropped stream'],
  ])('keeps Stop available for a %s Turn after %s', async (chat, pathToDetached) => {
    vi.useFakeTimers();
    service.sideChats = [sideChat('side', 'What moved the 10y?')];
    if (pathToDetached === 'replay') {
      if (chat === 'Main Chat') service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'server-run' };
      else {
        service.replies.set('side', [question]);
        service.running.add('side');
        service.runIds.set('side', 'server-run');
      }
    }
    await renderPage();
    if (chat === 'Side Chat') {
      fireEvent.click(sidebar().getByText('What moved the 10y?'));
      await settle();
    }
    const current = agent();
    if (pathToDetached === 'dropped stream') {
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === 'http://chat.test' && init?.method === 'POST') {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: current.threadId, runId: 'server-run' })}\n\n`));
            },
          }), { headers: { 'content-type': 'text/event-stream' } });
        }
        return chatService(url, init);
      });
      let turn!: Promise<unknown>;
      await act(async () => {
        current.addMessage(question);
        turn = current.runAgent({ runId: 'server-run' }).catch(() => undefined);
      });
      await settle();
      expect(current.isRunning).toBe(true);
      await act(async () => { stream.close(); await turn; });
      if (chat === 'Main Chat') service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'server-run' };
      else {
        service.replies.set('side', [question]);
        service.running.add('side');
        service.runIds.set('side', 'server-run');
      }
      await threeSecondsPass();
    }
    expect(current.isRunning).toBe(false);
    const stop = screen.getByRole('button', { name: 'Stop' });
    service.failing.set(`POST /threads/${current.threadId}/stop`, 502);
    fireEvent.click(stop);
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('The Turn could not be stopped');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    service.failing.delete(`POST /threads/${current.threadId}/stop`);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    const stops = fetchMock.mock.calls.filter(([url]) => url === `http://chat.test/threads/${current.threadId}/stop`);
    expect(stops).toHaveLength(2);
    for (const [, init] of stops) expect(JSON.parse((init as RequestInit).body as string)).toEqual({ runId: 'server-run' });
    if (chat === 'Main Chat') service.mainChat = { id: 'main-1', messages: [question], running: false };
    else {
      service.running.delete('side');
      service.runIds.delete('side');
    }
    await threeSecondsPass();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(agent()).toBe(current);
  });
  it('shows the reply within 3 s of its end, then stops reloading', async () => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [question], running: true };
    await renderPage();

    await threeSecondsPass();
    expect(mainChatLoads()).toBe(2);
    expect(agent().messages).toEqual([question]);

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(agent().messages).toEqual([question, reply]);

    await threeSecondsPass();
    expect(mainChatLoads()).toBe(3);
  });

  // A Turn that ran on with no stream here could not be stopped.
  it('stops a Turn that runs on with no stream here, by its run ID', async () => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'run-on' };
    await renderPage();

    fireEvent.click(within(screen.getByTestId('send-cell')).getByRole('button', { name: 'Stop' }));
    await settle();

    expect(stopsSent()).toEqual([{ runId: 'run-on' }]);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(agent().messages).toEqual([question, reply]);
  });

  it('lets a detached Turn retry Stop after attempted navigation fails', async () => {
    service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'server-run' };
    service.sideChats = [sideChat('side', 'Other chat')];
    service.failing.set('GET /threads/side', 503);
    await renderPage();
    const current = agent();
    let refuseStop!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/threads/main-1/stop'
        ? new Promise<Response>((resolve) => { refuseStop = resolve; })
        : chatService(url, init),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    fireEvent.click(sidebar().getByText('Other chat'));
    await settle();
    expect(agent()).toBe(current);
    await act(async () => { refuseStop(answer(502, {})); });
    await settle();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    expect(screen.getByText('The Turn could not be stopped: Failed to stop the Turn: 502')).toBeInTheDocument();
    fetchMock.mockImplementation(chatService);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
  it.each([false, true])('keeps a late Stop refusal out of the newly opened chat (running: %s)', async (running) => {
    service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'old-run' };
    service.sideChats = [sideChat('side', 'Other chat')];
    if (running) service.running.add('side');
    await renderPage();
    let refuseStop!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/threads/main-1/stop'
        ? new Promise<Response>((resolve) => { refuseStop = resolve; })
        : chatService(url, init),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    fireEvent.click(sidebar().getByText('Other chat'));
    await settle();
    expect(agent().threadId).toBe('side');
    await act(async () => { refuseStop(answer(502, {})); });
    await settle();
    expect(screen.queryByText('The Turn could not be stopped: Failed to stop the Turn: 502')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
  it('keeps Stop up when it fails, so the user can try again', async () => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'run-on' };
    service.failing.set('POST /threads/main-1/stop', 503);
    await renderPage();

    fireEvent.click(within(screen.getByTestId('send-cell')).getByRole('button', { name: 'Stop' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent(/^The Turn could not be stopped: Failed to stop the Turn: 503$/);
    service.failing.delete('POST /threads/main-1/stop');
    fireEvent.click(within(screen.getByTestId('send-cell')).getByRole('button', { name: 'Stop' }));
    await settle();
    expect(stopsSent()).toEqual([{ runId: 'run-on' }, { runId: 'run-on' }]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears why a Stop of the Turn streaming here failed once a retry stops it', async () => {
    service.mainChat = { id: 'main-1', messages: [question] };
    service.failing.set('POST /threads/main-1/stop', 503);
    await renderPage();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' && new URL(url).pathname === '/'
        ? new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              const input = JSON.parse(init.body as string);
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId })}\n\n`));
              init.signal?.addEventListener('abort', () => controller.error(new DOMException('The user aborted a request.', 'AbortError')));
            },
          }), { headers: { 'content-type': 'text/event-stream' } })
        : chatService(url, init),
    );
    const run = agent().runAgent().catch(() => undefined);
    await act(async () => {
      agent().abortRun();
    });
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent(/^The Turn could not be stopped: Failed to stop the Turn: 503$/);

    service.failing.delete('POST /threads/main-1/stop');
    await act(async () => {
      agent().abortRun();
      await run;
    });
    await settle();

    expect(agent().isRunning).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // A Turn whose stream here dropped ran on unseen, and nothing reloaded a Side Chat.
  it.each([
    ['reloads until it ends once the stream of a Turn sent here drops', new TypeError('network error'), 2],
    ['does not reload after the user stops the Turn', new DOMException('The user aborted a request.', 'AbortError'), 1],
  ])('%s', async (_label, failure, loads) => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [question] };
    await renderPage();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' && new URL(url).pathname === '/' ? Promise.reject(failure) : chatService(url, init),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => {
      await agent().runAgent().catch(() => undefined);
    });
    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };

    await threeSecondsPass();
    await threeSecondsPass();

    expect(mainChatLoads()).toBe(loads);
  });

  it('shows why the Turn failed once it ends in failure', async () => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'server-run' };
    await renderPage();

    service.mainChat = { id: 'main-1', messages: [question], running: false, failure: { runId: 'server-run', code: 'PROVIDER_ERROR', message: 'The provider failed' } };
    await threeSecondsPass();

    expect(screen.getByRole('alert')).toHaveTextContent(/^The agent could not answer: The provider failed$/);
  });

  it('shows why a Turn that ended before the page opened failed, until the next message is sent', async () => {
    service.mainChat = { id: 'main-1', messages: [question], failure: { runId: 'earlier-run', code: 'PROVIDER_ERROR', message: 'The provider failed' } };
    await renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent(/^The agent could not answer: The provider failed$/);

    await agentAddsMessage({ id: 'u2', role: 'user', content: 'try again' });
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  /** Sends the next Turn here, whose stream drops; its run ID, as the Chat Service records it. */
  async function sendDroppedTurn(): Promise<string> {
    await agentAddsMessage({ id: 'u2', role: 'user', content: 'try again' });
    await settle();
    let sent: string | undefined;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method !== 'POST' || new URL(url).pathname !== '/') return chatService(url, init);
      sent = (JSON.parse(init.body as string) as { runId: string }).runId;
      return Promise.reject(new TypeError('network error'));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => {
      await agent().runAgent().catch(() => undefined);
    });
    if (sent === undefined) throw new Error('No Turn was sent');
    return sent;
  }

  it('shows the same failure again when the next Turn fails alike', async () => {
    vi.useFakeTimers();
    const failure = { code: 'PROVIDER_ERROR', message: 'The provider failed' };
    service.mainChat = { id: 'main-1', messages: [question], failure: { runId: 'earlier-run', ...failure } };
    await renderPage();
    const runId = await sendDroppedTurn();

    service.mainChat = { id: 'main-1', messages: [question], running: false, failure: { runId, ...failure } };
    await threeSecondsPass();

    expect(screen.getAllByRole('alert').map(({ textContent }) => textContent)).toContain('The agent could not answer: The provider failed');
  });

  // Spec review: a send that never reached the Chat Service leaves the earlier Turn's failure on the record.
  it.each([
    ['', false],
    [', even once it is stopped', true],
  ])("does not show an earlier Turn's failure for a send that never reached the Chat Service%s", async (_label, stops) => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [question], failure: { runId: 'earlier-run', code: 'PROVIDER_ERROR', message: 'The provider failed' } };
    await renderPage();
    const runId = await sendDroppedTurn();
    if (stops) {
      fireEvent.click(within(screen.getByTestId('send-cell')).getByRole('button', { name: 'Stop' }));
      await settle();
      expect(stopsSent()).toEqual([{ runId }]);
    }

    await threeSecondsPass();

    expect(screen.queryAllByRole('alert').map(({ textContent }) => textContent)).not.toContain('The agent could not answer: The provider failed');
  });

  it('reloads a Side Chat whose Turn runs on', async () => {
    vi.useFakeTimers();
    service.sideChats = [sideChat('side', 'What moved the 10y?')];
    service.replies.set('side', [question]);
    service.running.add('side');
    await renderPage();
    fireEvent.click(sidebar().getByText('What moved the 10y?'));
    await settle();

    service.replies.set('side', [question, reply]);
    service.running.delete('side');
    await threeSecondsPass();

    expect(agent().messages).toEqual([question, reply]);
    expect(requestsTo('/threads/side')).toEqual(['GET', 'GET']);
  });

  it('waits while the page is hidden', async () => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [question], running: true };
    await renderPage();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    await threeSecondsPass();

    expect(mainChatLoads()).toBe(1);
  });

  it('leaves the chat alone while a Turn streams here', async () => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [question], running: true };
    await renderPage();
    agent().isRunning = true;

    await threeSecondsPass();

    expect(mainChatLoads()).toBe(1);
  });

  it('says why the chat could not reload', async () => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [question], running: true };
    await renderPage();
    service.failing.set('GET /main-chat', 503);

    await threeSecondsPass();

    expect(screen.getByRole('alert')).toHaveTextContent(/^The chat could not refresh: Failed to open the Main Chat: 503$/);
  });

  // A Turn whose stream here ended in a run error kept Stop up until a reload said it had ended.
  it('takes Stop down as soon as the Turn ends here in a run error, reloading nothing', async () => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [question] };
    await renderPage();
    const current = agent();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' && new URL(url).pathname === '/'
        ? new Response([
            { type: 'RUN_STARTED', threadId: current.threadId, runId: 'server-run' },
            { type: 'RUN_ERROR', message: 'The provider failed', code: 'PROVIDER_ERROR' },
          ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
        : chatService(url, init),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => {
      await current.runAgent({ runId: 'server-run' }).catch(() => undefined);
    });
    await settle();

    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    await threeSecondsPass();
    expect(mainChatLoads()).toBe(1);
  });

  // After a failed Turn, Main Chat loads ran back to back and alongside the 30 s refresh.
  describe('one load at a time', () => {
    /** Main Chat loads that have not answered yet, answered in order. */
    let held: ((response: Response) => void)[];
    beforeEach(() => {
      held = [];
    });
    const holdMainChatLoads = () =>
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
        url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
      );
    const answerLoad = async () => {
      await act(async () => { present(held.shift(), 'a held Main Chat load')(answer(200, service.mainChat)); });
      await settle();
    };

    it('starts the next reload 3 s after the previous one answers', async () => {
      vi.useFakeTimers();
      service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'server-run' };
      await renderPage();
      holdMainChatLoads();

      await threeSecondsPass();
      expect(mainChatLoads()).toBe(2);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      await answerLoad();
      await act(async () => { vi.advanceTimersByTime(2_999); });
      await settle();
      expect(mainChatLoads()).toBe(2);

      await act(async () => { vi.advanceTimersByTime(1); });
      await settle();
      expect(mainChatLoads()).toBe(3);
    });

    it.each([
      ['30 s refresh', async () => { await act(async () => { vi.advanceTimersByTime(30_000); }); }],
      ['refresh on focus', () => userComesBack('focus')],
    ])('loads nothing alongside a reload with the %s', async (_label, refresh) => {
      vi.useFakeTimers();
      service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'server-run' };
      await renderPage();
      holdMainChatLoads();
      await threeSecondsPass();
      expect(held).toHaveLength(1);

      await refresh();
      await settle();

      expect(held).toHaveLength(1);
    });

    it('refreshes nothing while the last reload is still out after its Turn ends here', async () => {
      vi.useFakeTimers();
      service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'server-run' };
      await renderPage();
      holdMainChatLoads();
      await threeSecondsPass();
      expect(held).toHaveLength(1);
      const current = agent();
      const heldService = present(fetchMock.getMockImplementation(), 'the held Chat Service');
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
        init?.method === 'POST' && new URL(url).pathname === '/'
          ? new Response([
              { type: 'RUN_STARTED', threadId: current.threadId, runId: 'next-run' },
              { type: 'RUN_FINISHED', threadId: current.threadId, runId: 'next-run' },
            ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
          : heldService(url, init),
      );
      await act(async () => {
        await current.runAgent({ runId: 'next-run' });
      });

      await act(async () => { vi.advanceTimersByTime(30_000); });
      await settle();

      expect(held).toHaveLength(1);
    });

    it("waits for a refresh's load still out before reloading", async () => {
      vi.useFakeTimers();
      service.mainChat = { id: 'main-1', messages: [question] };
      await renderPage();
      holdMainChatLoads();
      await userComesBack('focus');
      expect(held).toHaveLength(1);
      const heldService = present(fetchMock.getMockImplementation(), 'the held Chat Service');
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
        init?.method === 'POST' && new URL(url).pathname === '/' ? Promise.reject(new TypeError('network error')) : heldService(url, init),
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await act(async () => {
        await agent().runAgent().catch(() => undefined);
      });

      await threeSecondsPass();
      expect(held).toHaveLength(1);

      await answerLoad();
      await threeSecondsPass();
      expect(held).toHaveLength(1);
      expect(mainChatLoads()).toBe(3);
    });
  });
});

describe('Side Chats', () => {
  it.each([204, 503])('keeps deletion truth when a held sidebar refresh arrives after DELETE %i', async (status) => {
    const kept = sideChat('keep', 'Keep me');
    const dropped = sideChat('drop', 'Drop me');
    const scheduled = sideChat('scheduled', 'New scheduled chat');
    service.sideChats = [kept, dropped];
    if (status === 503) service.failing.set('DELETE /threads/drop', status);
    await renderPage();
    await userEvent.click(sidebar().getByText('Keep me'));
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/threads' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userComesBack();
    expect(held).toHaveLength(1);
    await userEvent.click(within(present(sidebar().getByText('Drop me').parentElement, 'the conversation item')).getByLabelText('Delete conversation'));
    const retained = status === 204 ? [kept] : [kept, dropped];
    expect(recents()).toEqual(retained.map(({ title }) => title));
    service.sideChats = [scheduled, ...retained];
    await act(async () => { present(held[0], 'the pre-delete list')(answer(200, { threads: [scheduled, kept, dropped] })); });
    await settle();
    expect(recents()).toEqual(service.sideChats.map(({ title }) => title));
    fetchMock.mockImplementation(chatService);
    await userComesBack();
    expect(recents()).toEqual(service.sideChats.map(({ title }) => title));
    expect(copilot.chat?.threadId).toBe('keep');
  });

  it('lists the Side Chats in the order the Chat Service gives', async () => {
    service.sideChats = [sideChat('newer', 'Newer question'), sideChat('older', 'Older question')];

    await renderPage();

    expect(sidebar().getByText('Side chats')).toBeInTheDocument();
    expect(recents()).toEqual(['Newer question', 'Older question']);
    expect(sidebar().queryByText('Start a side chat')).toBeNull();
  });

  it('says when there are none', async () => {
    await renderPage();

    expect(sidebar().getByText('Start a side chat')).toBeInTheDocument();
  });

  it('hides the welcome screen once the agent has its first message', async () => {
    await renderPage();

    await agentAddsMessage({ id: 'u1', role: 'user', content: 'What moved rates?' });

    expect(welcome()).toBeNull();
  });

  it('keeps the welcome screen while the agent has no messages', async () => {
    await renderPage();

    await act(async () => {
      agent().setMessages([]);
    });

    expect(welcome()).not.toBeNull();
  });

  it('opens a Side Chat with its replayed messages on its own thread', async () => {
    const messages: Message[] = [
      { id: 'm1', role: 'user', content: 'Saved question' },
      { id: 'm2', role: 'assistant', content: 'Saved answer' },
    ];
    service.sideChats = [sideChat('saved', 'Saved question')];
    service.replies.set('saved', messages);
    await renderPage();

    await userEvent.click(sidebar().getByText('Saved question'));

    expect(copilot.mounts).toBe(2);
    expect(copilot.chat?.threadId).toBe('saved');
    for (const direct of Object.values(kit().selfManagedAgents)) {
      expect(direct.threadId).toBe('saved');
      expect(direct.messages).toEqual(messages);
    }
    expect(welcome()).toBeNull();
    expect(document.querySelector('.sidebar-item-active')).toHaveTextContent('Saved question');
    expect(screen.getByText('panel for saved')).toBeInTheDocument();
    expect(requests()).toEqual(['GET /main-chat', 'GET /threads', 'GET /threads/saved']);
  });

  it('keeps the latest Side Chat selection when an earlier replay arrives late', async () => {
    service.sideChats = [sideChat('first', 'First question'), sideChat('second', 'Second question')];
    await renderPage();
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/threads/first' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userEvent.click(sidebar().getByText('First question'));
    await userEvent.click(sidebar().getByText('Second question'));
    expect(copilot.chat?.threadId).toBe('second');
    await act(async () => {
      present(held[0], 'the earlier Side Chat replay')(answer(200, { messages: [{ id: 'first-message', role: 'user', content: 'First history' }] }));
    });
    await settle();
    expect(copilot.chat?.threadId).toBe('second');
    expect(document.querySelector('.sidebar-item-active')).toHaveTextContent('Second question');
  });

  it('keeps a new chat and its draft when an earlier Side Chat replay arrives late', async () => {
    service.sideChats = [sideChat('first', 'First question')];
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/threads/first' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userEvent.click(sidebar().getByText('First question'));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Message');
    textarea.value = 'Draft for my new chat';
    await act(async () => {
      present(held[0], 'the earlier Side Chat replay')(answer(200, { messages: [] }));
    });
    await settle();
    expect(copilot.chat?.threadId).toBe('new-1');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message')).toBe(textarea);
    expect(textarea.value).toBe('Draft for my new chat');
  });

  it('keeps the Main Chat when an earlier Side Chat replay arrives late', async () => {
    service.sideChats = [sideChat('first', 'First question')];
    await renderPage();
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/threads/first' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userEvent.click(sidebar().getByText('First question'));
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await act(async () => { present(held[0], 'the earlier Side Chat replay')(answer(200, { messages: [] })); });
    await settle();
    expect(copilot.chat?.threadId).toBe('main-1');
  });

  it('keeps the selected Side Chat when an earlier Main Chat load arrives late', async () => {
    service.sideChats = [sideChat('first', 'First question')];
    await renderPage();
    await userEvent.click(sidebar().getByText('First question'));
    await settle();
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(sidebar().getByText('First question'));
    await act(async () => { present(held[0], 'the earlier Main Chat load')(answer(200, { id: 'main-1', messages: [] })); });
    await settle();
    expect(copilot.chat?.threadId).toBe('first');
  });

  it('shows a failed Side Chat replay and opens it on retry', async () => {
    service.sideChats = [sideChat('first', 'First question')];
    service.failing.set('GET /threads/first', 503);
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(sidebar().getByText('First question'));
    await settle();
    expect(sidebar().getByRole('alert')).toHaveTextContent('First question could not be opened: Failed to replay thread: 503');
    expect(copilot.chat?.threadId).toBe('main-1');
    service.failing.delete('GET /threads/first');
    await userEvent.click(sidebar().getByText('First question'));
    await settle();
    expect(copilot.chat?.threadId).toBe('first');
    expect(sidebar().queryByRole('alert')).toBeNull();
  });

  it('ignores an earlier Side Chat replay failure after a later selection succeeds', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    service.sideChats = [sideChat('first', 'First question'), sideChat('second', 'Second question')];
    await renderPage();
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/threads/first' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userEvent.click(sidebar().getByText('First question'));
    await userEvent.click(sidebar().getByText('Second question'));
    await act(async () => { present(held[0], 'the earlier Side Chat replay')(answer(503)); });
    await settle();
    expect(copilot.chat?.threadId).toBe('second');
    expect(sidebar().queryByRole('alert')).toBeNull();
    expect(error).toHaveBeenCalledWith(new ChatServiceError('replay thread', 503));
  });

  it("ignores a late message on the previous conversation's agent", async () => {
    await renderPage();
    const previous = agent();

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    await act(async () => {
      previous.addMessage({ id: 'late', role: 'user', content: 'Late message' });
    });

    expect(welcome()).not.toBeNull();
  });

  it('starts a new Side Chat', async () => {
    await renderPage();
    await sendMessage('first question');
    await agentAddsMessage({ id: 'u1', role: 'user', content: 'first question' });

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));

    expect(welcome()).not.toBeNull();
    expect(copilot.chat?.threadId).toBe('new-1');
    expect(agent().threadId).toBe('new-1');
    expect(agent().messages).toEqual([]);
    expect(document.querySelector('.sidebar-item-active')).toBeNull();
    expect(sidebar().getByRole('button', { name: 'Main Chat' })).not.toHaveClass('sidebar-nav-item-active');
  });

  it('clears a Side Chat failure once the next action succeeds', async () => {
    service.sideChats = [sideChat('stuck', 'Stuck'), sideChat('fine', 'Fine')];
    service.failing.set('DELETE /threads/stuck', 409);
    await renderPage();
    await userEvent.click(
      within(present(sidebar().getByText('Stuck').parentElement, 'the conversation item')).getByLabelText('Delete conversation'),
    );

    await userEvent.click(
      within(present(sidebar().getByText('Fine').parentElement, 'the conversation item')).getByLabelText('Delete conversation'),
    );

    expect(sidebar().queryByRole('alert')).toBeNull();
    expect(recents()).toEqual(['Stuck']);
  });

  it('shows Main chat, then the Side chats disclosure and plus, and no search or archive', async () => {
    service.sideChats = [sideChat('a', 'First')];
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));

    expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveTextContent(/^Main chat$/);
    // The drawer is titled with the product, as only the avatar and what belongs to it carry the agent's
    // name; this maintainer rule supersedes the earlier agent-name title (Fig 12's "Muse").
    expect(document.querySelector('.sidebar-brand-text')).toHaveTextContent(/^Research Bot$/);
    expect(document.querySelector('.chat-header-name')).toHaveTextContent(/^Ada Bot$/);
    const header = present(sidebar().getByText('Side chats').closest<HTMLElement>('.sidebar-section-header'), 'the Side chats header');
    expect(within(header).getByRole('button', { name: 'New side chat' })).toBeInTheDocument();
    expect(sidebar().queryByText('New chat')).toBeNull();
    expect(sidebar().getByText('First')).toBeInTheDocument();
    expect(sidebar().queryByRole('searchbox')).toBeNull();
    expect(sidebar().queryByText('Archived')).toBeNull();
    expect(sidebar().queryByLabelText('Archive conversation')).toBeNull();
  });

  it('deletes another conversation and stays on the current one', async () => {
    service.sideChats = [sideChat('keep', 'Keep me'), sideChat('drop', 'Drop me')];
    await renderPage();
    await userEvent.click(sidebar().getByText('Keep me'));

    await userEvent.click(
      within(present(sidebar().getByText('Drop me').parentElement, 'the conversation item')).getByLabelText('Delete conversation'),
    );

    expect(recents()).toEqual(['Keep me']);
    expect(requests()).toContain('DELETE /threads/drop');
    expect(copilot.chat?.threadId).toBe('keep');
  });

  it('starts a new conversation after deleting the current one', async () => {
    service.sideChats = [sideChat('current', 'Current one')];
    await renderPage();
    await userEvent.click(sidebar().getByText('Current one'));

    await userEvent.click(sidebar().getByLabelText('Delete conversation'));

    expect(recents()).toEqual([]);
    expect(copilot.chat?.threadId).toBe('new-1');
    expect(welcome()).not.toBeNull();
  });

  it('shows a delete failure and keeps the Side Chat', async () => {
    service.sideChats = [sideChat('stuck', 'Stuck')];
    service.failing.set('DELETE /threads/stuck', 409);
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));

    await userEvent.click(sidebar().getByLabelText('Delete conversation'));

    expect(sidebar().getByRole('alert')).toHaveTextContent('Stuck could not be deleted: Failed to delete thread: 409');
    expect(recents()).toEqual(['Stuck']);
  });

  it('shows why the Side Chats could not load, rather than an empty list', async () => {
    service.failing.set('GET /threads', 503);

    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));

    expect(sidebar().getByRole('alert')).toHaveTextContent('Side Chats could not load: Failed to fetch threads: 503');
    expect(sidebar().queryByText('Start a side chat')).toBeNull();
    expect(copilot.chat?.threadId).toBe('main-1');
  });
});

// Every chat shared the bare URL, so a reload dropped the user from their Side Chat into the Main Chat.
describe("a Side Chat's URL", () => {
  const saved: Message[] = [{ id: 'm1', role: 'user', content: 'Saved question' }];

  it('names the open Side Chat, and the Main Chat is the bare URL', async () => {
    service.sideChats = [sideChat('saved', 'Saved question')];
    service.replies.set('saved', saved);
    await renderPage();
    expect(window.location.search).toBe('');

    await userEvent.click(sidebar().getByText('Saved question'));
    expect(window.location.search).toBe('?chat=saved');

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await settle();
    expect(window.location.search).toBe('');
  });

  it('names a new Side Chat once the user sends its first message', async () => {
    await renderPage();

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    expect(window.location.search).toBe('');

    await sendMessage('What moved rates?');
    expect(window.location.search).toBe('?chat=new-1');
  });

  it('reopens the Side Chat it names on a reload or a link', async () => {
    service.replies.set('saved', saved);
    window.history.replaceState(null, '', '/?chat=saved');

    await renderPage();

    expect(copilot.chat?.threadId).toBe('saved');
    expect(agent().messages).toEqual(saved);
    expect(requests()).not.toContain('GET /main-chat');
    expect(window.location.search).toBe('?chat=saved');
  });

  it.each([
    [404, 'This chat was not found.'],
    [503, 'This chat could not be opened: Failed to replay thread: 503'],
  ])('shows why a Side Chat it names cannot open (%i), not the Main Chat, with a way there', async (status, error) => {
    service.failing.set('GET /threads/gone', status);
    window.history.replaceState(null, '', '/?chat=gone');

    await renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent(error);
    expect(copilot.kits).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Go to Main Chat' }));
    await settle();

    expect(copilot.chat?.threadId).toBe('main-1');
    expect(window.location.search).toBe('');
  });
});

describe('sidebar', () => {
  it('retries a failed Main Chat load from its active browser copy when expanding the sidebar', async () => {
    localStorage.setItem('botcube.main-chat', JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: [{ id: 'saved-question', role: 'user', content: 'Saved question' }] }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service.failing.set('GET /main-chat', 503);
    await renderPage(auth({ accountId: 'acct-first' }));
    expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveClass('sidebar-nav-item-active');
    expect(screen.getByText('Your Main Chat could not be opened.')).toBeInTheDocument();

    service.failing.delete('GET /main-chat');
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await settle();

    expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveAttribute('aria-expanded', 'true');
    expect(copilot.chat?.threadId).toBe('main-1');
    expect(screen.queryByText('Your Main Chat could not be opened.')).toBeNull();
  });

  it('keeps the active Main Chat Turn streaming when its rail control expands the sidebar', async () => {
    await renderPage();
    const current = agent();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test' && init?.method === 'POST'
        ? new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: current.threadId, runId: 'rail-run' })}\n\n`));
            },
          }), { headers: { 'content-type': 'text/event-stream' } })
        : chatService(url, init),
    );
    let turn: Promise<unknown> | undefined;
    await act(async () => {
      current.addMessage({ id: 'rail-question', role: 'user', content: 'Keep answering while I open the sidebar' });
      turn = current.runAgent({ runId: 'rail-run' });
    });
    await settle();
    try {
      expect(current.isRunning).toBe(true);
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
      expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
      await settle();
      expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveAttribute('aria-expanded', 'true');
      expect(agent()).toBe(current);
      expect(agent().messages).toContainEqual({ id: 'rail-question', role: 'user', content: 'Keep answering while I open the sidebar' });
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();

      await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
      await settle();
      expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveAttribute('aria-expanded', 'true');
      expect(agent()).toBe(current);
      expect(agent().messages).toContainEqual({ id: 'rail-question', role: 'user', content: 'Keep answering while I open the sidebar' });
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    } finally {
      await act(async () => {
        present(stream, 'the active Turn stream').close();
        await turn;
      });
    }
  });

  it('expands from Main Chat and collapses from the desktop stage while sidebar clicks stay expanded', async () => {
    await renderPage(auth({ user: { name: 'Ada Lovelace' } }));
    const aside = present(document.querySelector('aside'), 'the sidebar');
    const mainChat = sidebar().getByRole('button', { name: 'Main Chat' });
    expect(aside).toHaveClass('sidebar', 'sidebar-collapsed');
    expect(mainChat).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().queryByRole('button', { name: 'Toggle sidebar' })).toBeNull();
    expect(document.querySelector('.user-menu .sidebar-nav-label')).toBeNull();

    mainChat.focus();
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(aside).toHaveClass('sidebar', 'sidebar-expanded');
    expect(mainChat).toHaveAttribute('aria-expanded', 'true');
    expect(copilot.chat?.threadId).toBe('main-1');
    expect(document.querySelector('.user-menu .sidebar-nav-label')).toHaveTextContent(/^Ada$/);

    await userEvent.click(mainChat);
    expect(aside).toHaveClass('sidebar-expanded');
    await userEvent.click(sidebar().getByRole('button', { name: 'Account' }));
    expect(aside).toHaveClass('sidebar-expanded');
    expect(screen.queryByLabelText('Collapse sidebar')).toBeNull();
    await userEvent.click(screen.getByRole('textbox'));
    expect(aside).toHaveClass('sidebar-collapsed');
    expect(screen.getByRole('textbox')).toHaveFocus();
    expect(mainChat).toHaveAttribute('aria-expanded', 'false');

    mainChat.focus();
    await userEvent.keyboard(' ');
    expect(aside).toHaveClass('sidebar-expanded');
    expect(mainChat).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses from the Customize stage without treating sidebar navigation as a stage click', async () => {
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(sidebar().getByRole('button', { name: 'Customize' }));
    expect(document.querySelector('aside')).toHaveClass('sidebar-expanded');
    await userEvent.click(screen.getByRole('heading', { name: 'Customize' }));
    expect(document.querySelector('aside')).toHaveClass('sidebar-collapsed');
    expect(screen.getByRole('heading', { name: 'Customize' })).toBeVisible();
  });

  it('collapses from the failed Main Chat stage while its Retry still restores the chat', async () => {
    service.failing.set('GET /main-chat', 503);
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    expect(document.querySelector('aside')).toHaveClass('sidebar-expanded');
    service.failing.delete('GET /main-chat');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(document.querySelector('aside')).toHaveClass('sidebar-collapsed');
    expect(screen.getByRole('textbox')).toBeVisible();
    expect(copilot.chat?.threadId).toBe('main-1');
  });

  it('keeps only Main Chat and Customize in the collapsed primary rail and restores New side chat when expanded', async () => {
    const hidden = document.createElement('style');
    hidden.textContent = '.sidebar-collapsed .sidebar-nav-label { display: none; }'; // as globals.css hides them
    document.head.append(hidden);
    try {
      await renderPage();

      expect(sidebar().getByRole('button', { name: 'Main Chat' })).toBeInTheDocument();
      expect(sidebar().getByRole('button', { name: 'Customize' })).toBeInTheDocument();
      expect(sidebar().queryByRole('button', { name: 'New side chat' })).toBeNull();
      await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
      expect(sidebar().getByRole('button', { name: 'New side chat' })).toBeInTheDocument();
    } finally {
      hidden.remove();
    }
  });

  it('names the account menu after the cartridge account when there is no user', async () => {
    await renderPage(auth({ status: 'unauthed' }));
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));

    expect(document.querySelector('.user-menu .sidebar-nav-label')).toHaveTextContent(/^Research Account$/);
    expect(screen.getByLabelText('Account')).not.toHaveAttribute('data-tooltip');
  });

  it('marks only the active conversation', async () => {
    service.sideChats = [sideChat('a', 'First'), sideChat('b', 'Second')];
    await renderPage();

    await userEvent.click(sidebar().getByText('Second'));

    const items = [...document.querySelectorAll('.sidebar-item')];
    expect(items.map((item) => item.className)).toEqual(['sidebar-item ', 'sidebar-item sidebar-item-active']);
  });

  it('stays open beside the chat on a desktop when a chat is chosen', async () => {
    service.sideChats = [sideChat('a', 'First')];
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));

    await userEvent.click(sidebar().getByText('First'));

    expect(document.querySelector('aside')).toHaveClass('sidebar-expanded');
  });
});

describe('Side chats disclosure', () => {
  const disclosure = () => sidebar().getByRole('button', { name: 'Side chats' });

  beforeEach(() => { service.sideChats = [sideChat('a', 'First')]; });

  it('shows a load failure while the viewer’s saved list remains collapsed and clears it on recovery', async () => {
    localStorage.setItem('botcube.side-chats-collapsed:acct-first', 'true');
    service.failing.set('GET /threads', 503);
    await renderPage(auth({ accountId: 'acct-first' }));
    expect(sidebar().queryByRole('alert')).toBeNull();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));

    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().getByRole('alert')).toBeVisible();
    expect(sidebar().getByRole('alert')).toHaveTextContent('Side Chats could not load: Failed to fetch threads: 503');
    expect(sidebar().queryByRole('button', { name: 'First' })).toBeNull();

    service.failing.delete('GET /threads');
    await userComesBack();
    expect(sidebar().queryByRole('alert')).toBeNull();
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().queryByRole('button', { name: 'First' })).toBeNull();
    await userEvent.click(disclosure());
    expect(sidebar().getByRole('button', { name: 'First' })).toBeVisible();
  });

  it('toggles the list with the header and keyboard while keeping New side chat available', async () => {
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(sidebar().getByRole('button', { name: 'First' })).toBeVisible();

    await userEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().queryByRole('button', { name: 'First' })).toBeNull();
    expect(sidebar().getByRole('button', { name: 'New side chat' })).toBeVisible();

    disclosure().focus();
    await userEvent.keyboard('{Enter}');
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(sidebar().getByRole('button', { name: 'First' })).toBeVisible();
  });

  it('remembers a collapsed list after remount for the same viewer', async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(disclosure());
    view.unmount();

    await renderPage(auth({ accountId: 'acct-first' }));
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().queryByRole('button', { name: 'First' })).toBeNull();
    await userEvent.click(disclosure());
    expect(sidebar().getByRole('button', { name: 'First' })).toBeVisible();
  });

  it('keeps each viewer’s choice isolated across account switches', async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(disclosure());

    cartridge.auth = auth({ accountId: 'acct-second' });
    view.rerender(<Page />);
    await settle();
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(sidebar().getByRole('button', { name: 'First' })).toBeVisible();

    cartridge.auth = auth({ accountId: 'acct-first' });
    view.rerender(<Page />);
    await settle();
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().queryByRole('button', { name: 'First' })).toBeNull();
  });

  it.each(['getItem', 'setItem'] as const)('keeps the disclosure working when storage blocks %s', async (method) => {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error('storage blocked'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await renderPage(auth({ accountId: 'acct-first' }));
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().queryByRole('button', { name: 'First' })).toBeNull();
    await userEvent.click(disclosure());
    expect(sidebar().getByRole('button', { name: 'First' })).toBeVisible();
  });

  it('starts a side chat from the plus without expanding the collapsed list', async () => {
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(disclosure());
    await userEvent.click(sidebar().getByRole('button', { name: 'New side chat' }));
    await settle();

    expect(copilot.chat?.threadId).toBe('new-1');
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(sidebar().queryByRole('button', { name: 'First' })).toBeNull();
  });
});

describe('sidebar on a phone', () => {
  const happyDOM = () => (window as unknown as HappyDomWindow).happyDOM;
  const aside = () => present(document.querySelector('aside'), 'the sidebar');
  const openDrawer = () => userEvent.click(screen.getByLabelText('Toggle sidebar'));

  beforeEach(() => happyDOM().setViewport({ width: 390, height: 844 }));
  afterEach(() => happyDOM().setViewport({ width: 1024, height: 768 }));

  it('opens as a drawer beside a chat strip that closes it when tapped', async () => {
    await renderPage();
    expect(screen.queryByLabelText('Close sidebar')).toBeNull();

    await openDrawer();
    expect(aside()).toHaveClass('sidebar-expanded');
    await userEvent.click(screen.getByRole('textbox'));
    expect(aside()).toHaveClass('sidebar-expanded');

    await userEvent.click(screen.getByLabelText('Close sidebar'));
    expect(aside()).toHaveClass('sidebar-collapsed');
    expect(screen.queryByLabelText('Close sidebar')).toBeNull();
  });

  // The drawer had a panel button in its title row, which memo 0049 Fig 21 does not; the chat strip's
  // Close sidebar button closes it, by keyboard too.
  it('closes from the chat strip alone, which a keyboard reaches', async () => {
    await renderPage();
    await openDrawer();
    expect(sidebar().queryByRole('button', { name: 'Collapse sidebar' })).toBeNull();

    screen.getByRole('button', { name: 'Close sidebar' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(aside()).toHaveClass('sidebar-collapsed');
  });

  it('puts the only New side chat control beside the collapsible header', async () => {
    await renderPage();
    await openDrawer();

    const header = present(document.querySelector<HTMLElement>('.sidebar-section-header'), 'the Side chats header');
    expect(within(header).getByRole('button', { name: 'New side chat' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Side chats' })).toHaveAttribute('aria-expanded', 'true');
    expect(sidebar().getAllByRole('button', { name: 'New side chat' })).toHaveLength(1);
    const bottom = present(document.querySelector<HTMLElement>('.sidebar-bottom'), 'the sidebar bottom');
    expect(within(bottom).queryByRole('button', { name: /New.*chat/i })).toBeNull();
    expect(sidebar().queryByRole('button', { name: 'New chat' })).toBeNull();
  });

  it('closes when a Side Chat, the Main Chat, or a new chat is chosen', async () => {
    service.sideChats = [sideChat('a', 'First')];
    await renderPage();

    for (const choice of ['First', 'Main Chat', 'New side chat']) {
      // eslint-disable-next-line no-await-in-loop -- each choice reopens the drawer first
      await openDrawer();
      // eslint-disable-next-line no-await-in-loop -- one choice at a time
      await userEvent.click(sidebar().getByRole('button', { name: choice }));
      expect(aside(), choice).toHaveClass('sidebar-collapsed');
    }
  });
});

const PICTURE = 'data:image/png;base64,iVBORw0KGgo=';
const pictureIn = (element: Element | null) => element?.querySelector('.avatar img')?.getAttribute('src');

/** The browser's image decoding and canvas: a 1024x512 image that resizes to `resized`. */
const resizing = (resized: string) => {
  const image = { width: 1024, height: 512, close: vi.fn() };
  const drawImage = vi.fn();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => image),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as RenderingContext);
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(resized);
  return { image, drawImage, toDataURL };
};

describe('account menu', () => {
  const trigger = () => screen.getByLabelText('Account');
  const menu = () => document.querySelector<HTMLElement>('.user-menu-dropdown');
  const openMenu = () => present(menu(), 'the account menu');

  it('shows a signed-in user and lets them relink or sign out', async () => {
    const state = auth({ user: { name: 'Ada Lovelace' } });
    await renderPage(state);
    expect(trigger()).toHaveAttribute('data-tooltip', 'Ada Lovelace');
    expect(trigger()).toHaveClass('user-menu-trigger');
    expect(trigger()).not.toHaveClass('menu-open');
    expect(menu()).toBeNull();

    await userEvent.click(trigger());
    expect(trigger()).toHaveClass('user-menu-trigger', 'menu-open');
    expect(menu()?.querySelector('.user-menu-header')).toHaveTextContent(/^AAda Lovelace$/);
    await userEvent.click(within(openMenu()).getByText('Relink account'));
    expect(state.relink).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();

    await userEvent.click(trigger());
    await userEvent.click(within(openMenu()).getByText('Sign out'));
    expect(state.logout).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it('closes on Escape, returning focus to its trigger', async () => {
    await renderPage(auth({ user: { name: 'Ada Lovelace' } }));
    await userEvent.click(trigger());
    within(openMenu()).getByText('Sign out').focus();

    await userEvent.keyboard('{Escape}');

    expect(menu()).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(trigger()).not.toHaveClass('menu-open');
  });

  it('shows a signed-in user without details as the cartridge account and its initial', async () => {
    await renderPage();
    expect(trigger()).toHaveTextContent(/^R$/);

    await userEvent.click(trigger());

    expect(menu()?.querySelector('.user-menu-header')).toHaveTextContent(/^RResearch Account$/);
    expect(within(openMenu()).queryByText('Edit profile')).toBeNull();
  });

  it("shows the user's photo", async () => {
    await renderPage(auth({ user: { name: 'Ada Lovelace', photo: PICTURE } }));
    expect(pictureIn(trigger())).toBe(PICTURE);

    await userEvent.click(trigger());

    expect(pictureIn(menu()?.querySelector('.user-menu-header') ?? null)).toBe(PICTURE);
  });

  const editor = () => within(present(screen.getByRole('form', { name: 'Edit profile' }), 'the profile editor'));
  const editProfile = async (state: AuthUiState) => {
    await renderPage(state);
    await userEvent.click(trigger());
    await userEvent.click(within(openMenu()).getByText('Edit profile'));
    return editor();
  };

  it('saves an edited display name and an uploaded photo, resized small', async () => {
    const resized = 'data:image/webp;base64,UklGRg==';
    const canvas = resizing(resized);
    const state = auth({ user: { name: 'Ada Lovelace' }, editProfile: vi.fn(async () => undefined) });
    const form = await editProfile(state);
    expect(form.getByLabelText('Display name')).toHaveValue('Ada Lovelace');

    await userEvent.upload(form.getByLabelText('Upload photo'), new File(['png'], 'ada.png', { type: 'image/png' }));
    await settle();
    await userEvent.clear(form.getByLabelText('Display name'));
    await userEvent.type(form.getByLabelText('Display name'), 'Ada King');
    expect(canvas.drawImage).toHaveBeenCalledWith(canvas.image, 0, 0, 256, 128);
    expect(pictureIn(present(screen.getByRole('form', { name: 'Edit profile' }), 'the profile editor'))).toBe(resized);
    await userEvent.click(form.getByRole('button', { name: 'Save' }));

    expect(state.editProfile).toHaveBeenCalledExactlyOnceWith({ name: 'Ada King', photo: resized });
    expect(menu()).toBeNull();
  });

  it('keeps the photo when only the name changes, and removes it on request', async () => {
    const state = auth({ user: { name: 'Ada Lovelace', photo: PICTURE }, editProfile: vi.fn(async () => undefined) });
    let form = await editProfile(state);
    await userEvent.type(form.getByLabelText('Display name'), '!');
    await userEvent.click(form.getByRole('button', { name: 'Save' }));
    expect(state.editProfile).toHaveBeenLastCalledWith({ name: 'Ada Lovelace!', photo: undefined });

    await userEvent.click(trigger());
    await userEvent.click(within(openMenu()).getByText('Edit profile'));
    form = editor();
    await userEvent.click(form.getByRole('button', { name: 'Remove photo' }));
    expect(form.queryByRole('button', { name: 'Remove photo' })).toBeNull();
    await userEvent.click(form.getByRole('button', { name: 'Save' }));

    expect(state.editProfile).toHaveBeenLastCalledWith({ name: 'Ada Lovelace', photo: null });
  });

  it('says why a save failed and keeps the edit open', async () => {
    const state = auth({
      user: { name: 'Ada Lovelace' },
      editProfile: vi.fn(async () => Promise.reject(new Error('displayName is required'))),
    });
    const form = await editProfile(state);

    await userEvent.clear(form.getByLabelText('Display name'));
    await userEvent.click(form.getByRole('button', { name: 'Save' }));

    expect(form.getByRole('alert')).toHaveTextContent(/^displayName is required$/);
    expect(form.getByLabelText('Display name')).toHaveValue('');
  });

  // On a phone Edit profile is a sheet titled with a close button, which dismisses the menu.
  it('titles the edit and closes the menu from its close button without saving', async () => {
    const state = auth({ user: { name: 'Ada Lovelace' }, editProfile: vi.fn(async () => undefined) });
    const form = await editProfile(state);
    expect(form.getByRole('heading', { name: 'Edit profile' })).toBeInTheDocument();

    await userEvent.type(form.getByLabelText('Display name'), '!');
    await userEvent.click(form.getByRole('button', { name: 'Close edit profile' }));

    expect(state.editProfile).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it('cancels an edit without saving it', async () => {
    const state = auth({ user: { name: 'Ada Lovelace' }, editProfile: vi.fn(async () => undefined) });
    const form = await editProfile(state);

    await userEvent.type(form.getByLabelText('Display name'), '!');
    await userEvent.click(form.getByRole('button', { name: 'Cancel' }));

    expect(state.editProfile).not.toHaveBeenCalled();
    expect(within(openMenu()).getByText('Edit profile')).toBeInTheDocument();
  });

  it('closes on a second click or a click elsewhere, not a click inside', async () => {
    await renderPage();

    await userEvent.click(trigger());
    await userEvent.click(trigger());
    expect(menu()).toBeNull();

    await userEvent.click(trigger());
    await userEvent.click(present(openMenu().querySelector('.user-menu-header'), 'the menu header'));
    expect(menu()).not.toBeNull();
    await userEvent.click(present(document.querySelector('.sidebar-recents'), 'the recents'));
    expect(menu()).toBeNull();
  });

  it('shows an unlinked user their profile to edit, and offers to sign in', async () => {
    const state = auth({ status: 'unauthed', user: { name: 'Ada Lovelace', photo: PICTURE }, editProfile: vi.fn(async () => undefined) });
    await renderPage(state);
    expect(trigger()).toHaveAttribute('data-tooltip', 'Ada Lovelace');

    await userEvent.click(trigger());

    const header = present(openMenu().querySelector('.user-menu-header'), 'the menu header');
    expect(header).toHaveTextContent(/^Ada Lovelace$/);
    expect(pictureIn(header)).toBe(PICTURE);
    expect(within(openMenu()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Edit profile', 'Sign in']);
    await userEvent.click(within(openMenu()).getByText('Sign in'));
    expect(state.login).toHaveBeenCalledOnce();
  });

  it('shows the photo of a user without a name, as the cartridge account', async () => {
    await renderPage(auth({ user: { photo: PICTURE } }));
    expect(pictureIn(trigger())).toBe(PICTURE);

    await userEvent.click(trigger());

    const header = present(openMenu().querySelector('.user-menu-header'), 'the menu header');
    expect(header).toHaveTextContent(/^Research Account$/);
    expect(pictureIn(header)).toBe(PICTURE);
  });

  it('offers a signed-out user to sign in', async () => {
    const state = auth({ status: 'unauthed' });
    await renderPage(state);

    await userEvent.click(trigger());
    const signIn = within(openMenu()).getByRole('button');
    expect(signIn).toHaveTextContent(/^Sign in$/);
    expect(signIn).toBeEnabled();
    await userEvent.click(signIn);

    expect(state.login).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it('shows the sign-in in progress', async () => {
    await renderPage(auth({ status: 'loading' }));

    await userEvent.click(trigger());

    expect(within(openMenu()).getByRole('button')).toHaveTextContent(/^Connecting\.\.\.$/);
    expect(within(openMenu()).getByRole('button')).toBeDisabled();
  });

  it("says why the account's state could not load, with Retry in place of signing in", async () => {
    const retry = vi.fn();
    await renderPage(auth({ status: 'error', loadFailure: { error: 'Your account could not be loaded.', retry } }));

    await userEvent.click(trigger());

    expect(within(openMenu()).getByRole('alert')).toHaveTextContent(/^Your account could not be loaded\.$/);
    expect(within(openMenu()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Retry']);
    await userEvent.click(within(openMenu()).getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe('agent profile', () => {
  const avatar = () => screen.getByLabelText('Agent profile', { selector: 'button' });
  const profile = () => document.querySelector<HTMLElement>('.agent-profile:not([hidden])');
  const openProfile = () => present(profile(), 'the agent profile');
  // The profile opens on the Computer tab.
  const openActivity = async () => {
    await userEvent.click(avatar());
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Activity' }));
  };

  it("opens from the agent's avatar and name in the chat's header", async () => {
    await renderPage();
    expect(avatar()).toHaveTextContent(/^Ada Bot$/);
    expect(avatar().querySelector('.avatar-agent .avatar-monocle')).not.toBeNull();
    expect(avatar().closest('main > header')).not.toBeNull();
    // A tooltip names what the avatar opens.
    expect(avatar()).toHaveAttribute('title', 'Agent profile');
    expect(profile()).toBeNull();

    await userEvent.click(avatar());

    expect(openProfile().querySelector('.agent-profile-name')).toHaveTextContent(/^Ada Bot$/);
    expect(openProfile().querySelector('.agent-profile-status')).toHaveTextContent(/^Connected$/);
    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent', { credentials: 'include', cache: 'no-store' });
  });

  it('switches tabs and closes', async () => {
    await renderPage();
    await userEvent.click(avatar());

    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Scheduled' }));

    expect(within(openProfile()).getByRole('tab', { name: 'Scheduled' })).toHaveAttribute('aria-selected', 'true');
    expect(within(openProfile()).getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'false');
    expect(within(openProfile()).getByRole('tabpanel')).toHaveAccessibleName('Scheduled');
    expect(await within(openProfile()).findByText('No scheduled tasks yet.')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Close agent profile'));
    expect(profile()).toBeNull();
  });

  it("shows the cartridge's panel in its tab", async () => {
    await renderPage();
    await userEvent.click(avatar());

    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Sign-ins' }));

    expect(within(openProfile()).getByRole('tabpanel')).toHaveAccessibleName('Sign-ins');
    expect(within(openProfile()).getByRole('tabpanel')).toHaveTextContent(/^the cartridge's Sign-ins$/);
  });

  it("lists what the agent did under each day, newest first: each task's title, summary and time", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 2, 15, 0));
    const at = (month: number, day: number, hour: number) => new Date(2026, month, day, hour, 5).toISOString();
    service.activity = [
      { title: 'Compare with MSFT', summary: 'Found Microsoft grew faster', completedAt: at(9, 2, 11) },
      { title: 'Summarize AAPL earnings', summary: 'Found Apple beat on revenue', completedAt: at(9, 2, 9) },
      { summary: 'Chart the 10y yield', completedAt: at(9, 1, 16) },
      { title: 'Morning brief', summary: 'Reported rates down overnight', completedAt: at(8, 29, 8) },
    ];
    await renderPage();

    await openActivity();

    const days = await within(openProfile()).findAllByRole('region');
    expect(days.map((day) => day.querySelector('h3')?.textContent)).toEqual(['Today', 'Yesterday', 'Tuesday, September 29']);
    const tasks = days.map((day) =>
      within(day)
        .getAllByRole('listitem')
        .map((task) => [
          task.querySelector('.agent-activity-title')?.textContent,
          task.querySelector('.agent-activity-summary')?.textContent,
          task.querySelector('time')?.getAttribute('datetime'),
        ]),
    );
    expect(tasks).toEqual([
      [
        ['Compare with MSFT', 'Found Microsoft grew faster', at(9, 2, 11)],
        ['Summarize AAPL earnings', 'Found Apple beat on revenue', at(9, 2, 9)],
      ],
      [['Chart the 10y yield', undefined, at(9, 1, 16)]],
      [['Morning brief', 'Reported rates down overnight', at(8, 29, 8)]],
    ]);
    expect(within(days[0] as HTMLElement).getAllByRole('listitem')[0]).toHaveTextContent(/11:05\sAM$/);
    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/activity', { credentials: 'include', cache: 'no-store' });
  });

  it('shows a task that ended in a run error as failed, under its request', async () => {
    service.activity = [{ summary: 'Plot EURUSD', failed: 'Model overloaded', completedAt: new Date().toISOString() }];
    await renderPage();

    await openActivity();

    const [task] = await within(openProfile()).findAllByRole('listitem');
    expect(task?.querySelector('.agent-activity-title')).toHaveTextContent('Plot EURUSD');
    expect(task?.querySelector('.agent-activity-failed')).toHaveTextContent('Failed: Model overloaded');
  });

  // The activity moment runs from opening the tab to its list.
  it('times the Activity tab from its opening until its list shows', async () => {
    performance.clearMeasures();
    await renderPage();

    await openActivity();
    expect(await within(openProfile()).findByText('No tasks yet.')).toBeInTheDocument();

    expect(performance.getEntriesByName('latency:activity', 'measure')).toHaveLength(1);
  });

  it('says when the agent has no tasks yet', async () => {
    await renderPage();

    await openActivity();

    expect(await within(openProfile()).findByText('No tasks yet.')).toBeInTheDocument();
  });

  it('shows the Activity loading until it arrives, and why it could not load, with a Retry', async () => {
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/activity' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await renderPage();
    await openActivity();
    const panel = within(within(openProfile()).getByRole('tabpanel'));

    expect(panel.getByRole('status')).toHaveAccessibleName('Loading Activity');
    expect(panel.queryByText('No tasks yet.')).toBeNull();

    await act(async () => held[0]?.(answer(502)));

    expect(panel.getByRole('alert')).toHaveTextContent(/^Activity failed: 502$/);
    expect(panel.queryByRole('status')).toBeNull();
    expect(panel.queryByText('No tasks yet.')).toBeNull();

    await userEvent.click(panel.getByRole('button', { name: 'Retry' }));

    expect(panel.getByRole('status')).toHaveAccessibleName('Loading Activity');
    expect(panel.queryByRole('alert')).toBeNull();

    await act(async () =>
      held[1]?.(answer(200, { tasks: [{ summary: 'Chart the 10y yield', completedAt: '2026-10-01T16:05:00.000Z' }] })),
    );

    expect(panel.getByText('Chart the 10y yield')).toBeInTheDocument();
    expect(panel.queryByRole('status')).toBeNull();
  });

  it("says why the Activity could not load in the Chat Service's words", async () => {
    const detail = 'Session API request failed: Lambda Invoke returned HTTP 429';
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/activity' ? answer(503, { detail }) : chatService(url, init),
    );
    await renderPage();

    await openActivity();

    expect(await within(openProfile()).findByRole('alert')).toHaveTextContent(`Activity failed: ${detail}`);
  });

  const MORNING_BRIEF = {
    id: 'task-1',
    title: 'Morning brief',
    prompt: 'Brief me on rates',
    schedule: 'cron(0 8 ? * MON-FRI *)',
    timezone: 'America/New_York',
    paused: false,
    proposalId: 'call-0',
  };
  const openScheduled = async () => {
    await userEvent.click(avatar());
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Scheduled' }));
    return within(openProfile()).findByRole('listitem');
  };
  /** Taps a listed task, and returns the sheet that opens over the profile with its actions. */
  const openTask = async (task: HTMLElement) => {
    await userEvent.click(within(task).getByRole('button'));
    const title = present(task.querySelector('.scheduled-task-title'), "the task's title").textContent;
    return within(openProfile()).findByRole('dialog', { name: title });
  };
  /** Deletes the sheet's task: Delete, then the Delete task it asks to confirm with. */
  const deleteTask = async (sheet: HTMLElement) => {
    await userEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Delete task' }));
  };
  const closeTask = async (sheet: HTMLElement) => {
    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(openProfile()).queryByRole('dialog')).toBeNull());
  };
  const sent = (method: string, path: string) =>
    fetchMock.mock.calls
      .filter(([url, init]) => url === `http://chat.test${path}` && init?.method === method)
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown);

  it('lists each scheduled task under how often it runs, with its time and what it asks', async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();

    const task = await openScheduled();

    expect(within(openProfile()).getByRole('region', { name: 'Weekdays' })).toContainElement(task);
    expect(within(openProfile()).getByRole('heading', { name: 'Weekdays' })).toHaveClass('list-group-heading');
    expect(task.querySelector('.scheduled-task-title')).toHaveTextContent(/^Morning brief$/);
    expect(task.querySelector('.scheduled-task-detail')).toHaveTextContent(/^8:00 AM · Brief me on rates$/);
    // Its actions are in its sheet, not on the inSheet.
    expect(within(task).getAllByRole('button')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/scheduled-tasks', { credentials: 'include', cache: 'no-store' });
  });

  it('labels a task by its frequency, and groups the tasks of one frequency where the first is listed', async () => {
    service.scheduled = [
      { ...MORNING_BRIEF, schedule: 'cron(0 0 ? * MON-FRI *)' },
      { ...MORNING_BRIEF, id: 'task-2', schedule: 'cron(5 12 ? * 7 *)' },
      { ...MORNING_BRIEF, id: 'task-3', schedule: 'rate(1 day)' },
      { ...MORNING_BRIEF, id: 'task-4', schedule: 'cron(30 14 ? * 2 *)' },
      { ...MORNING_BRIEF, id: 'task-5', schedule: 'rate(2 hours)' },
      { ...MORNING_BRIEF, id: 'task-6', schedule: 'cron(59 23 ? * MON-FRI *)' },
      { ...MORNING_BRIEF, id: 'task-7', schedule: 'at(2026-10-14T08:30:00)' },
    ];
    await renderPage();
    await userEvent.click(avatar());
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Scheduled' }));
    await within(openProfile()).findAllByRole('listitem');

    const groups = within(openProfile()).getAllByRole('region');
    expect(groups.map((group) => [
      group.getAttribute('aria-label'),
      within(group).getAllByRole('listitem').map((task) => task.querySelector('.scheduled-task-detail')?.textContent),
    ])).toEqual([
      ['Weekdays', ['12:00 AM · Brief me on rates', '11:59 PM · Brief me on rates']],
      // EventBridge numbers the days of the week from 1, Sunday.
      ['Every Saturday', ['12:05 PM · Brief me on rates']],
      ['Daily', ['Brief me on rates']],
      ['Every Monday', ['2:30 PM · Brief me on rates']],
      ['Every 2 hours', ['Brief me on rates']],
      ['at(2026-10-14T08:30:00)', ['Brief me on rates']],
    ]);
  });

  it("opens a task's sheet on a tap, saying what it asks and when it runs in words, or as written", async () => {
    service.scheduled = [
      MORNING_BRIEF,
      { ...MORNING_BRIEF, id: 'task-2', title: 'Hourly brief', schedule: 'rate(1 hour)' },
      { ...MORNING_BRIEF, id: 'task-3', title: 'Odd brief', schedule: 'cron(nonsense)' },
    ];
    await renderPage();
    await userEvent.click(avatar());
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Scheduled' }));
    const words = [];

    for (const task of await within(openProfile()).findAllByRole('listitem')) {
      // eslint-disable-next-line no-await-in-loop -- one sheet open at a time
      const sheet = await openTask(task);
      expect(sheet.querySelector('.scheduled-task-prompt')).toHaveTextContent(/^Brief me on rates$/);
      expect(within(sheet).getByRole('button', { name: 'Pause' })).toBeEnabled();
      words.push(sheet.querySelector('.scheduled-task-schedule')?.textContent);
      // eslint-disable-next-line no-await-in-loop -- one sheet open at a time
      await closeTask(sheet);
    }

    expect(words).toEqual([
      'At 8:00 AM, Monday through Friday · America/New_York',
      'Every hour · America/New_York',
      'cron(nonsense) · America/New_York',
    ]);
  });

  it('keeps a failed scheduled edit and saves the same draft on retry', async () => {
    service.scheduled = [MORNING_BRIEF];
    service.failing.set('PATCH /scheduled-tasks/task-1', 503);
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await userEvent.clear(inSheet.getByLabelText('Prompt'));
    await userEvent.type(inSheet.getByLabelText('Prompt'), 'Keep the edited prompt');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(await inSheet.findByText('Scheduled task change failed: 503')).toBeInTheDocument();
    expect(inSheet.getByLabelText('Prompt')).toHaveValue('Keep the edited prompt');
    service.failing.delete('PATCH /scheduled-tasks/task-1');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(sheet.querySelector('.scheduled-task-prompt')).toHaveTextContent('Keep the edited prompt');
    expect(inSheet.queryByLabelText('Prompt')).toBeNull();
    expect(within(openProfile()).queryByText('Scheduled task change failed: 503')).toBeNull();
  });

  it.each([200, 503])('holds the scheduled draft until saving answers HTTP %i', async (status) => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await userEvent.clear(inSheet.getByLabelText('Prompt'));
    await userEvent.type(inSheet.getByLabelText('Prompt'), 'An unsaved draft');
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/scheduled-tasks/task-1' && init?.method === 'PATCH' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(inSheet.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(inSheet.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(inSheet.getByLabelText('Prompt')).toHaveValue('An unsaved draft');
    expect(inSheet.getByLabelText('Prompt')).toBeDisabled();
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(held).toHaveLength(1);
    await act(async () => { present(held[0], 'save response')(answer(status, { ...MORNING_BRIEF, prompt: 'An unsaved draft' })); });
    if (status === 200) {
      expect(inSheet.queryByLabelText('Prompt')).toBeNull();
      expect(sheet.querySelector('.scheduled-task-prompt')).toHaveTextContent('An unsaved draft');
    } else {
      expect(inSheet.getByLabelText('Prompt')).toHaveValue('An unsaved draft');
      expect(inSheet.getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(inSheet.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    }
  });

  it('pauses and resumes a scheduled task', async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const task = await openScheduled();
    expect(within(task).queryByText('Paused')).toBeNull();
    expect(task.querySelector('.scheduled-task')).not.toHaveClass('scheduled-task-paused');
    const sheet = await openTask(task);

    await userEvent.click(within(sheet).getByRole('button', { name: 'Pause' }));

    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([{ paused: true }]);
    expect(within(sheet).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(within(sheet).getByText('Paused')).toHaveClass('status-pill');
    // Paused is a status pill beside the name, not part of it.
    expect(task.querySelector('.scheduled-task-title')).toHaveTextContent(/^Morning brief$/);
    expect(within(task).getByText('Paused')).toHaveClass('status-pill');
    expect(task.querySelector('.scheduled-task')).toHaveClass('scheduled-task-paused');

    await userEvent.click(within(sheet).getByRole('button', { name: 'Resume' }));

    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([{ paused: true }, { paused: false }]);
    expect(within(task).queryByText('Paused')).toBeNull();
  });

  it('edits what a scheduled task asks and when it runs', async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const task = await openScheduled();
    const sheet = await openTask(task);

    await userEvent.click(within(sheet).getByRole('button', { name: 'Edit' }));
    await userEvent.clear(within(sheet).getByLabelText('Prompt'));
    await userEvent.type(within(sheet).getByLabelText('Prompt'), 'Brief me on FX');
    await userEvent.clear(within(sheet).getByLabelText('Schedule'));
    await userEvent.type(within(sheet).getByLabelText('Schedule'), 'rate(1 day)');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save' }));

    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([
      { title: 'Morning brief', prompt: 'Brief me on FX', schedule: 'rate(1 day)' },
    ]);
    expect(sheet.querySelector('.scheduled-task-prompt')).toHaveTextContent(/^Brief me on FX$/);
    await closeTask(sheet);
    expect(within(openProfile()).getByRole('region', { name: 'Daily' })).toHaveTextContent(/Brief me on FX$/);
  });

  // The Schedule field showed only the raw AWS expression, unlike the card and the list.
  it('reads the Schedule being edited in the words and time zone the sheet shows', async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const words = /^At 8:00 AM, Monday through Friday · America\/New_York$/;
    expect(sheet.querySelector('.scheduled-task-schedule')).toHaveTextContent(words);

    await userEvent.click(within(sheet).getByRole('button', { name: 'Edit' }));

    expect(sheet.querySelector('.scheduled-task-schedule')).toHaveTextContent(words);
    await userEvent.clear(within(sheet).getByLabelText('Schedule'));
    await userEvent.type(within(sheet).getByLabelText('Schedule'), 'rate(2 hours)');
    expect(sheet.querySelector('.scheduled-task-schedule')).toHaveTextContent(/^Every 2 hours · America\/New_York$/);
  });

  it("runs a scheduled task on the account's default model until the user picks another", async () => {
    service.models = [
      { key: 'plan', label: 'GPT', provider: 'openai' },
      { key: 'sonnet', label: 'Sonnet', provider: 'anthropic' },
    ];
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const task = await openScheduled();
    const inSheet = within(await openTask(task));

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    expect(inSheet.getByLabelText('Model')).toHaveValue('plan');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await userEvent.selectOptions(inSheet.getByLabelText('Model'), 'Sonnet');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));

    const fields = { title: 'Morning brief', prompt: 'Brief me on rates', schedule: 'cron(0 8 ? * MON-FRI *)' };
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([fields, { ...fields, model: 'sonnet' }]);
    expect(inSheet.getByLabelText('Model')).toHaveValue('sonnet');
  });

  it('shows a model the account no longer has as unavailable, not as its default', async () => {
    service.models = [{ key: 'plan', label: 'GPT', provider: 'openai' }];
    service.scheduled = [{ ...MORNING_BRIEF, model: 'retired' }];
    await renderPage();
    const inSheet = within(await openTask(await openScheduled()));

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));

    const model = inSheet.getByLabelText('Model');
    expect(model).toHaveValue('retired');
    expect(within(model).getByRole('option', { name: 'retired (unavailable)' })).toBeDisabled();
  });

  it.each([undefined, 'plan', 'sonnet'])('keeps scheduled prompt edits available after the model catalog fails with model %s', async (model) => {
    service.scheduled = [{ ...MORNING_BRIEF, ...(model === undefined ? {} : { model }) }];
    await renderPage();
    service.failing.set('GET /agent/models', 503);
    const task = await openScheduled();
    const panel = within(openProfile());
    await panel.findByText('Failed to load the models: 503');
    const sheet = await openTask(task);
    const inSheet = within(sheet);
    // The open sheet covers the tab, so it says why the models failed itself.
    expect(inSheet.getByText('Failed to load the models: 503')).toBeInTheDocument();
    expect(inSheet.getByRole('button', { name: 'Edit' })).toBeEnabled();
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    expect(inSheet.getByLabelText('Model')).toBeDisabled();
    expect(inSheet.getByLabelText('Model')).toHaveValue(model ?? '');
    await userEvent.clear(inSheet.getByLabelText('Prompt'));
    await userEvent.type(inSheet.getByLabelText('Prompt'), 'Brief me on FX');
    await userEvent.clear(inSheet.getByLabelText('Schedule'));
    await userEvent.type(inSheet.getByLabelText('Schedule'), 'rate(1 day)');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([
      { title: 'Morning brief', prompt: 'Brief me on FX', schedule: 'rate(1 day)' },
    ]);
    expect(sheet.querySelector('.scheduled-task-prompt')).toHaveTextContent('Brief me on FX');
    expect(service.scheduled[0]?.model).toBe(model);
    expect(panel.getByText('Failed to load the models: 503')).toBeInTheDocument();
  });

  it.each([undefined, 'plan', 'sonnet'])('selects a server-provided Cartridge model during a catalog outage from %s', async (model) => {
    service.scheduled = [{ ...MORNING_BRIEF, ...(model === undefined ? {} : { model }) }];
    await renderPage();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/agent/models' ? answer(503, {
        detail: 'Plan Usage was revoked',
        cartridgeModels: [{ key: 'sonnet', label: 'Sonnet', provider: 'anthropic' }],
      }) : chatService(url, init),
    );
    const task = await openScheduled();
    const panel = within(openProfile());
    await panel.findByText(/Failed to load the models: 503/);
    const inSheet = within(await openTask(task));
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    const chooser = inSheet.getByLabelText('Model');
    expect(chooser).toBeEnabled();
    expect(chooser).toHaveValue(model ?? '');
    expect(within(chooser).queryByRole('option', { name: 'GPT' })).not.toBeInTheDocument();
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(sent('PATCH', '/scheduled-tasks/task-1')[0]).not.toHaveProperty('model');
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await userEvent.selectOptions(inSheet.getByLabelText('Model'), 'Sonnet');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    expect(inSheet.getByLabelText('Model')).toHaveValue('sonnet');
    if (model !== 'sonnet') expect(sent('PATCH', '/scheduled-tasks/task-1')[1]).toHaveProperty('model', 'sonnet');
    expect(panel.getByText('Failed to load the models: 503: Plan Usage was revoked')).toBeInTheDocument();
  });

  it('keeps the account default after choosing then undoing a Cartridge choice during an outage', async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/agent/models' ? answer(503, {
        detail: 'Plan Usage was revoked',
        cartridgeModels: [{ key: 'sonnet', label: 'Sonnet', provider: 'anthropic' }],
      }) : chatService(url, init),
    );
    const task = await openScheduled();
    await within(openProfile()).findByText(/Failed to load the models: 503/);
    const inSheet = within(await openTask(task));
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await userEvent.selectOptions(inSheet.getByLabelText('Model'), 'Sonnet');
    await userEvent.selectOptions(inSheet.getByLabelText('Model'), 'Account default (models unavailable)');
    expect(inSheet.getByLabelText('Model')).toHaveValue('');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(sent('PATCH', '/scheduled-tasks/task-1')[0]).not.toHaveProperty('model');
  });

  it('reports a task edit failure separately from the unavailable model catalog', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, model: 'sonnet' }];
    await renderPage();
    service.failing.set('GET /agent/models', 503);
    service.failing.set('PATCH /scheduled-tasks/task-1', 502);
    const task = await openScheduled();
    await within(openProfile()).findByText('Failed to load the models: 503');
    const inSheet = within(await openTask(task));
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await userEvent.clear(inSheet.getByLabelText('Prompt'));
    await userEvent.type(inSheet.getByLabelText('Prompt'), 'Brief me on FX');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(inSheet.getByText('Scheduled task change failed: 502')).toBeInTheDocument();
    expect(inSheet.getByText('Failed to load the models: 503')).toBeInTheDocument();
    expect(inSheet.getByLabelText('Prompt')).toHaveValue('Brief me on FX');
    expect(service.scheduled[0]).toEqual({ ...MORNING_BRIEF, model: 'sonnet' });
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([
      { title: 'Morning brief', prompt: 'Brief me on FX', schedule: 'cron(0 8 ? * MON-FRI *)' },
    ]);
  });

  it.each([undefined, 'sonnet'])('offers no edit until the models load with model %s', async (model) => {
    service.scheduled = [{ ...MORNING_BRIEF, ...(model === undefined ? {} : { model }) }];
    await renderPage();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/agent/models' ? new Promise<Response>(() => {}) : chatService(url, init),
    );

    const inSheet = within(await openTask(await openScheduled()));

    expect(inSheet.getByRole('button', { name: 'Edit' })).toBeDisabled();
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    expect(inSheet.queryByLabelText('Prompt')).toBeNull();
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([]);
  });

  it('asks before deleting a scheduled task, and keeps it on Cancel', async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const sheet = await openTask(await openScheduled());

    await userEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));

    expect(within(sheet).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Close', 'Delete task', 'Cancel']);
    expect(within(sheet).getByRole('button', { name: 'Delete task' })).toHaveClass('button-destructive');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    expect(within(sheet).getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toEqual([]);
    // The tab, under the open sheet, is hidden from assistive tech.
    expect(within(openProfile()).getAllByRole('listitem', { hidden: true })).toHaveLength(1);
  });

  it('deletes a scheduled task from its sheet, which closes', async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const sheet = await openTask(await openScheduled());

    await deleteTask(sheet);

    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/scheduled-tasks/task-1', { method: 'DELETE', credentials: 'include' });
    await waitFor(() => expect(within(openProfile()).queryByRole('dialog')).toBeNull());
    expect(within(openProfile()).getByRole('tabpanel')).toHaveTextContent(/^No scheduled tasks yet\.$/);
  });

  it('says when there are no scheduled tasks, or why they could not load', async () => {
    await renderPage();
    await userEvent.click(avatar());
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Scheduled' }));
    expect(await within(openProfile()).findByText('No scheduled tasks yet.')).toBeInTheDocument();
    expect(within(openProfile()).queryByRole('list')).toBeNull();
    await userEvent.click(screen.getByLabelText('Close agent profile'));
    service.failing.set('GET /scheduled-tasks', 503);

    await userEvent.click(avatar());
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Scheduled' }));

    expect(await within(openProfile()).findByText('Scheduled tasks failed: 503')).toHaveClass('agent-profile-error');
  });

  it('keeps a scheduled task whose delete failed, and says so in the sheet, then in the tab', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service.scheduled = [MORNING_BRIEF];
    service.failing.set('DELETE /scheduled-tasks/task-1', 502);
    await renderPage();
    const sheet = await openTask(await openScheduled());

    await deleteTask(sheet);

    expect(await within(sheet).findByText("Couldn't delete Morning brief. Try again.")).toHaveClass('agent-profile-error');
    expect(error).toHaveBeenCalledWith(new Error('Deleting Morning brief failed: 502'));
    expect(within(sheet).getByRole('button', { name: 'Delete' })).toBeEnabled();
    await closeTask(sheet);
    expect(within(openProfile()).getByText("Couldn't delete Morning brief. Try again.")).toHaveClass('agent-profile-error');
    expect(within(openProfile()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('keeps a scheduled task whose delete never reached the Chat Service, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });

    await deleteTask(sheet);

    expect(await within(sheet).findByText("Couldn't delete Morning brief. Try again.")).toHaveClass('agent-profile-error');
    expect(error).toHaveBeenCalledWith(new Error('Deleting Morning brief failed: Failed to fetch', { cause: new TypeError('Failed to fetch') }));
    await closeTask(sheet);
    expect(within(openProfile()).getAllByRole('listitem')).toHaveLength(1);
  });

  it("opens another task's sheet clear of the failure the last one showed", async () => {
    service.scheduled = [MORNING_BRIEF, { ...MORNING_BRIEF, id: 'task-2', title: 'Evening wrap' }];
    service.failing.set('PATCH /scheduled-tasks/task-1', 400);
    await renderPage();
    await userEvent.click(avatar());
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Scheduled' }));
    const [morning, evening] = await within(openProfile()).findAllByRole('listitem');
    const first = await openTask(present(morning, 'the first task'));
    await userEvent.click(within(first).getByRole('button', { name: 'Pause' }));
    await within(first).findByText('Scheduled task change failed: 400');
    await closeTask(first);

    const second = await openTask(present(evening, 'the second task'));

    expect(within(openProfile()).queryByText('Scheduled task change failed: 400')).toBeNull();
    expect(within(second).getByRole('button', { name: 'Pause' })).toBeEnabled();
  });

  it('closes the sheet without a change', async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const sheet = await openTask(await openScheduled());

    await closeTask(sheet);

    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('http://chat.test/scheduled-tasks/'))).toEqual([]);
    expect(within(openProfile()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('cancels an edit without changing the task', async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const task = await openScheduled();
    const sheet = await openTask(task);

    await userEvent.click(within(sheet).getByRole('button', { name: 'Edit' }));
    await userEvent.type(within(sheet).getByLabelText('Title'), ' and FX');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));

    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([]);
    expect(within(sheet).queryByLabelText('Title')).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(task.querySelector('.scheduled-task-title')).toHaveTextContent(/^Morning brief$/);
  });

  it('changes or deletes only the task acted on', async () => {
    service.scheduled = [MORNING_BRIEF, { ...MORNING_BRIEF, id: 'task-2', title: 'Evening wrap' }];
    await renderPage();
    await userEvent.click(avatar());
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Scheduled' }));
    const [morning, evening] = await within(openProfile()).findAllByRole('listitem');
    expect(within(openProfile()).queryByText('No scheduled tasks yet.')).toBeNull();
    const sheet = await openTask(present(morning, 'the first task'));

    await userEvent.click(within(sheet).getByRole('button', { name: 'Pause' }));
    expect(present(evening, 'the second task').querySelector('.scheduled-task-title')).toHaveTextContent(/^Evening wrap$/);
    expect(within(present(evening, 'the second task')).queryByText('Paused')).toBeNull();
    await deleteTask(sheet);
    await waitFor(() => expect(within(openProfile()).queryByRole('dialog')).toBeNull());

    const left = within(openProfile()).getAllByRole('listitem');
    expect(left.map((task) => task.querySelector('.scheduled-task-title')?.textContent)).toEqual(['Evening wrap']);
  });

  it('clears an earlier failure once a change or delete succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service.scheduled = [MORNING_BRIEF];
    service.failing.set('PATCH /scheduled-tasks/task-1', 400);
    service.failing.set('DELETE /scheduled-tasks/task-1', 502);
    await renderPage();
    const sheet = await openTask(await openScheduled());

    await userEvent.click(within(sheet).getByRole('button', { name: 'Pause' }));
    await within(openProfile()).findByText('Scheduled task change failed: 400');
    service.failing.delete('PATCH /scheduled-tasks/task-1');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Pause' }));
    expect(within(openProfile()).queryByText('Scheduled task change failed: 400')).toBeNull();

    await deleteTask(sheet);
    await within(openProfile()).findByText("Couldn't delete Morning brief. Try again.");
    service.failing.delete('DELETE /scheduled-tasks/task-1');
    await deleteTask(sheet);
    expect(within(openProfile()).queryByText("Couldn't delete Morning brief. Try again.")).toBeNull();
  });

  it('shows why a scheduled task change failed', async () => {
    service.scheduled = [MORNING_BRIEF];
    service.failing.set('PATCH /scheduled-tasks/task-1', 400);
    await renderPage();
    const sheet = await openTask(await openScheduled());

    await userEvent.click(within(sheet).getByRole('button', { name: 'Pause' }));

    expect(await within(sheet).findByText('Scheduled task change failed: 400')).toHaveClass('agent-profile-error');
  });

  it("shows the cartridge's computer for the open chat in the Computer tab, under the agent's name", async () => {
    await renderPage();
    await userEvent.click(avatar());

    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Computer' }));

    expect(within(openProfile()).getByRole('tabpanel')).toHaveTextContent(/^Ada Bot: research-agent computer for main-1$/);
  });

  it('keeps the computer it opened through other tabs and a close, so coming back shows it at once', async () => {
    await renderPage();
    await userEvent.click(avatar());

    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Identity' }));
    expect(within(openProfile()).getByRole('tabpanel')).toHaveAccessibleName('Identity');
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Computer' }));
    await userEvent.click(screen.getByLabelText('Close agent profile'));
    expect(profile()).toBeNull();
    await userEvent.click(avatar());

    expect(within(openProfile()).getByRole('tab', { selected: true })).toHaveAccessibleName('Computer');
    expect(within(openProfile()).getByRole('tabpanel')).toHaveTextContent(/^Ada Bot: research-agent computer for main-1$/);
    expect(cartridge.computerMounts).toBe(1);
  });

  it("shows the cartridge's agent name in the header and the failure in the profile when the agent cannot load", async () => {
    service.failing.set('GET /agent', 503);
    await renderPage();
    expect(avatar()).toHaveTextContent(/^Ada$/);

    await userEvent.click(avatar());

    expect(openProfile().querySelector('.agent-profile-error')).toHaveTextContent(/^Agent profile failed: 503$/);
  });

  const openIdentity = async () => {
    await userEvent.click(avatar());
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Identity' }));
    await settle();
    return within(openProfile().querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])') as HTMLElement);
  };

  it("opens the Identity tab from the edit badge on the agent's avatar", async () => {
    await renderPage();
    await userEvent.click(avatar());

    await userEvent.click(within(openProfile()).getByRole('button', { name: 'Edit agent' }));
    await settle();

    expect(within(openProfile()).getByRole('tab', { name: 'Identity' })).toHaveAttribute('aria-selected', 'true');
    expect(within(openProfile()).getByRole('tabpanel')).toHaveAccessibleName('Identity');
    expect(within(openProfile()).getByRole('button', { name: 'Open Agent Identity' })).toBeInTheDocument();
  });

  it('shows Agent Identity, Soul, and Memory as cards in the Identity tab', async () => {
    await renderPage();

    const identity = await openIdentity();

    expect(identity.getAllByRole('button').map((card) => card.getAttribute('aria-label'))).toEqual([
      'Open Agent Identity',
      'Open Soul',
      'Open Memory',
    ]);
    expect(identity.queryByRole('textbox')).toBeNull();
  });

  type Panel = ReturnType<typeof within>;
  const openFile = async (identity: Panel, file: string) => {
    await userEvent.click(identity.getByRole('button', { name: `Open ${file}` }));
    return within(identity.getByRole('article', { name: file }));
  };
  const editFile = async (identity: Panel, file: string) => {
    const opened = await openFile(identity, file);
    await userEvent.click(opened.getByRole('button', { name: `Edit ${file}` }));
    return opened;
  };
  const click = async (identity: Panel, name: string) => {
    await userEvent.click(identity.getByRole('button', { name }));
    await settle();
  };

  it("lists Agent Identity's Avatar field once it names an emoji", async () => {
    service.agentIdentity = { ...service.agentIdentity, avatar: '🪶' };
    await renderPage();
    const identity = await openIdentity();

    const agentIdentity = await openFile(identity, 'Agent Identity');

    expect(agentIdentity.getAllByRole('term').map((term) => term.textContent)).toEqual(['Name', 'Character', 'Vibe', 'Avatar']);
    expect(agentIdentity.getAllByRole('definition').at(-1)).toHaveTextContent(/^🪶$/);
  });

  it('opens Agent Identity and Soul read-only, each with a note on what it is', async () => {
    await renderPage();
    const identity = await openIdentity();

    const agentIdentity = await openFile(identity, 'Agent Identity');

    expect(identity.queryByRole('textbox')).toBeNull();
    // With no emoji, the avatar shows the default, so read-only Agent Identity lists no Avatar field.
    expect(agentIdentity.getAllByRole('term').map((term) => term.textContent)).toEqual(['Name', 'Character', 'Vibe']);
    expect(agentIdentity.getAllByRole('definition').map((value) => value.textContent)).toEqual([
      'Ada Bot',
      'A research assistant',
      'Warm',
    ]);
    expect(identity.queryByRole('status')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/identity', { credentials: 'include', cache: 'no-store' });
    expect(agentIdentity.getByRole('region', { name: 'About Agent Identity' })).toHaveTextContent(
      /^About this fileWho your agent is to you: its name, character, vibe, and avatar \(an emoji, or blank for the default avatar\)\. The agent reads it at the start of every message and uses your edits from your next message on\. It may change this file itself, and tells you in the chat when it does\.$/,
    );

    await click(identity, 'Back to files');
    const soul = await openFile(identity, 'Soul');

    expect(identity.queryByRole('textbox')).toBeNull();
    expect(soul.getByText('Be candid.')).toHaveClass('agent-file-text');
    expect(soul.getByRole('region', { name: 'About Soul' })).toHaveTextContent(
      /^About this fileThe values and habits your agent keeps in every chat\. The agent reads it at the start of every message and uses your edits from your next message on\. It may change this file itself, and tells you in the chat when it does\. Soul shapes only its manner: its rules for grounding answers and running commands live in its skills, which Soul cannot change\.$/,
    );
  });

  it('edits Agent Identity and Soul from their saved text', async () => {
    await renderPage();
    const identity = await openIdentity();

    await editFile(identity, 'Agent Identity');

    expect(identity.getByLabelText<HTMLInputElement>('Name').value).toBe('Ada Bot');
    expect(identity.getByLabelText<HTMLInputElement>('Character').value).toBe('A research assistant');
    expect(identity.getByLabelText<HTMLInputElement>('Vibe').value).toBe('Warm');
    expect(identity.getByLabelText<HTMLInputElement>('Avatar').value).toBe('');
    expect(identity.queryByRole('button', { name: 'Edit Agent Identity' })).toBeNull();

    await click(identity, 'Back to files');
    await editFile(identity, 'Soul');

    expect(identity.getByRole<HTMLTextAreaElement>('textbox', { name: 'Soul' }).value).toBe('Be candid.');
  });

  it('renames the agent, updating its header and profile', async () => {
    await renderPage();
    const identity = await openIdentity();
    const agentIdentity = await editFile(identity, 'Agent Identity');

    await userEvent.clear(identity.getByLabelText('Name'));
    await userEvent.type(identity.getByLabelText('Name'), 'Quill');
    await click(identity, 'Save Agent Identity');

    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/identity', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Quill', character: 'A research assistant', vibe: 'Warm', avatar: '' }),
    });
    expect(avatar()).toHaveTextContent(/^Quill$/);
    expect(openProfile().querySelector('.agent-profile-name')).toHaveTextContent(/^Quill$/);
    expect(identity.queryByRole('textbox')).toBeNull();
    expect(agentIdentity.getAllByRole('definition')[0]).toHaveTextContent(/^Quill$/);
  });

  it('saves an edited Soul and shows it read-only again', async () => {
    await renderPage();
    const identity = await openIdentity();
    const soul = await editFile(identity, 'Soul');

    await userEvent.clear(identity.getByRole('textbox', { name: 'Soul' }));
    await userEvent.type(identity.getByRole('textbox', { name: 'Soul' }), 'Answer in haiku.');
    await click(identity, 'Save Soul');

    expect(service.soul).toBe('Answer in haiku.');
    // Saved sits in the file's header, just before Edit, so the document does not move down a line.
    const saved = soul.getByRole('status');
    expect(saved).toHaveTextContent(/^Saved$/);
    expect(saved.nextElementSibling).toBe(soul.getByRole('button', { name: 'Edit Soul' }));
    expect(identity.queryByRole('textbox')).toBeNull();
    expect(soul.getByText('Answer in haiku.')).toHaveClass('agent-file-text');
  });

  it('discards an edit on Cancel', async () => {
    await renderPage();
    const identity = await openIdentity();
    const soul = await editFile(identity, 'Soul');

    await userEvent.type(identity.getByRole('textbox', { name: 'Soul' }), ' Always.');
    await click(identity, 'Cancel editing Soul');

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    expect(identity.queryByRole('textbox')).toBeNull();
    expect(soul.getByText('Be candid.')).toHaveClass('agent-file-text');

    await click(identity, 'Edit Soul');

    expect(identity.getByRole<HTMLTextAreaElement>('textbox', { name: 'Soul' }).value).toBe('Be candid.');
  });

  const memoryLines = (identity: Panel) =>
    identity.getAllByRole('textbox', { name: /^Memory line \d+$/ }).map((line: HTMLElement) => (line as HTMLInputElement).value);
  const memoryText = (identity: Panel) => identity.getAllByRole('listitem').map((line: HTMLElement) => line.textContent);

  it('shows Memory as one line per memory, with a note on what it is', async () => {
    await renderPage();
    const identity = await openIdentity();

    const memory = await openFile(identity, 'Memory');

    expect(memoryText(memory)).toEqual(['Trades copper futures', 'Lives in Paris']);
    expect(identity.queryByRole('textbox')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/memory', { credentials: 'include', cache: 'no-store' });
    expect(memory.getByRole('region', { name: 'About Memory' })).toHaveTextContent(
      /^About this fileWhat your agent has learned about you and keeps from chat to chat, one memory per line\. The agent reads it at the start of every message and uses your edits from your next message on\. Edit a line to correct it, or delete it to make the agent forget it\.$/,
    );

    await click(identity, 'Edit Memory');

    expect(memoryLines(identity)).toEqual(['Trades copper futures', 'Lives in Paris']);
  });

  const memoryPuts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');

  it('saves the Memory lines the user edited, and only those', async () => {
    await renderPage();
    const identity = await openIdentity();
    const memory = await editFile(identity, 'Memory');

    await userEvent.clear(identity.getByRole('textbox', { name: 'Memory line 2' }));
    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 2' }), 'Lives in London');
    await click(identity, 'Save Memory');

    expect(memoryText(memory)).toEqual(['Trades copper futures', 'Lives in London']);
    expect(identity.getByRole('status')).toHaveTextContent(/^Saved$/);

    // A saved line is no longer an edit: saving again sends nothing.
    await click(identity, 'Edit Memory');
    await click(identity, 'Save Memory');

    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/memory/mem-paris', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Lives in London' }),
    });
    expect(memoryPuts()).toHaveLength(1);
    expect(memoryText(memory)).toEqual(['Trades copper futures', 'Lives in London']);
  });

  const memoryDeletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');

  it('deletes a Memory line on Save', async () => {
    await renderPage();
    const identity = await openIdentity();
    const memory = await editFile(identity, 'Memory');

    await click(identity, 'Delete Memory line 1');

    expect(memoryDeletes()).toHaveLength(0);
    expect(memoryLines(identity)).toEqual(['Lives in Paris']);

    // The lines left after a delete are not edits.
    await click(identity, 'Save Memory');

    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/memory/mem-copper', { method: 'DELETE', credentials: 'include' });
    expect(memoryPuts()).toHaveLength(0);
    expect(memoryText(memory)).toEqual(['Lives in Paris']);
    expect(service.memory.map((line) => line.text)).toEqual(['Lives in Paris']);
  });

  it('keeps a deleted Memory line when the edit is cancelled', async () => {
    await renderPage();
    const identity = await openIdentity();
    const memory = await editFile(identity, 'Memory');

    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    await click(identity, 'Delete Memory line 1');
    await click(identity, 'Cancel editing Memory');

    expect(memoryPuts()).toHaveLength(0);
    expect(memoryDeletes()).toHaveLength(0);
    expect(memoryText(memory)).toEqual(['Trades copper futures', 'Lives in Paris']);
  });

  it('says a saved Memory line was already removed and refreshes the list', async () => {
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Memory');
    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    service.memory = service.memory.filter((line) => line.id !== 'mem-paris');
    service.failing.set('PUT /agent/memory/mem-paris', 404);

    await click(identity, 'Save Memory');

    expect(identity.getByRole('alert')).toHaveTextContent(/^This Memory line was already removed\.$/);
    await waitFor(() => expect(memoryText(identity)).toEqual(['Trades copper futures']));
    expect(identity.queryByText('Saved')).toBeNull();
    expect(identity.queryByRole('textbox', { name: 'Memory line 2' })).toBeNull();
  });

  it.each([false, true])('preserves an unsent Memory draft after a removed first edit and refresh failure %s', async (refreshFails) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Memory');
    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 1' }), ' and gold');
    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    service.memory = service.memory.filter((line) => line.id !== 'mem-copper');
    service.failing.set('PUT /agent/memory/mem-copper', 404);
    if (refreshFails) service.failing.set('GET /agent/memory', 503);

    await click(identity, 'Save Memory');

    expect(identity.getByText('This Memory line was already removed.')).toHaveAttribute('role', 'alert');
    expect(memoryPuts().map(([url]) => url)).toEqual(['http://chat.test/agent/memory/mem-copper']);
    expect(service.memory).toEqual([{ id: 'mem-paris', text: 'Lives in Paris' }]);
    if (refreshFails) {
      expect(await identity.findByText('Memory could not be loaded.')).toBeInTheDocument();
      service.failing.delete('GET /agent/memory');
      await click(identity, 'Retry');
    }
    await waitFor(() => expect(memoryLines(identity)).toEqual(['Lives in Paris and London']));
    expect(identity.queryByText('Trades copper futures and gold')).toBeNull();
    expect(identity.queryByText('Saved')).toBeNull();

    await click(identity, 'Save Memory');

    expect(service.memory).toEqual([{ id: 'mem-paris', text: 'Lives in Paris and London' }]);
    expect(memoryPuts().map(([url]) => url)).toEqual([
      'http://chat.test/agent/memory/mem-copper',
      'http://chat.test/agent/memory/mem-paris',
    ]);
    expect(memoryText(identity)).toEqual(['Lives in Paris and London']);
    expect(identity.getByRole('status')).toHaveTextContent(/^Saved$/);
  });

  it('recovers only unsent edits and retains fresh remote lines after a middle Memory edit disappears', async () => {
    service.memory.push({ id: 'mem-third', text: 'Prefers tea' });
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Memory');
    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 1' }), ' and gold');
    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 3' }), ' and coffee');
    service.memory = service.memory.filter((line) => line.id !== 'mem-paris');
    service.memory.push({ id: 'mem-new', text: 'Works remotely' });
    service.failing.set('PUT /agent/memory/mem-paris', 404);

    await click(identity, 'Save Memory');

    await waitFor(() => expect(memoryLines(identity)).toEqual([
      'Trades copper futures and gold', 'Prefers tea and coffee', 'Works remotely',
    ]));
    expect(memoryPuts().map(([url]) => url)).toEqual([
      'http://chat.test/agent/memory/mem-copper', 'http://chat.test/agent/memory/mem-paris',
    ]);
    expect(service.memory.map((line) => line.text)).toEqual([
      'Trades copper futures and gold', 'Prefers tea', 'Works remotely',
    ]);

    await click(identity, 'Save Memory');

    expect(memoryPuts().map(([url]) => url)).toEqual([
      'http://chat.test/agent/memory/mem-copper', 'http://chat.test/agent/memory/mem-paris',
      'http://chat.test/agent/memory/mem-third',
    ]);
    expect(memoryDeletes()).toHaveLength(0);
    expect(service.memory.map((line) => line.text)).toEqual([
      'Trades copper futures and gold', 'Prefers tea and coffee', 'Works remotely',
    ]);
  });

  it('discards recovered Memory edits when cancelling', async () => {
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Memory');
    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 1' }), ' and gold');
    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    service.memory = service.memory.filter((line) => line.id !== 'mem-copper');
    service.failing.set('PUT /agent/memory/mem-copper', 404);
    await click(identity, 'Save Memory');
    await waitFor(() => expect(memoryLines(identity)).toEqual(['Lives in Paris and London']));

    await click(identity, 'Cancel editing Memory');
    await click(identity, 'Edit Memory');

    expect(memoryLines(identity)).toEqual(['Lives in Paris']);
  });

  it('shows a failed refresh after a removed Memory line without claiming it was saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Memory');
    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    service.memory = service.memory.filter((line) => line.id !== 'mem-paris');
    service.failing.set('PUT /agent/memory/mem-paris', 404);
    service.failing.set('GET /agent/memory', 503);

    await click(identity, 'Save Memory');

    expect(identity.getByText('This Memory line was already removed.')).toHaveAttribute('role', 'alert');
    expect(await identity.findByText('Memory could not be loaded.')).toBeInTheDocument();
    expect(identity.queryByText('Saved')).toBeNull();
    expect(identity.queryByRole('textbox', { name: 'Memory line 2' })).toBeNull();
    service.failing.delete('GET /agent/memory');
    await click(identity, 'Retry');
    await waitFor(() => expect(memoryText(identity)).toEqual(['Trades copper futures']));
    expect(identity.queryByText('Saved')).toBeNull();
  });

  it('says why a Memory edit could not be saved, until the next save', async () => {
    service.failing.set('PUT /agent/memory/mem-paris', 503);
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Memory');

    await userEvent.type(identity.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    await click(identity, 'Save Memory');

    expect(identity.getByRole('alert')).toHaveTextContent(/^Saving Memory failed: 503$/);
    expect(identity.queryByRole('status')).toBeNull();

    service.failing.delete('PUT /agent/memory/mem-paris');
    await click(identity, 'Save Memory');

    expect(identity.queryByRole('alert')).toBeNull();
    expect(identity.getByRole('status')).toHaveTextContent(/^Saved$/);
    expect(service.memory.map((line) => line.text)).toEqual(['Trades copper futures', 'Lives in Paris and London']);
  });

  it('says why a Memory line could not be deleted', async () => {
    service.failing.set('DELETE /agent/memory/mem-copper', 502);
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Memory');

    await click(identity, 'Delete Memory line 1');
    await click(identity, 'Save Memory');

    expect(identity.getByRole('alert')).toHaveTextContent(/^Deleting a Memory line failed: 502$/);
    expect(memoryLines(identity)).toEqual(['Lives in Paris']);

    service.failing.delete('DELETE /agent/memory/mem-copper');
    await click(identity, 'Save Memory');

    expect(identity.queryByRole('alert')).toBeNull();
    expect(service.memory.map((line) => line.text)).toEqual(['Lives in Paris']);
  });

  it('says when the agent has no Memory yet', async () => {
    service.memory = [];
    await renderPage();
    const identity = await openIdentity();

    await openFile(identity, 'Memory');

    expect(identity.getByText('No memories yet.')).toBeInTheDocument();
    expect(identity.queryByRole('button', { name: 'Edit Memory' })).toBeNull();
    expect(identity.queryByRole('button', { name: 'Save Memory' })).toBeNull();
  });

  it('shows a file loading until it arrives, while the other files open', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/agent/soul' ? new Promise<Response>(() => {}) : chatService(url, init),
    );
    await renderPage();
    const identity = await openIdentity();

    const soul = await openFile(identity, 'Soul');

    expect(soul.getByRole('status')).toHaveAccessibleName('Loading Soul');
    expect(soul.queryByRole('button', { name: 'Edit Soul' })).toBeNull();
    await click(identity, 'Back to files');
    const memory = await openFile(identity, 'Memory');
    expect(memory.getAllByRole('listitem').map((line) => line.textContent)).toEqual(['Trades copper futures', 'Lives in Paris']);
  });

  it('says why one file could not load on that file only, and loads it on Retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    service.failing.set('GET /agent/identity', 500);
    await renderPage();
    const identity = await openIdentity();

    expect(identity.queryByRole('alert')).toBeNull();
    const memory = await openFile(identity, 'Memory');
    expect(memory.getAllByRole('listitem').map((line) => line.textContent)).toEqual(['Trades copper futures', 'Lives in Paris']);
    await click(identity, 'Back to files');
    const agentIdentity = await openFile(identity, 'Agent Identity');
    expect(agentIdentity.getByRole('alert')).toHaveTextContent(/^Agent Identity could not be loaded\.$/);
    expect(error).toHaveBeenCalledWith(new Error('Loading Agent Identity failed: 500'));
    expect(agentIdentity.queryByRole('button', { name: 'Edit Agent Identity' })).toBeNull();

    service.failing.delete('GET /agent/identity');
    await click(identity, 'Retry');

    const loaded = within(identity.getByRole('article', { name: 'Agent Identity' }));
    expect(loaded.queryByRole('alert')).toBeNull();
    expect(loaded.getAllByRole('definition')[0]).toHaveTextContent(/^Ada Bot$/);
  });

  it.each(['Soul', 'Memory'])('saves %s in place, without submitting the page', async (file) => {
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, file);

    // Save sits in the file's header, outside the form it submits.
    const form = present(identity.getByRole<HTMLButtonElement>('button', { name: `Save ${file}` }).form, `the ${file} form`);
    expect(fireEvent.submit(form)).toBe(false);
    await settle();
  });

  it('says why an edit could not be saved, until the next save', async () => {
    await renderPage();
    const identity = await openIdentity();
    const saveSoul = async () => {
      await click(identity, 'Save Soul');
    };
    await editFile(identity, 'Soul');

    await saveSoul();
    service.failing.set('PUT /agent/soul', 503);
    await click(identity, 'Edit Soul');
    await saveSoul();

    expect(identity.getByRole('alert')).toHaveTextContent(/^Saving Soul failed: 503$/);
    expect(identity.queryByRole('status')).toBeNull();

    service.failing.delete('PUT /agent/soul');
    await saveSoul();

    expect(identity.queryByRole('alert')).toBeNull();
    expect(identity.getByRole('status')).toHaveTextContent(/^Saved$/);
  });

  it('drops a failed save message once the edit is cancelled', async () => {
    service.failing.set('PUT /agent/soul', 503);
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Soul');

    await click(identity, 'Save Soul');
    await click(identity, 'Cancel editing Soul');

    expect(identity.queryByRole('alert')).toBeNull();
  });

  const identityArticle = () => document.querySelector('article[aria-label="Agent Identity"]');

  const choosePicture = async (identity: Panel, name: string) => {
    await userEvent.upload(identity.getByLabelText('Upload picture'), new File(['png'], name, { type: 'image/png' }));
    await settle();
  };

  it("shows the agent's picture in the chat header, the profile header, and Agent Identity", async () => {
    service.agentPicture = PICTURE;
    await renderPage();

    expect(pictureIn(avatar())).toBe(PICTURE);
    const identity = await openIdentity();
    expect(pictureIn(openProfile().querySelector('.agent-profile-header'))).toBe(PICTURE);
    await openFile(identity, 'Agent Identity');

    expect(pictureIn(identityArticle())).toBe(PICTURE);
  });

  it('uploads a picture for the agent, resized small, from the Agent Identity edit view', async () => {
    const resized = 'data:image/webp;base64,UklGRg==';
    const canvas = resizing(resized);
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Agent Identity');

    await choosePicture(identity, 'quill.png');

    expect(canvas.drawImage).toHaveBeenCalledWith(canvas.image, 0, 0, 256, 128);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/webp', 0.9);
    expect(pictureIn(identityArticle())).toBe(resized);
    expect(requestsTo('/agent/picture')).toEqual([]);

    await click(identity, 'Save Agent Identity');

    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/picture', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ picture: resized }),
    });
    expect(pictureIn(avatar())).toBe(resized);
    expect(identity.queryByRole('textbox')).toBeNull();
    expect(pictureIn(identityArticle())).toBe(resized);
  });

  it.each([
    { name: 'stops a pending picture save after an account switch', accountId: 'acct-second', owners: [] },
    { name: 'completes a pending picture save after a same-account auth refresh', accountId: 'acct-first', owners: ['acct-first'] },
  ])('$name', async ({ accountId, owners }) => {
    const resized = 'data:image/webp;base64,UklGRg==';
    resizing(resized);
    let finishIdentity!: (response: Response) => void;
    const pendingIdentity = new Promise<Response>((resolve) => { finishIdentity = resolve; });
    const pictureOwners: (string | undefined)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/agent/identity' && init?.method === 'PUT') return pendingIdentity;
      if (url === 'http://chat.test/agent/picture' && init?.method === 'PUT') pictureOwners.push(cartridge.auth.accountId);
      return chatService(url, init);
    });
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    const identity = await openIdentity();
    await editFile(identity, 'Agent Identity');
    await choosePicture(identity, 'first-account.png');
    await userEvent.click(identity.getByRole('button', { name: 'Save Agent Identity' }));
    expect(requestsTo('/agent/identity')).toContain('PUT');
    expect(pictureOwners).toEqual([]);

    service.agentPicture = PICTURE;
    cartridge.auth = auth({ accountId });
    view.rerender(<Page />);
    await settle();
    finishIdentity(answer(200, { status: 'saved' }));
    await settle();

    expect(pictureOwners).toEqual(owners);
    expect(service.agentPicture).toBe(owners.length ? resized : PICTURE);
  });

  it('refuses a picture continuation before a switching account rerenders', async () => {
    resizing('data:image/webp;base64,UklGRg==');
    let finishIdentity!: (response: Response) => void;
    const pendingIdentity = new Promise<Response>((resolve) => { finishIdentity = resolve; });
    let current = true;
    let cookieAccount = 'acct-first';
    const pictureOwners: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/agent/identity' && init?.method === 'PUT') return pendingIdentity;
      if (url === 'http://chat.test/agent/picture' && init?.method === 'PUT') pictureOwners.push(cookieAccount);
      return chatService(url, init);
    });
    await renderPage(Object.assign(auth({ accountId: 'acct-first' }), { isAccountCurrent: () => current }));
    const identity = await openIdentity();
    await editFile(identity, 'Agent Identity');
    await choosePicture(identity, 'first-account.png');
    await userEvent.click(identity.getByRole('button', { name: 'Save Agent Identity' }));
    // The switch request starts before its response installs the cookie; React has not rerendered.
    current = false;
    cookieAccount = 'acct-second';
    finishIdentity(answer(200, { status: 'saved' }));
    await settle();
    expect(pictureOwners).toEqual([]);
    expect(identity.getByRole('alert')).toHaveTextContent('Saving Agent Identity cancelled');
    expect(identity.queryByText('Saved')).toBeNull();
  });

  it.each(['save', 'event'])('refuses an old profile %s before a switching account rerenders', async (trigger) => {
    let current = true;
    await renderPage(Object.assign(auth({ accountId: 'acct-first' }), { isAccountCurrent: () => current }));
    const identity = await openIdentity();
    const subscribers = [...agent().subscribers];
    let finishSave!: (response: Response) => void;
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve; });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/agent/soul' && init?.method === 'PUT') return pendingSave;
      return chatService(url, init);
    });
    if (trigger === 'save') {
      await editFile(identity, 'Soul');
      await userEvent.click(identity.getByRole('button', { name: 'Save Soul' }));
    }
    const before = requestsTo('/agent').length;
    current = false;
    if (trigger === 'save') finishSave(answer(200, { status: 'saved' }));
    else await act(async () => {
      await Promise.all(subscribers.map((subscriber) => subscriber.onCustomEvent?.({ event: { type: 'CUSTOM', name: 'botcube:agent-document-edited', value: {} } } as never)));
    });
    await settle();
    expect(requestsTo('/agent')).toHaveLength(before);
  });

  it.each(['save', 'event'])('does not let an old account %s supersede the new profile load', async (trigger) => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    const identity = await openIdentity();
    const oldSubscribers = [...agent().subscribers];
    let finishSave!: (response: Response) => void;
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve; });
    const profiles: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/agent/soul' && init?.method === 'PUT') return pendingSave;
      if (url === 'http://chat.test/agent') return new Promise<Response>((resolve) => profiles.push(resolve));
      return chatService(url, init);
    });
    if (trigger === 'save') {
      await editFile(identity, 'Soul');
      await userEvent.click(identity.getByRole('button', { name: 'Save Soul' }));
    }
    cartridge.auth = auth({ accountId: 'acct-second' });
    view.rerender(<Page />);
    await settle();
    expect(profiles).toHaveLength(1);
    await act(async () => {
      if (trigger === 'save') finishSave(answer(200, { status: 'saved' }));
      else for (const subscriber of oldSubscribers) void subscriber.onCustomEvent?.({ event: { type: 'CUSTOM', name: 'botcube:agent-document-edited', value: {} } } as never);
    });
    await settle();
    expect(profiles).toHaveLength(1);
    await act(async () => { present(profiles[0], 'new account profile')(answer(200, { name: 'Second account agent', picture: null })); });
    await settle();
    expect(openProfile().querySelector('.agent-profile-name')).toHaveTextContent('Second account agent');
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Identity' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Open Agent Identity' })).toBeInTheDocument();
    await emit('botcube:agent-document-edited');
    expect(profiles).toHaveLength(2);
    await act(async () => { present(profiles[1], 'current account profile')(answer(200, { name: 'Updated second account agent', picture: null })); });
    await settle();
    expect(openProfile().querySelector('.agent-profile-name')).toHaveTextContent('Updated second account agent');
  });

  it.each([null, 'data:image/png;base64,c2Vjb25k'])('keeps the new account picture %s while its profile loads', async (picture) => {
    service.agentPicture = PICTURE;
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    let identity = await openIdentity();
    let finishProfile!: (response: Response) => void;
    const pendingProfile = new Promise<Response>((resolve) => { finishProfile = resolve; });
    const ordinaryFetch = fetchMock.getMockImplementation();
    if (!ordinaryFetch) throw new Error('the Chat Service fixture is missing');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/agent' && (!init?.method || init.method === 'GET')) return pendingProfile;
      return ordinaryFetch(url, init);
    });
    service.agentPicture = picture;
    cartridge.auth = auth({ accountId: 'acct-second' });
    view.rerender(<Page />);
    await settle();
    identity = await openIdentity();
    expect(identity.queryByRole('button', { name: 'Edit Agent Identity' })).toBeNull();
    expect(identity.getByRole('status')).toHaveTextContent('Loading Agent profile');
    finishProfile(answer(200, { name: 'Second account agent', picture }));
    await settle();
    await editFile(identity, 'Agent Identity');
    await userEvent.click(identity.getByRole('button', { name: 'Save Agent Identity' }));
    await settle();
    expect(requestsTo('/agent/picture')).not.toContain('PUT');
    expect(service.agentPicture).toBe(picture);
  });

  it("clears the agent's picture back to its default avatar", async () => {
    service.agentPicture = PICTURE;
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Agent Identity');

    await click(identity, 'Remove picture');

    expect(identity.queryByRole('button', { name: 'Remove picture' })).toBeNull();
    expect(pictureIn(identityArticle())).toBeUndefined();

    await click(identity, 'Save Agent Identity');

    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/picture', { method: 'DELETE', credentials: 'include' });
    expect(pictureIn(avatar())).toBeUndefined();
    expect(avatar()).toHaveTextContent(/^Ada Bot$/);
    expect(avatar().querySelector('.avatar-agent .avatar-monocle')).not.toBeNull();
  });

  it('leaves the picture alone when only the name changes', async () => {
    service.agentPicture = PICTURE;
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Agent Identity');

    await userEvent.type(identity.getByLabelText('Name'), '!');
    await click(identity, 'Save Agent Identity');

    expect(requestsTo('/agent/picture')).toEqual([]);
    expect(pictureIn(avatar())).toBe(PICTURE);
  });

  it("says why the Chat Service refused the agent's picture", async () => {
    resizing('data:image/webp;base64,UklGRg==');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/agent/picture'
        ? answer(413, { detail: "The agent's picture must be at most 256 KB" })
        : chatService(url, init),
    );
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Agent Identity');

    await choosePicture(identity, 'huge.png');
    await click(identity, 'Save Agent Identity');

    expect(identity.getByRole('alert')).toHaveTextContent(/^Saving the picture failed: The agent's picture must be at most 256 KB$/);
    expect(identity.getByLabelText('Upload picture')).toBeInTheDocument();
  });

  it('says when the chosen file is not an image', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => Promise.reject(new DOMException('undecodable', 'InvalidStateError'))),
    );
    await renderPage();
    const identity = await openIdentity();
    await editFile(identity, 'Agent Identity');

    await choosePicture(identity, 'notes.png');

    expect(identity.getByRole('alert')).toHaveTextContent(/^notes\.png is not an image$/);
    expect(requestsTo('/agent/picture')).toEqual([]);
  });

  it("shows the agent's own edit in the header, profile, and Identity tab", async () => {
    await renderPage();
    const identity = await openIdentity();
    const soul = await openFile(identity, 'Soul');

    service.agentIdentity = { ...service.agentIdentity, name: 'Quill', avatar: '🪶' };
    service.soul = 'Answer in haiku.';
    await act(async () => {
      for (const subscriber of agent().subscribers) {
        void subscriber.onCustomEvent?.({
          event: { type: 'CUSTOM', name: 'botcube:agent-document-edited', value: { document: 'soul', content: 'Answer in haiku.' } },
        } as never);
      }
    });
    await settle();

    expect(avatar()).toHaveTextContent(/^🪶Quill$/);
    expect(openProfile().querySelector('.agent-profile-name')).toHaveTextContent(/^Quill$/);
    expect(soul.getByText('Answer in haiku.')).toHaveClass('agent-file-text');
  });

  const emit = async (name: string) => {
    await act(async () => {
      for (const subscriber of agent().subscribers) {
        void subscriber.onCustomEvent?.({ event: { type: 'CUSTOM', name, value: {} } } as never);
      }
    });
    await settle();
  };
  const profileLoads = () => fetchMock.mock.calls.filter(([url]) => url === 'http://chat.test/agent').length;

  it("reloads the profile only for the agent's own edits", async () => {
    await renderPage();
    const loads = profileLoads();

    await emit('botcube:something-else');

    expect(profileLoads()).toBe(loads);
  });

  it("clears a profile failure once the agent's edit reloads it", async () => {
    service.failing.set('GET /agent', 503);
    await renderPage();
    await userEvent.click(avatar());
    service.failing.delete('GET /agent');

    await emit('botcube:agent-document-edited');

    expect(openProfile().querySelector('.agent-profile-error')).toBeNull();
    expect(openProfile().querySelector('.agent-profile-name')).toHaveTextContent(/^Ada Bot$/);
  });
});

describe('model and effort picker', () => {
  const pill = () => document.querySelector('.mep-pill') as HTMLElement;
  const dropdown = () => document.querySelector<HTMLElement>('.mep-dropdown');
  const openDropdown = () => present(dropdown(), 'the picker dropdown');
  const checked = () => [...openDropdown().querySelectorAll('.mep-check')].map((check) => check.closest('button')?.textContent);

  it('sits in the chat input beside Send', async () => {
    await renderPage();

    const cell = screen.getByTestId('send-cell');
    expect(cell.firstElementChild).toBe(picker());
    expect(picker().style.visibility).toBe('');
    expect(picker().style.position).toBe('');
    expect(document.querySelector('.copilotKitInput')).toHaveClass('picker-ready');
  });

  it('waits hidden until the chat input renders Send', async () => {
    copilot.sendCellShown = false;
    await renderPage();
    expect(picker().style.visibility).toBe('hidden');
    expect(picker().style.position).toBe('absolute');
    expect(document.querySelector('.copilotKitInput')).not.toHaveClass('picker-ready');

    await act(async () => {
      present(document.querySelector('.chat-wrapper'), 'the chat wrapper').append(document.createElement('span'));
    });
    await act(async () => {
      copilot.sendCellShown = true;
      copilot.listeners.forEach((listener) => listener());
    });

    expect(screen.getByTestId('send-cell').firstElementChild).toBe(picker());
    expect(picker().style.visibility).toBe('');
    expect(document.querySelector('.copilotKitInput')).toHaveClass('picker-ready');
  });

  it('stops waiting for Send once the chat unmounts', async () => {
    copilot.sendCellShown = false;
    const view = await renderPage();
    const wrapper = present(document.querySelector('.chat-wrapper'), 'the chat wrapper');
    const waiting = picker();

    view.unmount();
    const lateCell = document.createElement('div');
    lateCell.className = 'cpk:col-start-3';
    await act(async () => {
      wrapper.append(lateCell);
    });

    expect(lateCell.contains(waiting)).toBe(false);
  });

  it('hands the picker back to the chat when the chat unmounts after placing it', async () => {
    copilot.sendCellShown = false;
    const view = await renderPage();
    const wrapper = present(document.querySelector('.chat-wrapper'), 'the chat wrapper');
    await act(async () => {
      copilot.sendCellShown = true;
      copilot.listeners.forEach((listener) => listener());
    });
    const placed = picker();
    expect(screen.getByTestId('send-cell').firstElementChild).toBe(placed);

    view.unmount();

    expect(placed.parentElement).toBe(wrapper);
  });

  it('opens by keyboard with its full model and reasoning name', async () => {
    service.models = [{ key: 'gpt-plan', label: 'GPT Plan', provider: 'openai' }];
    await renderPage();
    const trigger = screen.getByRole('button', { name: 'Model GPT Plan, reasoning max' });
    expect(trigger).toHaveAttribute('type', 'button');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(openDropdown()).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('omits unavailable attachment and microphone controls', async () => {
    await renderPage();
    expect(screen.queryByRole('button', { name: /Microphone|Add files/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('offers the models the Chat Service lists for the account', async () => {
    service.models = [{ key: 'gpt-plan', label: 'GPT Plan', provider: 'openai' }];
    await renderPage();

    expect(pill()).toHaveTextContent(/^GPT Planmax$/);
    expect(kit().properties).toEqual({ model: 'gpt-plan', effort: 'max', sandbox: true });
    await userEvent.click(pill());
    expect([...openDropdown().querySelectorAll('.mep-option-name')].map((name) => name.textContent)).toEqual([
      'GPT Plan',
      'Effort',
    ]);
  });

  describe("once a Session has started, offers only its provider's models", () => {
    const names = () => [...openDropdown().querySelectorAll('.mep-option-name')].map((name) => name.textContent);
    beforeEach(() => {
      service.models = [
        { key: 'deep', label: 'Deep', provider: 'anthropic' },
        { key: 'fast', label: 'Fast', provider: 'anthropic' },
        { key: 'plan', label: 'Plan', provider: 'openai' },
      ];
    });

    it('offering every model before the first Turn', async () => {
      await renderPage();

      await userEvent.click(pill());
      expect(names()).toEqual(['Deep', 'Fast', 'Plan', 'Effort']);
    });

    it("never hands another provider's model to a replayed Session", async () => {
      service.sideChats = [sideChat('on-plan', 'On the plan')];
      service.replies.set('on-plan', [{ id: 'm1', role: 'user', content: 'On the plan' }]);
      service.providers.set('on-plan', 'openai');
      await renderPage();
      expect(pill()).toHaveTextContent(/^Deepmax$/);

      await userEvent.click(sidebar().getByText('On the plan'));
      await settle();

      const replays = copilot.kits.filter((entry) => entry.selfManagedAgents['research-agent']?.threadId === 'on-plan');
      expect(replays.length).toBeGreaterThan(0);
      for (const entry of replays) expect(entry.properties).toEqual({ model: 'plan', effort: 'max', sandbox: true });
    });

    it("moving a replayed Session off another provider's model", async () => {
      service.sideChats = [sideChat('on-plan', 'On the plan')];
      service.replies.set('on-plan', [{ id: 'm1', role: 'user', content: 'On the plan' }]);
      service.providers.set('on-plan', 'openai');
      await renderPage();

      await userEvent.click(sidebar().getByText('On the plan'));

      expect(pill()).toHaveTextContent(/^Planmax$/);
      expect(kit().properties).toEqual({ model: 'plan', effort: 'max', sandbox: true });
      await userEvent.click(pill());
      expect(names()).toEqual(['Plan', 'Effort']);
    });

    it('for the replayed Main Chat', async () => {
      service.mainChat = { id: 'main-1', provider: 'openai', messages: [{ id: 'm1', role: 'user', content: 'Hi' }] };
      await renderPage();

      await userEvent.click(pill());
      expect(names()).toEqual(['Plan', 'Effort']);
    });

    it("from the first Turn's model once the user sends it", async () => {
      await renderPage();
      await userEvent.click(pill());
      await userEvent.click(within(openDropdown()).getByText('Fast'));

      await sendMessage('Hello');

      expect(names()).toEqual(['Deep', 'Fast', 'Effort']);
      expect(kit().properties).toEqual({ model: 'fast', effort: 'max', sandbox: true });
    });

    it('again offering every model in a new chat', async () => {
      service.mainChat = { id: 'main-1', provider: 'openai', messages: [{ id: 'm1', role: 'user', content: 'Hi' }] };
      await renderPage();

      await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
      await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));

      await userEvent.click(pill());
      expect(names()).toEqual(['Deep', 'Fast', 'Plan', 'Effort']);
    });
  });

  it('says so when the models could not load, offering none and sending no Turn', async () => {
    service.failing.set('GET /agent/models', 503);
    await renderPage();

    expect(pill()).toHaveTextContent(/^Models could not load: Failed to load the models: 503max$/);
    await sendMessage('What is 2+2? One word.');
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      /^Models could not load: Failed to load the models: 503\. Reload the page to send a message\.$/,
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await userEvent.click(pill());
    expect([...openDropdown().querySelectorAll('.mep-option-name')].map((name) => name.textContent)).toEqual([
      'Effort',
    ]);
  });

  it('picks a model', async () => {
    await renderPage();

    await userEvent.click(pill());
    expect(checked()).toEqual(['DeepSlower, more thorough']);
    expect([...openDropdown().querySelectorAll('.mep-option-desc')].map((desc) => desc.textContent)).toEqual([
      'Slower, more thorough',
    ]);
    await userEvent.click(within(openDropdown()).getByText('Fast'));

    expect(kit().properties).toEqual({ model: 'fast', effort: 'max', sandbox: true });
    expect(pill()).toHaveTextContent(/^Fastmax$/);
    expect(checked()).toEqual(['Fast']);
  });

  it('picks an effort level', async () => {
    await renderPage();

    await userEvent.click(pill());
    await userEvent.click(within(openDropdown()).getByText('Effort'));
    expect([...openDropdown().querySelectorAll('.mep-option-name')].map((name) => name.textContent)).toEqual([
      'Effort',
      'Low',
      'High',
    ]);
    expect(checked()).toEqual([]);
    await userEvent.click(within(openDropdown()).getByText('High'));

    expect(kit().properties).toEqual({ model: 'deep', effort: 'high', sandbox: true });
    expect(pill()).toHaveTextContent(/^DeepHigh$/);
    expect(within(openDropdown()).getByText('Fast')).toBeInTheDocument();

    await userEvent.click(within(openDropdown()).getByText('Effort'));
    expect(checked()).toEqual(['High']);
    await userEvent.click(present(openDropdown().querySelector('.mep-back'), 'the back button'));
    expect(within(openDropdown()).getByText('Fast')).toBeInTheDocument();
  });

  it('closes on a click elsewhere, reopening on the main panel', async () => {
    await renderPage();

    await userEvent.click(pill());
    await userEvent.click(within(openDropdown()).getByText('Effort'));
    await userEvent.click(present(openDropdown().querySelector('.mep-separator'), 'the separator'));
    expect(dropdown()).not.toBeNull();
    await userEvent.click(present(document.querySelector('.sidebar-recents'), 'the recents'));
    expect(dropdown()).toBeNull();

    await userEvent.click(pill());
    expect(within(openDropdown()).getByText('Fast')).toBeInTheDocument();
    await userEvent.click(pill());
    expect(dropdown()).toBeNull();
  });

  it('closes on Escape from either panel, returning focus to its trigger', async () => {
    await renderPage();

    await userEvent.click(pill());
    within(openDropdown()).getByText('Fast').focus();
    await userEvent.keyboard('{Escape}');
    expect(dropdown()).toBeNull();
    expect(pill()).toHaveFocus();

    await userEvent.click(pill());
    await userEvent.click(within(openDropdown()).getByText('Effort'));
    await userEvent.keyboard('{Escape}');
    expect(dropdown()).toBeNull();
    expect(pill()).toHaveFocus();
  });

  it('reopens on the main panel after closing from the effort panel', async () => {
    await renderPage();

    await userEvent.click(pill());
    await userEvent.click(within(openDropdown()).getByText('Effort'));
    await userEvent.click(pill());
    await userEvent.click(pill());

    expect(within(openDropdown()).getByText('Fast')).toBeInTheDocument();
  });

  // An anonymous page kept its model list after a Sheet sign-in moved it to the linked account.
  describe('once a sign-in moves the page to another account', () => {
    const plan = { key: 'plan', label: 'Plan', provider: 'openai' };
    async function switchAccount(view: Awaited<ReturnType<typeof renderPage>>, accountId: string) {
      cartridge.auth = auth({ accountId });
      view.rerender(<Page />);
      await settle();
    }

    // The anonymous default stayed selected on the linked account, which defaults to its plan.
    it.each([
      ['keeping a model the user chose', 'Fast', 'fast'],
      ["starting on that account's first model over the previous default", 'Deep', 'plan'],
    ])("offers that account's models, %s", async (_, picked, expected) => {
      const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
      if (picked === 'Fast') {
        await userEvent.click(pill());
        await userEvent.click(within(openDropdown()).getByText(picked));
        await userEvent.keyboard('{Escape}');
      }
      expect(pill()).toHaveTextContent(`${picked}max`);

      service.models = [plan, ...service.models];
      await switchAccount(view, 'acct-linked');

      expect(kit().properties).toEqual({ model: expected, effort: 'max', sandbox: true });
      await userEvent.click(pill());
      expect([...openDropdown().querySelectorAll('.mep-option-name')].map((name) => name.textContent)).toEqual([
        'Plan',
        'Deep',
        'Fast',
        'Effort',
      ]);
    });

    it("starts from that account's first model when it does not offer the chosen one", async () => {
      const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
      await userEvent.click(pill());
      await userEvent.click(within(openDropdown()).getByText('Fast'));

      service.models = [plan, { key: 'deep', label: 'Deep', provider: 'anthropic' }];
      await switchAccount(view, 'acct-linked');

      expect(kit().properties).toEqual({ model: 'plan', effort: 'max', sandbox: true });
      expect(pill()).toHaveTextContent(/^Planmax$/);
    });

    it('uses a later account default after the chosen model was replaced by an implicit fallback', async () => {
      const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
      await userEvent.click(pill());
      await userEvent.click(within(openDropdown()).getByText('Fast'));
      await userEvent.keyboard('{Escape}');
      service.models = [plan];
      await switchAccount(view, 'acct-linked');
      expect(kit().properties).toEqual({ model: 'plan', effort: 'max', sandbox: true });
      service.models = [{ key: 'astra', label: 'Astra', provider: 'openai' }, plan];
      await switchAccount(view, 'acct-another');
      expect(kit().properties).toEqual({ model: 'astra', effort: 'max', sandbox: true });
    });

    // The previous account's Main Chat stayed open, marked Main chat, and its first message became a Side Chat.
    it("opens that account's Main Chat with its messages so far", async () => {
      const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
      expect(copilot.chat?.threadId).toBe('main-1');

      const messages: Message[] = [{ id: 'm1', role: 'user', content: 'Earlier question' }];
      service.mainChat = { id: 'main-linked', messages };
      await switchAccount(view, 'acct-linked');

      expect(copilot.chat?.threadId).toBe('main-linked');
      for (const threadAgent of Object.values(kit().selfManagedAgents)) expect(threadAgent.messages).toEqual(messages);
      expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveClass('sidebar-nav-item-active');
    });

    it('keeps the open chat as a Side Chat while a Turn runs in it, such as the request the sign-in resumes', async () => {
      const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
      agent().isRunning = true;

      service.mainChat = { id: 'main-linked', messages: [{ id: 'm1', role: 'user', content: 'Earlier question' }] };
      await switchAccount(view, 'acct-linked');

      expect(copilot.chat?.threadId).toBe('main-1');
      expect(agent().messages).toEqual([]);
      expect(sidebar().getByRole('button', { name: 'Main Chat' })).not.toHaveClass('sidebar-nav-item-active');
    });

    it.each(['already running', 'completed reply', 'failed before streaming'])(
      'keeps the resumed Turn that is %s before the account Main Chat arrives',
      async (state) => {
        const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
        const originalAgent = agent();
        const question: Message = { id: 'resumed-question', role: 'user', content: 'Keep my resumed question.' };
        const reply: Message = { id: 'resumed-reply', role: 'assistant', content: 'The resumed answer.' };
        const held: ((response: Response) => void)[] = [];
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
          url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
        );
        if (state === 'already running') {
          originalAgent.addMessage(question);
          originalAgent.isRunning = true;
        }
        await switchAccount(view, 'acct-linked');
        await act(async () => {
          originalAgent.isRunning = true;
          if (state === 'completed reply') originalAgent.setMessages([question, reply]);
          else if (state === 'failed before streaming') originalAgent.addMessage(question);
          originalAgent.isRunning = false;
          present(held[0], 'the held account Main Chat')(answer(200, { id: 'main-linked', messages: [] }));
        });
        await settle();

        expect(copilot.chat?.threadId).toBe('main-1');
        expect(agent()).toBe(originalAgent);
        expect(agent().messages).toEqual(state === 'completed reply' ? [question, reply] : [question]);
        expect(sidebar().getByRole('button', { name: 'Main Chat' })).not.toHaveClass('sidebar-nav-item-active');
        expect(new URLSearchParams(window.location.search).get('chat')).toBe('main-1');
      },
    );

    it("no longer marks the previous account's chat as the Main Chat when that account's cannot open", async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const view = await renderPage(auth({ accountId: 'acct-anonymous' }));

      service.failing.set('GET /main-chat', 503);
      await switchAccount(view, 'acct-linked');

      expect(screen.getByRole('alert')).toHaveTextContent(/^Your Main Chat could not be opened\.$/);
      expect(error).toHaveBeenCalledWith(new ChatServiceError('open the Main Chat', 503));
      expect(sidebar().getByRole('button', { name: 'Main Chat' })).not.toHaveClass('sidebar-nav-item-active');
    });

    it('loads the models once per account', async () => {
      const view = await renderPage(auth({ accountId: 'acct-anonymous' }));

      await switchAccount(view, 'acct-anonymous');
      expect(requestsTo('/agent/models')).toEqual(['GET']);

      await switchAccount(view, 'acct-linked');
      expect(requestsTo('/agent/models')).toEqual(['GET', 'GET']);
    });

    it('sends no Turn on the new account render before its models effect runs', async () => {
      let currentAccount = 'acct-anonymous';
      const isAccountCurrent = (accountId: string | undefined) => accountId === currentAccount;
      function SendBeforeModelsEffect({ accountId }: { accountId: string }) {
        useLayoutEffect(() => {
          if (accountId !== 'acct-linked') return;
          const textarea = screen.getByLabelText<HTMLTextAreaElement>('Message');
          textarea.value = 'What is 2+2? One word.';
          fireEvent.keyDown(textarea, { key: 'Enter' });
        }, [accountId]);
        return null;
      }
      const state = (accountId: string) => auth({
        accountId,
        isAccountCurrent,
        composerAccessory: <SendBeforeModelsEffect accountId={accountId} />,
      });
      const view = await renderPage(state(currentAccount));
      currentAccount = 'acct-linked';
      service.models = [plan];
      cartridge.auth = state(currentAccount);

      view.rerender(<Page />);
      await settle();

      expect(copilot.runAgent).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(/^Your models are still loading\. Send it again once they have\.$/);
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(kit().properties).toEqual({ model: 'plan', effort: 'max', sandbox: true });
      expect(copilot.runAgent).toHaveBeenCalledExactlyOnceWith({ agent: agent() });
    });

    it('sends no Turn while a sign-in switches the account before the page rerenders', async () => {
      let current = true;
      await renderPage(Object.assign(auth({ accountId: 'acct-anonymous' }), { isAccountCurrent: () => current }));
      // The sign-in installed the new account's cookie; React has not rerendered.
      current = false;
      const sideChatsBefore = sideChatLoads();
      await sendMessage('What is 2+2? One word.');

      expect(copilot.runAgent).not.toHaveBeenCalled();
      expect(sideChatLoads()).toBe(sideChatsBefore);
      expect(screen.getByRole('alert')).toHaveTextContent(/^Your models are still loading\. Send it again once they have\.$/);
    });

    // Live on dev: right after a sign-in the picker showed the anonymous account's model until the linked
    // account's models loaded, and a message sent meanwhile ran on it.
    it("sends no Turn until that account's models load, then sends on its model", async () => {
      const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
      let releaseModels = () => {};
      const models = new Promise<void>((resolve) => (releaseModels = resolve));
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === 'http://chat.test/agent/models') await models;
        return chatService(url, init);
      });
      service.models = [plan];
      await switchAccount(view, 'acct-linked');

      expect(pill()).toHaveTextContent(/^Loading models…max$/);
      const sideChatsBefore = sideChatLoads();
      await sendMessage('What is 2+2? One word.');
      expect(copilot.runAgent).not.toHaveBeenCalled();
      expect(sideChatLoads()).toBe(sideChatsBefore);
      expect(screen.getByRole('alert')).toHaveTextContent(/^Your models are still loading\. Send it again once they have\.$/);

      releaseModels();
      await settle();
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(kit().properties).toEqual({ model: 'plan', effort: 'max', sandbox: true });
      expect(copilot.runAgent).toHaveBeenCalledExactlyOnceWith({ agent: agent() });
    });
  });
});

// A reload put the picker back on the default model and effort.
describe('the model and effort the user last picked', () => {
  const pill = () => document.querySelector('.mep-pill') as HTMLElement;
  const dropdown = () => present(document.querySelector<HTMLElement>('.mep-dropdown'), 'the picker dropdown');
  async function pick(model: string, effort: string) {
    await userEvent.click(pill());
    await userEvent.click(within(dropdown()).getByText(model));
    await userEvent.click(within(dropdown()).getByText('Effort'));
    await userEvent.click(within(dropdown()).getByText(effort));
  }

  it('are still picked after a reload', async () => {
    const view = await renderPage();
    await pick('Fast', 'High');
    view.unmount();

    await renderPage();

    expect(pill()).toHaveTextContent(/^FastHigh$/);
    expect(kit().properties).toEqual({ model: 'fast', effort: 'high', sandbox: true });
  });

  it("start the account's first model after a reload when it no longer offers the picked one", async () => {
    const view = await renderPage();
    await pick('Fast', 'High');
    view.unmount();
    service.models = [{ key: 'deep', label: 'Deep', provider: 'anthropic' }];

    await renderPage();

    expect(kit().properties).toEqual({ model: 'deep', effort: 'high', sandbox: true });
  });

  it("give way to that account's first model when a sign-in moves the page to another account", async () => {
    const before = await renderPage(auth({ accountId: 'acct-anonymous' }));
    await pick('Fast', 'High');
    before.unmount();
    const view = await renderPage(auth({ accountId: 'acct-anonymous' }));

    service.models = [{ key: 'plan', label: 'Plan', provider: 'openai' }, ...service.models];
    cartridge.auth = auth({ accountId: 'acct-linked' });
    view.rerender(<Page />);
    await settle();

    expect(kit().properties).toEqual({ model: 'plan', effort: 'high', sandbox: true });
  });

  // An in-page sign-in preserves the selected model. A reload keeps that choice too.
  it.each([
    ['an anonymous pick, then a link', 'acct-anonymous', 'acct-linked', true, { model: 'fast', effort: 'high' }],
    ['no pick, then a link', 'acct-anonymous', 'acct-linked', false, { model: 'plan', effort: 'max' }],
    ['a pick on one linked account, then another', 'acct-linked', 'acct-other', true, { model: 'fast', effort: 'high' }],
  ])('after %s in the page, and after a reload there', async (_, from, to, picks, expected) => {
    const view = await renderPage(auth({ accountId: from }));
    if (picks) await pick('Fast', 'High');
    service.models = [{ key: 'plan', label: 'Plan', provider: 'openai' }, ...service.models];
    cartridge.auth = auth({ accountId: to });
    view.rerender(<Page />);
    await settle();
    expect(kit().properties).toEqual({ ...expected, sandbox: true });
    view.unmount();

    await renderPage(auth({ accountId: to }));

    expect(kit().properties).toEqual({ ...expected, sandbox: true });
  });

  // Confirming an account switch reloads the page on the other account.
  it("give way to the account's first model when the page reloads on another account", async () => {
    const before = await renderPage(auth({ accountId: 'acct-anonymous' }));
    await pick('Fast', 'High');
    before.unmount();
    service.models = [{ key: 'plan', label: 'Plan', provider: 'openai' }, ...service.models];

    await renderPage(auth({ accountId: 'acct-linked' }));

    expect(kit().properties).toEqual({ model: 'plan', effort: 'high', sandbox: true });
  });

  it('start the default effort when the picked one is no longer offered', async () => {
    localStorage.setItem('botcube.picker-choice', JSON.stringify({ effort: 'retired' }));

    await renderPage();

    expect(kit().properties).toEqual({ model: 'deep', effort: 'max', sandbox: true });
  });

  it('leave the picker working where the browser blocks storage, and say the choice is not kept', async () => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('This browser could not keep your model choice: blocked');

    await pick('Fast', 'High');

    expect(kit().properties).toEqual({ model: 'fast', effort: 'high', sandbox: true });
    expect(screen.getByRole('alert')).toHaveTextContent('This browser could not keep your model choice: blocked');
  });
});

describe('a sign-in that moves the page to another account', () => {
  it("lists that account's Side Chats and shows its agent, keeping the open chat", async () => {
    const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
    expect(recents()).toEqual([]);

    service.sideChats = [sideChat('linked-chat', 'Copper outlook')];
    service.agentIdentity = { ...service.agentIdentity, name: 'Hao Bot' };
    cartridge.auth = auth({ accountId: 'acct-linked' });
    view.rerender(<Page />);
    await settle();

    expect(recents()).toEqual(['Copper outlook']);
    expect(document.querySelector('.chat-header-name')).toHaveTextContent('Hao Bot');
    expect(copilot.chat?.threadId).toBe('main-1');
  });
});

describe('account reload responses', () => {
  it.each(['/agent/models', '/threads', '/agent'])('logs a late %s failure without replacing the linked account', async (path) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cause = new Error('Previous account request failed');
    let reject!: (cause: Error) => void;
    let held = false;
    fetchMock.mockImplementation((url, init) => {
      if (url === `http://chat.test${path}` && !held) {
        held = true;
        return new Promise<Response>((_resolve, fail) => { reject = fail; });
      }
      return chatService(url, init);
    });
    const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
    service.models = [{ key: 'plan', label: 'Plan', provider: 'openai' }];
    service.sideChats = [sideChat('linked-chat', 'Copper outlook')];
    service.agentIdentity = { ...service.agentIdentity, name: 'Hao Bot' };
    cartridge.auth = auth({ accountId: 'acct-linked' });
    view.rerender(<Page />);
    await settle();
    reject(cause);
    await settle();
    expect(logged).toHaveBeenCalledWith(cause);
    expect(recents()).toEqual(['Copper outlook']);
    expect(document.querySelector('.chat-header-name')).toHaveTextContent('Hao Bot');
    await userEvent.click(present(document.querySelector<HTMLElement>('.mep-pill'), 'the model pill'));
    expect(document.querySelector('.mep-dropdown')).toHaveTextContent('Plan');
    await userEvent.click(screen.getByLabelText('Agent profile', { selector: 'button' }));
    expect(document.querySelector('.agent-profile-error')).toBeNull();
    expect(screen.queryByText(/Previous account request failed/)).toBeNull();
  });

  it.each(['/agent/models', '/threads', '/agent'])('keeps the linked account after a late %s response', async (path) => {
    let release!: (response: Response) => void;
    let held = false;
    fetchMock.mockImplementation((url, init) => {
      if (url === `http://chat.test${path}` && !held) {
        held = true;
        return new Promise<Response>((resolve) => { release = resolve; });
      }
      return chatService(url, init);
    });
    const oldModels = [...service.models];
    const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
    service.models = [{ key: 'plan', label: 'Plan', provider: 'openai' }, ...oldModels];
    service.sideChats = [sideChat('linked-chat', 'Copper outlook')];
    service.agentIdentity = { ...service.agentIdentity, name: 'Hao Bot' };
    cartridge.auth = auth({ accountId: 'acct-linked' });
    view.rerender(<Page />);
    await settle();
    expect(recents()).toEqual(['Copper outlook']);
    expect(document.querySelector('.chat-header-name')).toHaveTextContent('Hao Bot');
    release(Response.json(path === '/agent/models' ? { models: oldModels } : path === '/threads' ? { threads: [] } : {
      name: 'Ada Bot', avatar: '', picture: null, status: 'online',
    }));
    await settle();
    expect(recents()).toEqual(['Copper outlook']);
    expect(document.querySelector('.chat-header-name')).toHaveTextContent('Hao Bot');
    expect(copilot.chat?.threadId).toBe('main-1');
    await userEvent.click(present(document.querySelector<HTMLElement>('.mep-pill'), 'the model pill'));
    expect(document.querySelector('.mep-dropdown')).toHaveTextContent('Plan');
  });
});

describe('a proposed scheduled task', () => {
  const proposal = { title: 'Morning brief', prompt: 'Brief me on rates', schedule: 'cron(0 8 ? * MON-FRI *)' };
  const renderProposal = () =>
    render(
      present(copilot.renderTool, 'the tool renderer')({
        name: 'propose_scheduled_task',
        toolCallId: 'call-1',
        status: 'complete',
        parameters: proposal,
        result: 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
      })
    );
  /** The Confirm button, once the card has checked the account's tasks for its proposal. */
  const confirmButton = async (container: HTMLElement) => {
    const button = within(container).getByRole('button', { name: 'Confirm' });
    await waitFor(() => expect(button).toBeEnabled());
    return button;
  };

  it('stays scheduled after a reload once the account holds the task its proposal made', async () => {
    service.scheduled = [{ id: 'task-1', ...proposal, timezone: 'America/New_York', paused: false, proposalId: 'call-1' }];
    await renderPage();
    const { container } = renderProposal();

    expect(await within(container).findByText('Scheduled. Manage it in the Scheduled tab.')).toBeInTheDocument();
    expect(within(container).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/scheduled-tasks', { credentials: 'include', cache: 'no-store' });
  });

  it("offers Confirm when the account's tasks came from other proposals", async () => {
    service.scheduled = [{ id: 'task-1', ...proposal, timezone: 'America/New_York', paused: false, proposalId: 'call-0' }];
    await renderPage();
    const { container } = renderProposal();

    await confirmButton(container);

    expect(container).not.toHaveTextContent('Scheduled. Manage it in the Scheduled tab.');
  });

  it("says why it could not check the account's tasks, and still offers Confirm", async () => {
    service.failing.set('GET /scheduled-tasks', 503);
    await renderPage();
    const { container } = renderProposal();

    await confirmButton(container);

    expect(container).toHaveTextContent(/Scheduled tasks failed: 503$/);
  });

  it('schedules the task in the browser timezone once the user confirms it', async () => {
    await renderPage();
    const { container } = renderProposal();
    expect(container).toHaveTextContent('Morning brief');
    expect(container).toHaveTextContent('Brief me on rates');
    expect(container.querySelector('.scheduled-task-schedule')).toHaveTextContent(/^At 8:00 AM, Monday through Friday$/);

    await userEvent.click(await confirmButton(container));

    const [url, init] = present(
      fetchMock.mock.calls.find(
        ([called, sent]) => called === 'http://chat.test/scheduled-tasks' && sent?.method === 'POST'
      ),
      'the confirmation'
    );
    expect(url).toBe('http://chat.test/scheduled-tasks');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      ...proposal,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      proposalId: 'call-1',
    });
    expect(container).toHaveTextContent('Scheduled. Manage it in the Scheduled tab.');
    expect(within(container).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(container.querySelector('.agent-profile-error')).toBeNull();
  });

  it('cannot be confirmed twice while scheduling', async () => {
    let finish: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/scheduled-tasks' && init?.method === 'POST'
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : chatService(url, init)
    );
    await renderPage();
    const { container } = renderProposal();

    await userEvent.click(await confirmButton(container));

    expect(within(container).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await act(async () => finish(answer(201, { id: 'task-new' })));
    expect(container).toHaveTextContent('Scheduled. Manage it in the Scheduled tab.');
  });

  it('can be confirmed again after a failure, which clears it', async () => {
    service.failing.set('POST /scheduled-tasks', 502);
    await renderPage();
    const { container } = renderProposal();
    await userEvent.click(await confirmButton(container));
    expect(within(container).getByRole('button', { name: 'Confirm' })).toBeEnabled();

    service.failing.delete('POST /scheduled-tasks');
    await userEvent.click(within(container).getByRole('button', { name: 'Confirm' }));

    expect(container).not.toHaveTextContent('Scheduling failed');
    expect(container).toHaveTextContent('Scheduled. Manage it in the Scheduled tab.');
  });

  it('is not offered until the proposal is complete', async () => {
    await renderPage();
    const { container } = render(
      present(copilot.renderTool, 'the tool renderer')({
        name: 'propose_scheduled_task',
        toolCallId: 'call-1',
        status: 'executing',
        parameters: proposal,
        result: undefined,
      })
    );

    expect(within(container).queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('says why the Chat Service refused the task', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/scheduled-tasks' && init?.method === 'POST'
        ? answer(409, { detail: 'An account can schedule at most 10 tasks' })
        : chatService(url, init)
    );
    await renderPage();
    const { container } = renderProposal();

    await userEvent.click(await confirmButton(container));

    expect(container).toHaveTextContent(/Scheduling failed: An account can schedule at most 10 tasks$/);
    expect(within(container).getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('says what failed when the refusal has no detail', async () => {
    service.failing.set('POST /scheduled-tasks', 502);
    await renderPage();
    const { container } = renderProposal();

    await userEvent.click(await confirmButton(container));

    expect(container).toHaveTextContent(/Scheduling failed: 502$/);
  });
});

describe('tool calls', () => {
  function renderToolCall(props: Record<string, unknown>) {
    return render(present(copilot.renderTool, 'the tool renderer')({ name: 'execute', toolCallId: 'call-1', parameters: {}, result: undefined, ...props }));
  }

  it('shows unfinished subagent rows as Stopped after accepted Stop and a follow-up', async () => {
    await renderPage();
    const current = agent();
    let runs = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method !== 'POST' || url.endsWith('/stop')) return chatService(url, init);
      const { runId } = JSON.parse(init.body as string) as { runId: string };
      runs += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const events = [
            { type: 'RUN_STARTED', threadId: current.threadId, runId },
            ...(runs === 1 ? [
              { type: 'TOOL_CALL_START', toolCallId: 'completed', toolCallName: 'execute', parentMessageId: 'completed-message' },
              { type: 'TOOL_CALL_END', toolCallId: 'completed' },
              { type: 'TOOL_CALL_RESULT', messageId: 'completed-result', toolCallId: 'completed', role: 'tool', content: 'Logged in.' },
              { type: 'TOOL_CALL_START', toolCallId: 'task-parent', toolCallName: 'task', parentMessageId: 'task-message' },
              { type: 'TOOL_CALL_ARGS', toolCallId: 'task-parent', delta: '{"description":"Compare research"}' },
              { type: 'TOOL_CALL_END', toolCallId: 'task-parent' },
              { type: 'TOOL_CALL_START', toolCallId: 'inner-execute', toolCallName: 'execute', parentMessageId: 'inner-message' },
              { type: 'TOOL_CALL_ARGS', toolCallId: 'inner-execute', delta: '{"command":"research search' },
            ] : [
              { type: 'TEXT_MESSAGE_START', messageId: 'followup', role: 'assistant' },
              { type: 'TEXT_MESSAGE_CONTENT', messageId: 'followup', delta: 'OK' },
              { type: 'TEXT_MESSAGE_END', messageId: 'followup' },
              { type: 'RUN_FINISHED', threadId: current.threadId, runId },
            ]),
          ];
          controller.enqueue(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
          if (runs === 1) init.signal?.addEventListener('abort', () => controller.error(new DOMException('The user aborted a request.', 'AbortError')));
          else controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const turn = current.runAgent({ runId: 'stopped-run' });
    await waitFor(() => expect(current.messages).toContainEqual(expect.objectContaining({ id: 'inner-message' })));
    const row = renderToolCall({ toolCallId: 'inner-execute', status: 'inProgress' });
    expect(row.container).toHaveTextContent(/^executePending$/);

    await act(async () => {
      current.abortRun();
      await turn;
    });
    expect(fetchMock).toHaveBeenCalledWith(`http://chat.test/threads/${current.threadId}/stop`, expect.objectContaining({ method: 'POST' }));
    expect(current.isRunning).toBe(false);
    row.rerender(present(copilot.renderTool, 'the tool renderer')({ name: 'execute', toolCallId: 'inner-execute', status: 'inProgress', parameters: {} }));
    expect(row.container).toHaveTextContent(/^executeStopped$/);
    expect(current.messages).toContainEqual({ id: 'completed-result', role: 'tool', toolCallId: 'completed', content: 'Logged in.' });

    await act(async () => {
      current.addMessage({ id: 'followup-question', role: 'user', content: 'Reply with just OK.' });
      await current.runAgent({ runId: 'followup-run' });
    });
    row.rerender(present(copilot.renderTool, 'the tool renderer')({ name: 'execute', toolCallId: 'inner-execute', status: 'inProgress', parameters: {} }));
    expect(row.container).toHaveTextContent(/^executeStopped$/);
    row.rerender(present(copilot.renderTool, 'the tool renderer')({ name: 'execute', toolCallId: 'inner-execute', status: 'complete', parameters: {}, result: 'Late actual output.' }));
    expect(row.container).not.toHaveTextContent('Stopped');
    expect(row.getByRole('button', { name: 'execute' })).toBeInTheDocument();
    expect(current.messages.at(-1)).toMatchObject({ id: 'followup', role: 'assistant', content: 'OK' });
  });

  it.each([
    ['inProgress', 'Pending'],
    ['executing', 'Running'],
  ])('shows a %s tool call as %s', async (status, label) => {
    await renderPage();

    const { container } = renderToolCall({ status });

    expect(container).toHaveTextContent(new RegExp(`^execute${label}$`));
  });

  it('summarizes a tool call by its first text argument', async () => {
    await renderPage();

    const { container } = renderToolCall({ status: 'executing', parameters: { limit: 5, command: 'ls -la', cwd: '/tmp' } });

    expect(container).toHaveTextContent(/^executels -laRunning$/);
  });

  it.each([
    ['no parameters', undefined],
    ['empty parameters', {}],
    ['no text argument', { limit: 5 }],
  ])('shows no summary for %s', async (_case, parameters) => {
    await renderPage();

    const { container } = renderToolCall({ status: 'executing', parameters });

    expect(container).toHaveTextContent(/^executeRunning$/);
  });

  it('shows a finished tool call result when expanded', async () => {
    await renderPage();

    const { container } = renderToolCall({ status: 'complete', result: '{"ok": true}' });
    expect(container).toHaveTextContent(/^execute$/);
    await userEvent.click(within(container).getByRole('button'));

    expect(container.querySelector('pre')).toHaveTextContent('{"ok": true}');
  });

  it.each([
    ['failed', 'Command failed: open. Exit code: 1\n[Command failed with exit code 1]', 'lucide-circle-x', 'lucide-circle-check-big'],
    ['failed and was truncated', 'partial\n[Command failed with exit code 126]\n[Output was truncated due to size limits]', 'lucide-circle-x', 'lucide-circle-check-big'],
    ['succeeded', 'ok\n[Command succeeded with exit code 0]', 'lucide-circle-check-big', 'lucide-circle-x'],
    ['succeeded after quoting a failure', 'log\n[Command failed with exit code 1]\n[Command succeeded with exit code 0]', 'lucide-circle-check-big', 'lucide-circle-x'],
  ])('marks a command that %s by its exit code trailer', async (_case, result, shown, hidden) => {
    await renderPage();

    const { container } = renderToolCall({ status: 'complete', result });

    expect(container.querySelector(`.${shown}`)).not.toBeNull();
    expect(container.querySelector(`.${hidden}`)).toBeNull();
    expect(container).toHaveTextContent(/^execute$/);
  });

  it.each([
    ['a running tool call', 'executing', '{"ok": true}'],
    ['a finished tool call without a result', 'complete', undefined],
  ])('shows no result for %s', async (_case, status, result) => {
    await renderPage();

    const { container } = renderToolCall({ status, result });
    await userEvent.click(within(container).getByRole('button'));

    expect(container.querySelector('[data-slot="collapsible-content"]')).toBeNull();
  });
});

describe('a pending Side Chat deletion', () => {
  it('keeps a newer Side Chat after deletion of the old selected chat completes', async () => {
    service.sideChats = [sideChat('old', 'Old chat'), sideChat('next', 'Next chat')];
    await renderPage();
    await userEvent.click(sidebar().getByText('Old chat'));
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/threads/old' && init?.method === 'DELETE' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userEvent.click(within(present(sidebar().getByText('Old chat').parentElement, 'old item')).getByLabelText('Delete conversation'));
    await userEvent.click(sidebar().getByText('Next chat'));
    expect(copilot.chat?.threadId).toBe('next');
    await act(async () => { present(held[0], 'delete response')(answer(204)); });
    await settle();
    expect(copilot.chat?.threadId).toBe('next');
  });

  it('keeps a newer draft when the previous selected chat deletion finishes', async () => {
    service.sideChats = [sideChat('old', 'Old chat')];
    await renderPage();
    await userEvent.click(sidebar().getByText('Old chat'));
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/threads/old' && init?.method === 'DELETE' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userEvent.click(sidebar().getByLabelText('Delete conversation'));
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    await userEvent.type(screen.getByLabelText('Message'), 'Keep this draft');
    await act(async () => { present(held[0], 'delete response')(answer(204)); });
    await settle();
    expect(copilot.chat?.threadId).toBe('new-1');
    expect(screen.getByLabelText('Message')).toHaveValue('Keep this draft');
  });

  it('starts a new chat if the user returns to the chat being deleted', async () => {
    service.sideChats = [sideChat('old', 'Old chat'), sideChat('next', 'Next chat')];
    await renderPage();
    await userEvent.click(sidebar().getByText('Old chat'));
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/threads/old' && init?.method === 'DELETE' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init),
    );
    await userEvent.click(within(present(sidebar().getByText('Old chat').parentElement, 'old item')).getByLabelText('Delete conversation'));
    await userEvent.click(sidebar().getByText('Next chat'));
    await userEvent.click(sidebar().getByText('Old chat'));
    await act(async () => { present(held[0], 'delete response')(answer(204)); });
    await settle();
    expect(copilot.chat?.threadId).toBe('new-1');
  });

  it.each([200, 503])('keeps a pending newer replay after deletion, with HTTP %i', async (status) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service.sideChats = [sideChat('old', 'Old chat'), sideChat('next', 'Next chat')];
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(sidebar().getByText('Old chat'));
    const deletes: ((response: Response) => void)[] = [];
    const replays: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/threads/old' && init?.method === 'DELETE') return new Promise<Response>((resolve) => deletes.push(resolve));
      if (url === 'http://chat.test/threads/next') return new Promise<Response>((resolve) => replays.push(resolve));
      return chatService(url, init);
    });
    await userEvent.click(within(present(sidebar().getByText('Old chat').parentElement, 'old item')).getByLabelText('Delete conversation'));
    await userEvent.click(sidebar().getByText('Next chat'));
    await act(async () => { present(deletes[0], 'delete response')(answer(204)); });
    await act(async () => { present(replays[0], 'replay response')(answer(status, { messages: [] })); });
    await settle();
    expect(copilot.chat?.threadId).toBe(status === 200 ? 'next' : 'new-1');
    if (status === 503) expect(sidebar().getByRole('alert')).toHaveTextContent('Next chat could not be opened');
    else expect(sidebar().queryByRole('alert')).toBeNull();
  });
});

describe('an Agent Profile draft across account changes', () => {
  async function editSoul() {
    await userEvent.click(screen.getByRole('button', { name: 'Agent profile' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Identity' }));
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Open Soul' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit Soul' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Soul' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Soul' }), 'Private instructions from the first account');
  }

  it('discards the previous account draft before it can overwrite the linked account', async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await editSoul();
    service.soul = 'Second account instructions';
    cartridge.auth = auth({ accountId: 'acct-second' });
    view.rerender(<Page />);
    await settle();
    const oldSave = screen.queryByRole('button', { name: 'Save Soul' });
    if (oldSave) await userEvent.click(oldSave);
    expect(service.soul).toBe('Second account instructions');
    expect(screen.queryByRole('textbox', { name: 'Soul' })).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Identity' }));
    await settle();
    await userEvent.click(screen.getByRole('button', { name: 'Open Soul' }));
    expect(screen.getByRole('article', { name: 'Soul' })).toHaveTextContent('Second account instructions');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Soul' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Soul' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Soul' }), 'Updated second account instructions');
    await userEvent.click(screen.getByRole('button', { name: 'Save Soul' }));
    expect(service.soul).toBe('Updated second account instructions');
  });

  it('keeps a draft when auth refreshes within the same account', async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await editSoul();
    cartridge.auth = auth({ accountId: 'acct-first', user: { name: 'Renamed user' } });
    view.rerender(<Page />);
    await settle();
    expect(screen.getByRole('textbox', { name: 'Soul' })).toHaveValue('Private instructions from the first account');
    await userEvent.click(screen.getByRole('button', { name: 'Save Soul' }));
    expect(service.soul).toBe('Private instructions from the first account');
  });
});

describe('an offline first Turn refused before dispatch', () => {
  const modelNames = () => [...document.querySelectorAll('.mep-dropdown .mep-option-name')].map((entry) => entry.textContent);
  const openModels = () => userEvent.click(present(document.querySelector<HTMLElement>('.mep-pill'), 'model pill'));

  beforeEach(() => {
    service.models = [
      { key: 'deep', label: 'Deep', provider: 'anthropic' },
      { key: 'astra', label: 'Astra', provider: 'openai' },
    ];
  });

  it('keeps every available provider selectable until a Turn is submitted', async () => {
    await renderPage();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await sendMessage('Create one reminder');
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(agent().messages).toEqual([]);
    await openModels();
    expect(modelNames()).toEqual(['Deep', 'Astra', 'Effort']);
    expect(welcome()).not.toBeNull();
  });

  it('locks the provider after an online first Turn', async () => {
    await renderPage();
    await sendMessage('Create one reminder');
    expect(copilot.runAgent).toHaveBeenCalledOnce();
    await openModels();
    expect(modelNames()).toEqual(['Deep', 'Effort']);
    expect(welcome()).toBeNull();
  });

  it('keeps provider choices after a blank Enter', async () => {
    await renderPage();
    fireEvent.keyDown(present(document.querySelector('.chat-wrapper'), 'chat wrapper'), { key: 'Enter' });
    expect(copilot.runAgent).not.toHaveBeenCalled();
    await openModels();
    expect(modelNames()).toEqual(['Deep', 'Astra', 'Effort']);
    expect(welcome()).not.toBeNull();
  });

  it('submits Retry with the newly selected Astra provider', async () => {
    await renderPage();
    const submittedProperties: Record<string, unknown>[] = [];
    copilot.runAgent.mockImplementation(() => submittedProperties.push({ ...kit().properties }));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await sendMessage('Create one reminder');
    await openModels();
    await userEvent.click(screen.getByText('Astra'));
    expect(kit().properties).toEqual({ model: 'astra', effort: 'max', sandbox: true });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(submittedProperties).toEqual([{ model: 'astra', effort: 'max', sandbox: true }]);
    expect(copilot.runAgent).toHaveBeenCalledExactlyOnceWith({ agent: agent() });
    await openModels();
    expect(modelNames()).toEqual(['Astra', 'Effort']);
  });

  it('locks the provider only after the refused Turn succeeds on Retry', async () => {
    await renderPage();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await sendMessage('Create one reminder');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(copilot.runAgent).not.toHaveBeenCalled();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(copilot.runAgent).toHaveBeenCalledOnce();
    expect(agent().messages).toEqual([expect.objectContaining({ role: 'user', content: 'Create one reminder' })]);
    await openModels();
    expect(modelNames()).toEqual(['Deep', 'Effort']);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(welcome()).toBeNull();
  });
});

// Main Chat failures disappeared whenever a Side Chat remained active.
describe('Main Chat navigation failure visibility', () => {
  it('shows a Main Chat navigation failure from a selected Side Chat, preserving its draft until Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service.sideChats = [sideChat('saved', 'Saved chat')];
    service.replies.set('saved', [{ id: 'saved-message', role: 'user', content: 'Saved history' }]);
    await renderPage();
    await userEvent.click(sidebar().getByText('Saved chat'));
    await userEvent.click(present(document.querySelector<HTMLElement>('.mep-pill'), 'model pill'));
    await userEvent.click(screen.getByText('Fast'));
    await userEvent.type(screen.getByLabelText('Message'), 'Draft remains');
    const current = agent();
    service.failing.set('GET /main-chat', 503);
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await settle();
    expect(agent()).toBe(current);
    expect(screen.getByLabelText('Message')).toHaveValue('Draft remains');
    expect(kit().properties).toEqual({ model: 'fast', effort: 'max', sandbox: true });
    expect(screen.getByRole('alert')).toHaveTextContent('Your Main Chat could not be opened.');
    service.failing.delete('GET /main-chat');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(agent().threadId).toBe('main-1');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

it.each(['another Side Chat', 'a new Side Chat'])('clears a failed Main Chat navigation when opening %s', async (destination) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  service.sideChats = [sideChat('old', 'Old chat'), sideChat('next', 'Next chat')];
  await renderPage();
  await userEvent.click(sidebar().getByText('Old chat'));
  service.failing.set('GET /main-chat', 503);
  await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
  await settle();
  expect(screen.getByRole('alert')).toHaveTextContent('Your Main Chat could not be opened.');
  await userEvent.click(destination === 'another Side Chat' ? sidebar().getByText('Next chat') : screen.getByRole('button', { name: 'New side chat' }));
  await settle();
  expect(agent().threadId).toBe(destination === 'another Side Chat' ? 'next' : 'new-1');
  expect(screen.queryByRole('alert')).toBeNull();
});

describe('Main Chat navigation after a Side Chat deletion', () => {
  it.each([200, 503])('settles held Main Chat HTTP %i after deleting its previous Side Chat', async (status) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service.sideChats = [sideChat('old', 'Old chat')];
    await renderPage();
    await userEvent.click(sidebar().getByText('Old chat'));
    const held: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url === 'http://chat.test/main-chat' ? new Promise<Response>((resolve) => held.push(resolve)) : chatService(url, init));
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(sidebar().getByLabelText('Delete conversation'));
    await settle();
    await act(async () => { present(held[0], 'Main Chat load')(answer(status, { id: 'main-1', messages: [] })); });
    await settle();
    expect(agent().threadId).toBe(status === 200 ? 'main-1' : 'new-1');
    expect(recents()).toEqual([]);
    if (status === 503) {
      expect(screen.getByRole('alert')).toHaveTextContent('Your Main Chat could not be opened.');
      fetchMock.mockImplementation(chatService);
      await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
      await settle();
      expect(agent().threadId).toBe('main-1');
      expect(screen.queryByRole('alert')).toBeNull();
    }
  });
});

it('propagates a failed latency reporter to the page error boundary', async () => {
  class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
    override state = { error: null as Error | null };
    static getDerivedStateFromError(error: Error) { return { error }; }
    override render() { return this.state.error ? <p>{this.state.error.message}</p> : this.props.children; }
  }
  const error = new Error('Latency reporting could not start: SDK initialization failed');
  error.name = 'LatencyReportingError';
  rum.config.mockReturnValueOnce({ appMonitorId: 'test', identityPoolId: 'test', region: 'us-east-1' });
  rum.start.mockRejectedValueOnce(error);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  cartridge.auth = auth();
  render(<Boundary><Page /></Boundary>);
  expect(await screen.findByText(error.message)).toBeDefined();
  expect(screen.queryByRole('textbox')).toBeNull();
});
