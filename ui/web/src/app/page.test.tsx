import type { HttpAgent, Message } from '@ag-ui/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Window as HappyDomWindow } from 'happy-dom';
import type { ButtonHTMLAttributes, ComponentType, ReactElement, ReactNode } from 'react';
import { Component, Fragment, createElement, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { afterAll, afterEach, assert, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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
  openingTurn: undefined as unknown as ReturnType<typeof vi.fn<(options: { agent: HttpAgent | undefined; forwardedProps?: Record<string, unknown> }) => void>>,
  runAgent: undefined as unknown as ReturnType<typeof vi.fn<(options: { agent: HttpAgent | undefined }) => void>>,
}));

// The oversized-copy test owns storage reconciliation, not parsing its megabyte replies as markdown.
// Every other page test, and kept-chat.test.tsx, keeps the real kept-view renderer.
const copyBoundary = vi.hoisted(() => ({ isolateRendering: false }));
// The build's Chat Service, read as the page's modules load.
vi.hoisted(() => {
  vi.stubEnv('NEXT_PUBLIC_CHAT_SERVICE_URL', 'http://chat.test');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

vi.mock('./kept-chat', async (importOriginal) => {
  const original = await importOriginal<typeof import('./kept-chat')>();
  return { ...original, KeptChat: (props: Parameters<typeof original.KeptChat>[0]) => copyBoundary.isolateRendering ? null : <original.KeptChat {...props} /> };
});

vi.mock('@copilotkit/react-core/v2', async () => {
  const { Streamdown } = await import('streamdown');
  const copilotkit = { runAgent: (options: { agent: HttpAgent | undefined; forwardedProps?: Record<string, unknown> }) =>
    options.forwardedProps?.opening === true ? copilot.openingTurn(options) : copilot.runAgent(options) };
  // Like CopilotChatMessageView: an assistant message slot renders its markdown. It virtualizes a long chat's rows
  // unless a `children` render prop lays out its
  // message elements.
  const MessageRow = ({ id, children }: { id: string; children?: ReactNode }) => {
    useEffect(() => {
      copilot.rowMounts += 1;
    }, []);
    return <div data-message-row={id}>{children}</div>;
  };
  // Like CopilotChatUserMessage: its message renderer slot shows the message's text in the bubble.
  type UserProps = { message: Message; messageRenderer?: ComponentType<{ content: string }> };
  const UserMessageRenderer = ({ content, className = '' }: { content: string; className?: string }) => <div className={`cpk:prose ${className}`}>{content}</div>;
  const CopilotChatUserMessage = Object.assign(
    ({ message, messageRenderer: Renderer = UserMessageRenderer }: UserProps) => (
      <div className="copilotKitMessage copilotKitUserMessage"><Renderer content={message.content as string} /></div>
    ),
    { MessageRenderer: UserMessageRenderer },
  );
  type MessageViewParts = { messageElements: ReactNode[]; messages: Message[]; isRunning: boolean; interruptElement: ReactNode };
  type AssistantProps = { message: Message; markdownRenderer?: ComponentType<{ content: string }> };
  const CopilotChatAssistantMessage = Object.assign(
    ({ message, markdownRenderer: Renderer }: AssistantProps) =>
      Renderer ? <Renderer content={message.content as string} /> : <Streamdown>{message.content as string}</Streamdown>,
    { MarkdownRenderer: ({ content, ...props }: { content: string }) => <Streamdown {...props}>{content}</Streamdown> },
  );
  const CopilotChatMessageView = Object.assign(
    ({ assistantMessage, userMessage, children }: { assistantMessage?: Partial<AssistantProps> | ComponentType<AssistantProps>; userMessage?: Partial<UserProps>; children?: (parts: MessageViewParts) => ReactNode }) => {
      const agentMessages = copilot.kits.at(-1)?.selfManagedAgents['research-agent']?.messages ?? [];
      const rows = copilot.rows
        ? agentMessages.flatMap((message) => {
            const row = message.role === 'tool' ? [] : [
              <MessageRow key={message.id} id={message.id}>{message.role === 'user' && <CopilotChatUserMessage message={message} {...userMessage} />}</MessageRow>,
            ];
            return copilot.slots ? [<Fragment key={`${message.id}-custom-before`} />, ...row, <Fragment key={`${message.id}-custom-after`} />] : row;
          })
        : [];
      // Like its slots: a component renders the message, or an object gives the default one its props.
      const Assistant = typeof assistantMessage === 'function' ? assistantMessage : (props: AssistantProps) => <CopilotChatAssistantMessage {...props} {...assistantMessage} />;
      const messageElements = copilot.reply === '' ? rows : [...rows, <Assistant key="reply" message={{ id: 'reply', role: 'assistant', content: copilot.reply }} />];
      const messages = copilot.rows ? agentMessages : copilot.messages;
      if (children) return <>{children({ messageElements, messages, isRunning: copilot.running, interruptElement: null })}</>;
      return <div data-testid="copilot-message-list" data-virtualized>{messageElements}</div>;
    },
    { Cursor: () => <div data-testid="copilot-loading-cursor" /> },
  );
  const CopilotChatInput = ({ isRunning = false, sendButton, addMenuButton, onAddFile, onSubmitMessage, onStop, onChange, textArea }:  { textArea?: Record<string, unknown>; onChange?: (value: string) => void; isRunning?: boolean; sendButton?: Record<string, unknown> | ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>; addMenuButton?: ButtonHTMLAttributes<HTMLButtonElement> | ComponentType<{ onAddFile?: (() => void) | undefined }>; onAddFile?: () => void; onSubmitMessage?: (message: string) => void; onStop?: () => void }) => {
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
              {sendCellShown && <div className="cpk:col-start-1" data-testid="add-cell">{/* Its + opens a menu whose one item, with onAddFile, adds files: here a click on it adds them. */}
                {typeof addMenuButton === 'function' ? createElement(addMenuButton, { onAddFile }) : <button type="button" data-testid="copilot-add-menu-button" disabled={!onAddFile} onClick={onAddFile} aria-label="Add files" {...addMenuButton} />}</div>}
              <textarea aria-label="Message" {...textArea} onChange={(event) => onChange?.(event.currentTarget.value)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter' && !event.shiftKey) { if (isRunning && !event.currentTarget.value.trim()) onStop?.(); else onSubmitMessage?.(event.currentTarget.value); } }} />
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
    CopilotKit: ({ children, ...props }: { children: ReactNode } & (typeof copilot.kits)[number]) => {
      copilot.kits.push(props);
      useEffect(() => {
        copilot.mounts += 1;
      }, []);
      return <>{children}</>;
    },
    // Like CopilotChat, in its .copilotKitChat box: its message view slot, CopilotChatMessageView unless replaced,
    // scrolls in its scroll view slot above an overlay pinned to the chat's bottom, which holds its input slot,
    // CopilotChatInput unless replaced. Once it measures the overlay, it pads its content by the overlay's height, which
    // its scroll view slot is told.
    // A slot is a component, or an object of props for CopilotKit's own.
    CopilotChat: (
      props: {
        input?: ComponentType<{ isRunning: boolean }>;
        messageView?: ComponentType;
        scrollView?: ComponentType<{ children: ReactNode }> | Record<string, unknown>;
      } & Record<string, unknown>,
    ) => {
      copilot.chat = props;
      const MessageView = props.messageView ?? CopilotChatMessageView;
      const Input = props.input ?? CopilotChatInput;
      const slot = props.scrollView;
      const ScrollView = (typeof slot === 'function' ? slot : CopilotChatScrollView) as ComponentType<{ children: ReactNode; inputContainerHeight: number }>;
      const scrollProps = typeof slot === 'function' ? {} : slot;
      const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
      const [inputContainerHeight, setInputContainerHeight] = useState(0);
      useEffect(() => {
        if (overlay === null) return undefined;
        const observer = new ResizeObserver(([entry]) => {
          if (entry !== undefined) setInputContainerHeight(entry.contentRect.height);
        });
        observer.observe(overlay);
        setInputContainerHeight(overlay.offsetHeight);
        return () => observer.disconnect();
      }, [overlay]);
      return (
        <div className="copilotKitChat">
          <ScrollView {...scrollProps} inputContainerHeight={inputContainerHeight}>
            <div data-testid="copilot-scroll-content" style={{ overflowY: 'auto', paddingBottom: `${inputContainerHeight + 32}px` }}>
              <MessageView />
            </div>
          </ScrollView>
          <div ref={setOverlay} data-testid="copilot-input-overlay">
            <Input isRunning={copilot.running} onSubmitMessage={(content: string) => {
              const submittedAgent = copilot.kits.at(-1)?.selfManagedAgents['research-agent'];
              submittedAgent?.addMessage({ id: 'submitted', role: 'user', content });
              copilot.runAgent({ agent: submittedAgent });
            }} />
          </div>
        </div>
      );
    },
    CopilotChatAssistantMessage,
    CopilotChatUserMessage,
    CopilotChatInput,
    CopilotChatMessageView,
    CopilotChatView: { ScrollToBottomButton, ScrollView: CopilotChatScrollView },
    useDefaultRenderTool: (config: { render: typeof copilot.renderTool }, deps?: unknown[]) => {
      useEffect(() => { copilot.renderTool = config.render; }, [JSON.stringify(deps ?? [])]);
    },
    useCopilotKit: () => ({ copilotkit }),
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
      title: 'Research Bot',
      agentName: 'Ada',
      subtitle: 'Ask about markets',
      disclaimer: 'Check your sources.',
      loginLabel: 'Sign in',
      relinkLabel: 'Relink account',
      logoutLabel: 'Sign out',
      accountLabel: 'Research Account',
    },
    toolResultRenderers: [() => <p>tool result renderer</p>],
    auxiliaryPanels: [
      (props) => {
        cartridge.panels.push(props);
        return <p>panel for {props.conversation.id}</p>;
      },
    ],
    ComputerView: ({ agentId, agentName, conversation, onConnectionChange }) => {
      useEffect(() => {
        cartridge.computerMounts += 1;
        onConnectionChange?.(true);
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
    theme: { '--accent': 'rebeccapurple' },
  };
  return { webUiPlugin };
});

// The agent's Files: no `/missing.svg`, and an upload only a test that attaches answers.
vi.mock('./agent-files', () => ({
  agentFiles: {
    url: (path: string) => (path === '/missing.svg' ? Promise.reject(new Error('Files download failed: 404')) : Promise.resolve(`https://files.test${path}?signed`)),
    upload: () => Promise.reject(new Error('No upload in this test')),
  },
}));

const rum = vi.hoisted(() => ({ config: vi.fn(() => null as null | { appMonitorId: string; identityPoolId: string; region: string }), start: vi.fn(() => Promise.resolve()) }));
vi.mock('./rum', () => ({ rumConfig: rum.config, startRum: rum.start }));

const { default: Page } = await import('./page');
const { agentFiles } = await import('./agent-files');

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
    const changes = JSON.parse(init?.body as string) as Record<string, unknown>;
    // A moved or cleared stop time is in the future here, so the task no longer has ended.
    return answer(200, { ...task, ...changes, ...('endDate' in changes ? { ended: false } : {}) });
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
  if (route.startsWith('PATCH /threads/') && thread !== undefined) {
    const { title } = JSON.parse(init?.body as string) as { title: string };
    service.sideChats = service.sideChats.map((entry) => entry.id === thread ? { ...entry, title } : entry);
    return answer(200, present(service.sideChats.find(({ id }) => id === thread), 'the renamed Side Chat'));
  }
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
const openSidebar = () => userEvent.click(sidebar().getByRole('button', { name: 'Toggle sidebar' }));
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
  fireEvent.change(textarea, { target: { value: text } });
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
  copyBoundary.isolateRendering = false;
  localStorage.clear();
  copilot.kits = [];
  copilot.mounts = 0;
  copilot.jumps = 0;
  copilot.chat = undefined;
  copilot.runAgent = vi.fn();
  copilot.openingTurn = vi.fn();
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

  it("offers the account's models and the harness's effort levels, starting from the first model and Medium", async () => {
    await renderPage();

    const pill = present(screen.getByText('Deep').closest('button'), 'the model pill');
    expect(pill).toHaveTextContent(/^DeepMedium$/);
    expect(kit().properties).toEqual({ model: 'deep', effort: 'medium', sandbox: true });

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
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{"mainChat":true,"effort":"medium"}' },
      ],
      [
        'http://chat.test/warmup',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{"threadId":"main-1","model":"deep","effort":"medium"}' },
      ],
    ]);

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));

    expect(warmups().at(-1)?.[1].body).toBe('{"threadId":"new-1","newChat":true,"model":"deep","effort":"medium"}');
  });

  // Unnamed, the Chat Service warms the account's first model, and the Harness skips a second warmup while one prepares.
  it("warms the Main Chat as it opens for the model this browser picked on the account, not the account's first", async () => {
    localStorage.setItem('botcube.picker-choice', JSON.stringify({ model: 'fast', account: 'acct-first' }));

    await renderPage(auth({ accountId: 'acct-first' }));

    expect(warmups().map(([, init]) => init.body)).toEqual([
      '{"mainChat":true,"model":"fast","effort":"medium"}',
      '{"threadId":"main-1","model":"fast","effort":"medium"}',
    ]);
  });

  it("leaves the Main Chat's opening warmup to the account's first model when this browser picked on another account", async () => {
    localStorage.setItem('botcube.picker-choice', JSON.stringify({ model: 'fast', account: 'acct-other' }));

    await renderPage(auth({ accountId: 'acct-first' }));

    expect(warmups().map(([, init]) => init.body)).toEqual([
      '{"mainChat":true,"effort":"medium"}',
      '{"threadId":"main-1","model":"deep","effort":"medium"}',
    ]);
  });

  it("does not allocate the previous account's new Side Chat after an account switch", async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    const before = warmups().length;
    cartridge.auth = auth({ accountId: 'acct-second' });
    view.rerender(<Page />);
    await settle();
    expect(warmups().slice(before).map(([, init]) => JSON.parse(String(init.body)))).not.toContainEqual(expect.objectContaining({ threadId: 'new-1', newChat: true }));
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
    expect(warmups().at(-1)?.[1].body).toBe('{"threadId":"main-1","model":"deep","effort":"medium"}');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the latest selected effort when Main Chat warmups wait for provisioning', async () => {
    let finishBoot!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup' && init?.body === '{"mainChat":true,"effort":"medium"}') {
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

  it('does not dispatch an immediate new Side warmup when old models load during an account switch', async () => {
    let current = true;
    let finishModels = () => {};
    const models = new Promise<void>((resolve) => { finishModels = resolve; });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/agent/models') await models;
      return chatService(url, init);
    });
    await renderPage(Object.assign(auth({ accountId: 'acct-first' }), { isAccountCurrent: () => current }));
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    await settle();
    const before = warmups().length;
    current = false;
    await act(async () => { finishModels(); });
    await settle();

    expect(copilot.chat?.threadId).toBe('new-1');
    expect(warmups()).toHaveLength(before);
  });

  it('does not dispatch a queued warmup after an account switch starts before rerender', async () => {
    let current = true;
    let finishBoot!: (response: Response) => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup' && init?.body === '{"mainChat":true,"effort":"medium"}') {
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
      if (url === 'http://chat.test/warmup' && init?.body === '{"mainChat":true,"effort":"medium"}') {
        return new Promise<Response>((resolve) => { finishBoot = resolve; });
      }
      return chatService(url, init);
    });
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    await settle();

    expect(warmups().at(-1)?.[1].body).toBe('{"threadId":"new-1","newChat":true,"model":"deep","effort":"medium"}');
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

    expect(copilot.openingTurn).toHaveBeenCalledOnce();
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
  it('lets the agent greet a signed-in user', async () => {
    await renderPage(auth({ user: { name: 'Ada Lovelace' } }));

    expect(welcome()).toBeNull();
    expect(copilot.openingTurn).toHaveBeenCalledExactlyOnceWith({ agent: agent(), forwardedProps: { opening: true, openingFirstName: 'Ada' } });
  });

  it('lets the agent open for a user without a name', async () => {
    await renderPage();

    expect(welcome()).toBeNull();
    expect(copilot.openingTurn).toHaveBeenCalledOnce();
  });

  it.each([
    ['signed out', 'unauthed'],
    ['signing in', 'loading'],
    ['whose sign-in failed', 'error'],
  ] as const)('offers no sign-in to a user %s', async (_, status) => {
    await renderPage(auth({ status, error: status === 'error' ? 'Account locked' : null }));

    expect(welcome()).toBeNull();
    expect(copilot.openingTurn).toHaveBeenCalledOnce();
    expect(within(present(document.querySelector('main.app-shell'), 'the chat shell')).queryByRole('button', { name: 'Sign in' })).toBeNull();
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
    // In the chat's alerts, which stay on screen under a phone's header as its chat scrolls the page (#3613).
    expect(header().nextElementSibling).toHaveClass('chat-alerts');
    expect(header().nextElementSibling).toContainElement(alert);
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

    expect(requests()).toEqual(['GET /main-chat', 'GET /threads']);
  });

  it('does not count other keys as sending', async () => {
    await renderPage();
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Message');
    textarea.value = 'draft';

    fireEvent.keyDown(textarea, { key: 'a' });

    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(agent().messages).toEqual([]);
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
    const lookup = vi.spyOn(agentFiles, 'url');
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
    const lookup = vi.spyOn(agentFiles, 'url');
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
    const lookup = vi.spyOn(agentFiles, 'url');
    lookup.mockResolvedValueOnce('https://files.test/chart.svg?initial').mockRejectedValueOnce(new Error('Files download failed: 403'));
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
    vi.spyOn(agentFiles, 'url').mockResolvedValueOnce('https://files.test/chart.svg?signed').mockRejectedValueOnce(new Error('Files download failed: 403'));
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
    const lookup = vi.spyOn(agentFiles, 'url');
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
    copyBoundary.isolateRendering = true;
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
    expect(warmups().map(([, init]) => JSON.parse(String(init.body)))).not.toContainEqual(expect.objectContaining({ threadId: 'main-other', newChat: true }));
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

// The chat opened at its top and scrolled to its latest message frames later, moving the kept messages (#3697).
describe('the kept Main Chat over the chat as it opens', () => {
  const earlier: Message[] = [
    { id: 'm1', role: 'user', content: 'Earlier question' },
    { id: 'm2', role: 'assistant', content: 'Earlier answer' },
  ];
  // The frames requested and not cancelled, by id.
  const frames = new Map<number, FrameRequestCallback>();
  let frameIds = 0;
  const frame = (now = 0) => act(async () => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(now);
  });
  const keptChat = () => screen.queryByRole('status', { name: 'Loading chat controls' });
  const opening = () => document.querySelector('.app-chat-opening');
  // The chat's scroll view, 300px tall, over its content `height` px tall, scrolled `top` px down.
  const layOut = (height: () => number, top: () => number) => {
    const scrollView = screen.getByTestId('copilot-scroll-view');
    Object.defineProperty(scrollView, 'clientHeight', { configurable: true, value: 300 });
    Object.defineProperty(scrollView, 'scrollHeight', { configurable: true, get: height });
    Object.defineProperty(scrollView, 'scrollTop', { configurable: true, get: top });
  };

  beforeEach(() => {
    frames.clear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameIds += 1;
      frames.set(frameIds, callback);
      return frameIds;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', provider: 'openai', messages: earlier }));
    service.mainChat = { id: 'main-1', provider: 'openai', messages: earlier };
  });

  it('lifts on the first frame when the chat has nothing to scroll', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    layOut(() => 200, () => 0);
    expect(keptChat()).toHaveTextContent('Earlier answer');
    expect(opening()).toContainElement(screen.getByTestId('copilot-message-list'));

    await frame();

    expect(keptChat()).toBeNull();
    expect(opening()).toBeNull();
  });

  it('stays until the first frame the chat shows its latest message', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    let top = 0;
    layOut(() => 1000, () => top);

    await frame();
    top = 698;
    await frame();
    expect(keptChat()).not.toBeNull();

    // Within a pixel of the end, as a scroll position rounds.
    top = 699;
    await frame();

    expect(keptChat()).toBeNull();
    expect(opening()).toBeNull();
  });

  it('stays at the latest message until the chat has made room for its composer below it', async () => {
    // Like a ResizeObserver: CopilotKit measures its composer some commits after it mounts. Until then, its content
    // ends 32px below the latest message, and a chat at its end there moves once the composer's room arrives.
    const observed = new Map<Element, ResizeObserverCallback[]>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          observed.set(target, [...(observed.get(target) ?? []), this.callback]);
        }
        disconnect() {}
      },
    );
    await renderPage(auth({ accountId: 'acct-first' }));
    const overlay = screen.getByTestId('copilot-input-overlay');
    Object.defineProperty(overlay, 'offsetHeight', { configurable: true, value: 98 });
    layOut(() => 870, () => 570);

    await frame();
    expect(keptChat()).not.toBeNull();

    await act(async () => {
      const entry = { target: overlay, contentRect: { height: 98 } } as unknown as ResizeObserverEntry;
      for (const callback of observed.get(overlay) ?? []) callback([entry], {} as ResizeObserver);
    });
    await frame();

    expect(keptChat()).toBeNull();
  });

  it('stays while a reply in flight grows the chat past its latest message, then lifts there', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    let top = 0;
    layOut(() => agent().messages.length * 500, () => top);
    await frame();

    top = 700;
    await agentAddsMessage({ id: 'm3', role: 'assistant', content: 'A reply in flight' });
    await frame();
    expect(keptChat()).not.toBeNull();

    top = 1200;
    await frame();

    expect(keptChat()).toBeNull();
  });

  it('lifts a second on when the chat never reaches its latest message', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(5000);
    await renderPage(auth({ accountId: 'acct-first' }));
    layOut(() => 1000, () => 0);

    await frame(5999);
    expect(keptChat()).not.toBeNull();
    await frame(6000);

    expect(keptChat()).toBeNull();
  });

  it('stays over a chat opened as it shows until that chat reaches its latest message, not the chat left', async () => {
    service.sideChats = [sideChat('side', 'Side question')];
    await renderPage(auth({ accountId: 'acct-first' }));
    layOut(() => 1000, () => 0);

    await userEvent.click(sidebar().getByText('Side question'));
    await settle();
    expect(copilot.chat?.threadId).toBe('side');
    layOut(() => 1000, () => 0);
    await frame();

    expect(keptChat()).not.toBeNull();
  });

  it('goes with the chat when the chat unmounts', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    expect(keptChat()).not.toBeNull();
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new DOMException('The operation is insecure.', 'SecurityError'); });

    cartridge.auth = auth({ accountId: 'acct-second' });
    view.rerender(<Page />);
    await settle();

    expect(screen.queryByTestId('copilot-message-list')).toBeNull();
    expect(keptChat()).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('leaves the chat taking a message right after it lifts', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    layOut(() => 200, () => 0);
    await frame();

    await userEvent.type(screen.getByLabelText('Message'), 'Next question{Enter}');

    expect(copilot.runAgent).toHaveBeenCalledOnce();
    expect(agent().messages.at(-1)).toMatchObject({ role: 'user', content: 'Next question' });
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

  it('times a first visit to an empty Main Chat before its opening Turn replies', async () => {
    await renderPage();

    expect(welcome()).toBeNull();
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
    // row being read moves down by the rows joining above it. An app zoomed by `zoom` shows them `zoom` times as tall.
    const layOut = (height: (row: string | null) => number = () => 100, zoom = 1) => {
      const all = () => [...document.querySelectorAll('[data-message-row]')];
      const sum = (laid: Element[]) => laid.reduce((total, row) => total + height(row.getAttribute('data-message-row')), 0);
      Object.defineProperty(scrollView(), 'clientHeight', { configurable: true, value: 300 });
      Object.defineProperty(scrollView(), 'scrollHeight', { configurable: true, get: () => sum(all()) });
      Object.defineProperty(scrollView(), 'currentCSSZoom', { configurable: true, value: zoom });
      return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        if (this === scrollView()) return { top: 0, bottom: 300 * zoom } as DOMRect;
        const index = all().indexOf(this);
        const top = (index === -1 ? -100 : sum(all().slice(0, index))) - scrollView().scrollTop;
        const bottom = index === -1 ? top : top + height(this.getAttribute('data-message-row'));
        return { top: top * zoom, bottom: bottom * zoom } as DOMRect;
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

    // The wide desktop zooms the app 1.4×: a row's rect is in the screen's pixels, the scroll in the scroll view's own,
    // and the rows joining above moved the view 1.4× as far as they pushed the row being read.
    it('keeps the row being read in place in an app the wide desktop zooms', async () => {
      await renderPage();
      layOut(undefined, 1.4);
      await scrollToTop();

      expect(scrollView().scrollTop).toBeCloseTo(400);
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

  // The cursor stood for the model's first ~7 s on a Main Turn: from RUN_STARTED, the Worklog's head says it works (#4013).
  describe('once the run starts', () => {
    const question: Message = { id: 'started-question', role: 'user', content: 'What moved the 10y?' };
    /** Streams `events` into the running Turn, then lays the chat out again, as CopilotKit does on each message. */
    let send: (...events: Record<string, unknown>[]) => Promise<void>;
    let finish: () => Promise<void>;

    beforeEach(async () => {
      vi.useFakeTimers();
      // The Turn clocks outlive a test; one fixed start keeps runner time between tests out of the head's clock.
      vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
      copilot.rows = true;
      copilot.running = true;
      const view = await renderPage();
      const current = agent();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
        url === 'http://chat.test' && init?.method === 'POST'
          ? new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'content-type': 'text/event-stream' } })
          : chatService(url, init),
      );
      send = async (...events) => {
        for (const event of events) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        await settle();
        view.rerender(<Page />);
        await settle();
      };
      let turn!: Promise<unknown>;
      await act(async () => {
        current.addMessage(question);
        turn = current.runAgent({ runId: 'started-run' }).catch(() => undefined);
      });
      finish = async () => {
        await send({ type: 'RUN_FINISHED', threadId: current.threadId, runId: 'started-run' });
        await act(async () => { stream.close(); await turn; });
      };
      await settle();
      expect(screen.getByTestId('copilot-loading-cursor')).toBeInTheDocument();
      await send({ type: 'RUN_STARTED', threadId: current.threadId, runId: 'started-run' });
    });

    afterEach(() => finish());

    it('shows the Worklog head in place of the cursor', () => {
      expect(screen.queryByTestId('copilot-loading-cursor')).toBeNull();
      expect(document.querySelector('.worklog')).toHaveTextContent(/^Working · 1s$/);
    });

    it("shows the header's agent at his laptop, his name over \"is working\"", () => {
      const agentButton = screen.getByRole('button', { name: 'Agent profile' });
      expect(agentButton).toHaveAttribute('data-working');
      expect(agentButton.querySelector('.chat-header-name')).toHaveTextContent(/^Ada Botis working$/);
      expect(agentButton.querySelector('.chat-header-status')).toHaveTextContent(/^is working$/);
      expect(agentButton.querySelector('.avatar-agent .avatar-laptop')).not.toBeNull();
    });

    it('gives way to an answer that comes with no rows', async () => {
      await send(
        { type: 'TEXT_MESSAGE_START', messageId: 'started-answer', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'started-answer', delta: 'It rose 4bp.' },
      );

      expect(document.querySelector('[data-message-row="started-answer"]')).not.toBeNull();
      expect(document.querySelector('.worklog')).toBeNull();
      expect(screen.queryByTestId('copilot-loading-cursor')).toBeNull();
    });

    // Only the page hands the head and its rows' Worklog the same clock, the question's id.
    it("folds the Turn's rows under its head as they come, carrying on its clock", async () => {
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      await send({ type: 'TOOL_CALL_START', toolCallId: 'started-call', toolCallName: 'read_file', parentMessageId: 'started-note' });

      expect(document.querySelectorAll('.worklog')).toHaveLength(1);
      const head = screen.getByRole('button', { name: /^Working/ });
      expect(head).toHaveTextContent(/^Working · 3s$/);
      expect(document.querySelector('.worklog-body [data-message-row="started-note"]')).not.toBeNull();
      expect(screen.queryByTestId('copilot-loading-cursor')).toBeNull();
    });
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
    expect(document.querySelector('.sidebar-item-active')).toBeNull();
  });

  // Plugins, under Main chat, opens a screen of the plugin kinds to come, each a placeholder (#3654).
  it('opens the Plugins screen in place of the chat, and returns to the Main Chat', async () => {
    await renderPage();

    await userEvent.click(sidebar().getByRole('button', { name: 'Plugins' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Connectors', 'MCP servers', 'Skills']);
    expect(screen.getAllByText('Coming soon')).toHaveLength(3);
    expect(sidebar().getByRole('button', { name: 'Plugins' })).toHaveClass('sidebar-nav-item-active');
    expect(sidebar().getByRole('button', { name: 'Main Chat' })).not.toHaveClass('sidebar-nav-item-active');
    expect(document.querySelector('.chat-header')?.closest('main')).not.toBeVisible();

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await settle();

    expect(screen.queryByRole('heading', { name: 'Plugins' })).toBeNull();
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

// AgentCore reaps a Sandbox idle for 15 minutes, and a user coming back sent the next Turn to a cold one.
describe('a user coming back to the page', () => {
  const warmupBodies = () => warmups().map(([, init]) => init.body);
  const minutesPass = (minutes: number) => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + minutes * 60_000);
  };

  it.each(comeBackEvents)('warms the open Main Chat again (%s)', async (event) => {
    await renderPage();
    const before = warmups().length;
    minutesPass(5);

    await userComesBack(event);

    expect(warmupBodies().slice(before)).toEqual(['{"threadId":"main-1","model":"deep","effort":"medium"}']);
  });

  it('warms the open Side Chat again with its model and effort', async () => {
    await renderPage();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    await userEvent.click(present(document.querySelector<HTMLElement>('.mep-pill'), 'model picker'));
    const dropdown = within(present(document.querySelector<HTMLElement>('.mep-dropdown'), 'model dropdown'));
    await userEvent.click(dropdown.getByText('Effort'));
    await userEvent.click(dropdown.getByText('High'));
    await settle();
    const before = warmups().length;
    minutesPass(5);

    await userComesBack();

    expect(warmupBodies().slice(before)).toEqual(['{"threadId":"new-1","newChat":true,"model":"deep","effort":"high"}']);
  });

  it('leaves a chat warmed in the last 5 minutes alone', async () => {
    await renderPage();
    const before = warmups().length;

    minutesPass(4);
    await userComesBack('visibilitychange');
    expect(warmups()).toHaveLength(before);

    minutesPass(1);
    await userComesBack('visibilitychange');
    await userComesBack('focus');
    expect(warmups()).toHaveLength(before + 1);
  });

  it('does not queue a comeback behind a warmup still in flight after five minutes', async () => {
    await renderPage();
    const pending: ((response: Response) => void)[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup') return new Promise<Response>((resolve) => pending.push(resolve));
      return chatService(url, init);
    });
    minutesPass(5);
    await userComesBack();
    expect(pending).toHaveLength(1);
    const before = warmups().length;
    minutesPass(5);

    await userComesBack('visibilitychange');
    await userComesBack('focus');
    fetchMock.mockImplementation(chatService);
    await act(async () => { present(pending[0], 'the pending comeback warmup')(answer(200)); });
    await settle();

    expect(warmups()).toHaveLength(before);
  });

  it('waits while the page is hidden', async () => {
    await renderPage();
    const before = warmups().length;
    minutesPass(5);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    await userComesBack('visibilitychange');

    expect(warmups()).toHaveLength(before);
  });

  it('leaves a running Turn alone', async () => {
    await renderPage();
    const before = warmups().length;
    minutesPass(5);
    agent().isRunning = true;

    await userComesBack();

    expect(warmups()).toHaveLength(before);
  });

  it('leaves a Turn running on the server alone', async () => {
    service.mainChat = { id: 'main-1', messages: [], running: true, runId: 'background-run' };
    await renderPage();
    const before = warmups().length;
    minutesPass(5);

    await userComesBack();

    expect(warmups()).toHaveLength(before);
  });

  it.each(comeBackEvents)('warms once stale server Turn state clears after comeback (%s)', async (event) => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [], running: true, runId: 'background-run' };
    await renderPage();
    const before = warmups().length;
    minutesPass(16);

    await userComesBack(event);
    expect(warmups()).toHaveLength(before);
    service.mainChat = { id: 'main-1', messages: [], running: false };
    await act(async () => { vi.advanceTimersByTime(3_000); });
    await settle();

    expect(warmupBodies().slice(before)).toEqual(['{"threadId":"main-1","model":"deep","effort":"medium"}']);
  });

  it('does not rewarm after a server Turn ends without a comeback', async () => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [], running: true, runId: 'background-run' };
    await renderPage();
    const before = warmups().length;
    minutesPass(16);
    service.mainChat = { id: 'main-1', messages: [], running: false };
    await act(async () => { vi.advanceTimersByTime(3_000); });
    await settle();

    expect(warmups()).toHaveLength(before);
  });

  it('reports a failed warmup', async () => {
    await renderPage();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/warmup') throw new Error('offline');
      return chatService(url, init);
    });
    minutesPass(5);

    await userComesBack();

    expect(screen.getByRole('alert')).toHaveTextContent('Your agent could not be prepared: offline');
  });

  it.each(comeBackEvents)('stops listening once the page is gone (%s)', async (event) => {
    const { unmount } = await renderPage();
    const before = warmups().length;
    unmount();
    minutesPass(5);

    await userComesBack(event);

    expect(warmups()).toHaveLength(before);
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
    await openSidebar();
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
    await openSidebar();
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
    await openSidebar();
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

// A follow-up sent while a Turn ran waited out of sight in CopilotKit's memory, so a reload lost it (#3920).
describe('a follow-up sent while a Turn runs', () => {
  const question: Message = { id: 'q', role: 'user', content: 'Run sleep 30' };
  const reply: Message = { id: 'a', role: 'assistant', content: 'QA3903_QUEUE_SLOW' };
  const followUp = 'Reply with exactly QUEUED_SURVIVED';
  const queued = () => within(screen.getByTestId('copilot-message-list')).queryByRole('status', { name: 'Queued message' });
  const sentTo = () => copilot.runAgent.mock.calls.map(([{ agent: sent }]) => [sent?.threadId, sent?.messages.at(-1)?.content]);

  async function threeSecondsPass() {
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await settle();
  }

  async function reload(state = auth({ accountId: 'acct-first' }), view?: ReturnType<typeof render>) {
    view?.unmount();
    copilot.kits = [];
    return renderPage(state);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'server-run' };
  });

  it('shows as pending, survives a reload, and sends once after the Turn ends', async () => {
    const first = await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    expect(queued()).toHaveTextContent('Sends when this reply ends');

    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(queued()).toHaveTextContent(followUp);

    const second = await reload(undefined, first);
    expect(queued()).toHaveTextContent(followUp);
    await threeSecondsPass();
    expect(copilot.runAgent).not.toHaveBeenCalled();

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(sentTo()).toEqual([['main-1', followUp]]);
    expect(agent().messages.map(({ content }) => content)).toEqual([question.content, reply.content, followUp]);
    expect(queued()).toBeNull();

    await reload(undefined, second);
    expect(queued()).toBeNull();
    expect(copilot.runAgent).toHaveBeenCalledTimes(1);
  });

  it('waits for a Turn streaming here, then for it on the server after a reload', async () => {
    service.mainChat = { id: 'main-1', messages: [] };
    const first = await renderPage(auth({ accountId: 'acct-first' }));
    const current = agent();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test' && init?.method === 'POST') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: current.threadId, runId: 'server-run' })}\n\n`));
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return chatService(url, init);
    });
    await act(async () => {
      current.addMessage(question);
      void current.runAgent({ runId: 'server-run' }).catch(() => undefined);
    });
    await settle();
    await sendMessage(followUp);
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(queued()).toHaveTextContent(followUp);

    fetchMock.mockImplementation(chatService);
    service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'server-run' };
    await reload(undefined, first);
    expect(queued()).toHaveTextContent(followUp);
    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(sentTo()).toEqual([['main-1', followUp]]);
  });

  it("holds it while the page shows this browser's copy of the Main Chat, until the load says the Turn ended", async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    localStorage.setItem('botcube.main-chat', JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: [question] }));
    let answerMainChat!: () => void;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat'
        ? new Promise<Response>((resolve) => { answerMainChat = () => resolve(answer(200, service.mainChat)); })
        : chatService(url, init),
    );

    await reload(undefined, view);
    expect(queued()).toHaveTextContent(followUp);
    expect(copilot.runAgent).not.toHaveBeenCalled();

    await act(async () => { answerMainChat(); });
    await settle();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    fetchMock.mockImplementation(chatService);
    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(sentTo()).toEqual([['main-1', followUp]]);
  });

  it('waits in a reloaded Side Chat through a Stop, until the server says the Turn ended', async () => {
    service.mainChat = { id: 'main-1', messages: [] };
    service.replies.set('side', [question]);
    service.running.add('side');
    service.runIds.set('side', 'server-run');
    window.history.replaceState(null, '', '/?chat=side');
    const first = await renderPage(auth({ accountId: 'acct-first' }));
    expect(agent().threadId).toBe('side');
    await sendMessage(followUp);
    expect(queued()).toHaveTextContent(followUp);

    await reload(undefined, first);
    expect(agent().threadId).toBe('side');
    expect(queued()).toHaveTextContent(followUp);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await settle();
    expect(copilot.runAgent).not.toHaveBeenCalled();

    service.running.delete('side');
    service.runIds.delete('side');
    service.replies.set('side', [question, reply]);
    await threeSecondsPass();
    expect(sentTo()).toEqual([['side', followUp]]);
  });

  it("holds it when the load of this browser's copy of the Main Chat fails, until a Retry says the Turn ended", async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    localStorage.setItem('botcube.main-chat', JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: [question] }));
    service.failing.set('GET /main-chat', 503);

    await reload(undefined, view);
    expect(screen.getByText('Your Main Chat could not be opened.')).toBeInTheDocument();
    await threeSecondsPass();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(queued()).toHaveTextContent(followUp);

    service.failing.delete('GET /main-chat');
    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(sentTo()).toEqual([['main-1', followUp]]);
  });

  it('holds it while the browser is offline, across a reload, and sends once back online', async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(copilot.runAgent).not.toHaveBeenCalled();

    await reload(undefined, view);
    expect(queued()).toHaveTextContent(followUp);
    onLine.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await settle();
    expect(sentTo()).toEqual([['main-1', followUp]]);
  });

  it('sends it from one tab only when the chat is open in another', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);

    // Another tab sends it first: the follow-up leaves this browser's storage.
    const held = present(localStorage.getItem('botcube.queued-follow-ups:acct-first'), 'the held follow-up');
    localStorage.removeItem('botcube.queued-follow-ups:acct-first');
    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(queued()).toBeNull();

    // A follow-up another tab holds reaches this one, which sends it once the server says no Turn runs and its
    // claim finds it still held.
    await act(async () => {
      localStorage.setItem('botcube.queued-follow-ups:acct-first', held);
      window.dispatchEvent(new StorageEvent('storage', { key: 'botcube.queued-follow-ups:acct-first' }));
    });
    await settle();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    await threeSecondsPass();
    expect(sentTo()).toEqual([['main-1', followUp]]);
    expect(localStorage.getItem('botcube.queued-follow-ups:acct-first')).toBeNull();
  });

  it('still sends one this browser could not keep, as its storage is full', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    await sendMessage(followUp);
    expect(queued()).toHaveTextContent(followUp);
    expect(queued()).toHaveTextContent('Not kept in this browser: leaving this chat or reloading loses it');
    expect(localStorage.getItem('botcube.queued-follow-ups:acct-first')).toBeNull();

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(sentTo()).toEqual([['main-1', followUp]]);
  });

  it('keeps one this browser can no longer read back, unsent, and says why', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(queued()).toHaveTextContent(followUp);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be taken out of this browser');
  });

  it("sends what another tab added to it just before the Turn ended, once, as one message", async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    localStorage.setItem('botcube.queued-follow-ups:acct-first', JSON.stringify({ 'main-1': `${followUp}\n\nAnd from the other tab` }));

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(sentTo()).toEqual([['main-1', `${followUp}\n\nAnd from the other tab`]]);
  });

  it('keeps a follow-up added after storage stopped answering, unsent, while its earlier part may still be stored', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    await sendMessage('And one more');
    expect(queued()).toHaveTextContent('And one more');

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('could not be taken out of this browser');
  });

  it('keeps one this browser cannot take out of storage, unsent, and says why', async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    const removeItem = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(queued()).toHaveTextContent(followUp);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be taken out of this browser');

    removeItem.mockRestore();
    await reload(undefined, view);
    expect(sentTo()).toEqual([['main-1', followUp]]);
  });

  it('keeps one sent from the copy before the account session answers, and sends it after the Turn', async () => {
    localStorage.setItem('botcube.main-chat', JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: [question] }));
    const view = await renderPage(auth({ sessionStatus: 'loading' }));
    await sendMessage(followUp);
    expect(queued()).toHaveTextContent(followUp);

    cartridge.auth = auth({ accountId: 'acct-first' });
    view.rerender(<Page />);
    await settle();
    expect(queued()).toHaveTextContent(followUp);
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(localStorage.getItem('botcube.queued-follow-ups:acct-first')).toContain(followUp);

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(sentTo()).toEqual([['main-1', followUp]]);
  });

  it("says to reload when the account's models failed to load, keeping it for the reload", async () => {
    service.failing.set('GET /agent/models', 503);
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Reload the page to send your queued message\.$/);
    expect(queued()).toHaveTextContent(followUp);

    service.failing.delete('GET /agent/models');
    await reload(undefined, view);
    expect(sentTo()).toEqual([['main-1', followUp]]);
  });

  it("joins one held before the account session answered to what another tab holds for the chat", async () => {
    localStorage.setItem('botcube.main-chat', JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: [question] }));
    const view = await renderPage(auth({ sessionStatus: 'loading' }));
    await sendMessage(followUp);
    localStorage.setItem('botcube.queued-follow-ups:acct-first', JSON.stringify({ 'main-1': 'From the other tab' }));

    cartridge.auth = auth({ accountId: 'acct-first' });
    view.rerender(<Page />);
    await settle();
    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(sentTo()).toEqual([['main-1', `From the other tab\n\n${followUp}`]]);
  });

  it('keeps one sent before the account session answered that waited on another tab\'s lock until after it did', async () => {
    localStorage.setItem('botcube.main-chat', JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: [question] }));
    const view = await renderPage(auth({ sessionStatus: 'loading' }));
    // Another tab holds the lock until the account session has answered.
    const release = lockHeldElsewhere();
    await sendMessage(followUp);

    cartridge.auth = auth({ accountId: 'acct-first' });
    view.rerender(<Page />);
    await settle();
    await release();
    expect(localStorage.getItem('botcube.queued-follow-ups:acct-first')).toBe(JSON.stringify({ 'main-1': followUp }));
    expect(queued()).toHaveTextContent(followUp);
  });

  /** Another tab holds the lock until `release`: the lock requests made meanwhile wait for it. */
  function lockHeldElsewhere() {
    let release!: () => void;
    const busy = new Promise<void>((resolve) => { release = resolve; });
    const request = navigator.locks.request.bind(navigator.locks);
    vi.spyOn(navigator.locks, 'request').mockImplementation(((name: string, callback: () => unknown) =>
      busy.then(() => request(name, callback))) as typeof navigator.locks.request);
    return async () => {
      await act(async () => { release(); });
      await settle();
    };
  }

  it('never sends one cancelled while its send waited on another tab\'s lock', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    const release = lockHeldElsewhere();
    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }));
    await release();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(queued()).toBeNull();
    expect(localStorage.getItem('botcube.queued-follow-ups:acct-first')).toBeNull();
  });

  it('keeps one whose send waited on the lock while the connection went, stored and unsent', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    const release = lockHeldElsewhere();
    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    // The connection goes before the lock is granted, and before the page hears of it.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await release();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(queued()).toHaveTextContent(followUp);
    expect(localStorage.getItem('botcube.queued-follow-ups:acct-first')).toBe(JSON.stringify({ 'main-1': followUp }));
  });

  it('sends one added while storage refused to grow, with the earlier part storage kept', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    await sendMessage('And one more');
    expect(queued()).toHaveTextContent(/And one more/);

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(sentTo()).toEqual([['main-1', `${followUp}\n\nAnd one more`]]);
    expect(localStorage.getItem('botcube.queued-follow-ups:acct-first')).toBeNull();
  });

  it('keeps one held before the account session answered through another tab\'s change to the chat', async () => {
    localStorage.setItem('botcube.main-chat', JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: [question] }));
    const view = await renderPage(auth({ sessionStatus: 'loading' }));
    await sendMessage(followUp);
    const release = lockHeldElsewhere();
    cartridge.auth = auth({ accountId: 'acct-first' });
    view.rerender(<Page />);
    await settle();
    await act(async () => {
      localStorage.setItem('botcube.queued-follow-ups:acct-first', JSON.stringify({ 'main-1': 'From the other tab' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'botcube.queued-follow-ups:acct-first' }));
    });
    expect(queued()).toHaveTextContent(/From the other tab\s*Reply with exactly/);
    await release();
    expect(localStorage.getItem('botcube.queued-follow-ups:acct-first')).toBe(JSON.stringify({ 'main-1': `From the other tab\n\n${followUp}` }));
  });

  it('sends at once in a Side Chat chosen again while its stream ran, once the server says the Turn ended', async () => {
    service.mainChat = { id: 'main-1', messages: [] };
    service.sideChats = [sideChat('side', 'Other chat')];
    service.replies.set('side', [question]);
    await renderPage(auth({ accountId: 'acct-first' }));
    fireEvent.click(sidebar().getByText('Other chat'));
    await settle();
    const streaming = agent();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test' && init?.method === 'POST') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 'side', runId: 'side-run' })}\n\n`));
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return chatService(url, init);
    });
    await act(async () => {
      void streaming.runAgent({ runId: 'side-run' }).catch(() => undefined);
    });
    await settle();

    fetchMock.mockImplementation(chatService);
    service.replies.set('side', [question, reply]);
    fireEvent.click(sidebar().getByText('Other chat'));
    await settle();
    expect(agent()).not.toBe(streaming);
    await sendMessage(followUp);
    expect(queued()).toBeNull();
    expect(sentTo()).toEqual([['side', followUp]]);
  });

  it('waits on the server before sending one another tab holds while it streams the Turn', async () => {
    service.mainChat = { id: 'main-1', messages: [question], running: false };
    await renderPage(auth({ accountId: 'acct-first' }));
    // The other tab streams a Turn this one has not heard of, and holds a follow-up for after it.
    service.mainChat = { id: 'main-1', messages: [question], running: true, runId: 'other-tab-run' };
    await act(async () => {
      localStorage.setItem('botcube.queued-follow-ups:acct-first', JSON.stringify({ 'main-1': followUp }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'botcube.queued-follow-ups:acct-first' }));
    });
    await settle();
    expect(queued()).toHaveTextContent(followUp);
    expect(copilot.runAgent).not.toHaveBeenCalled();
    await threeSecondsPass();
    expect(copilot.runAgent).not.toHaveBeenCalled();

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(sentTo()).toEqual([['main-1', followUp]]);
  });

  it('gathers a second follow-up into the pending one', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage('First');
    await sendMessage('Second');
    expect(queued()).toHaveTextContent(/^First\s*Second/);

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(sentTo()).toEqual([['main-1', 'First\n\nSecond']]);
  });

  it('never sends a follow-up the user cancelled, after a reload either', async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }));
    await settle();
    expect(queued()).toBeNull();

    await reload(undefined, view);
    expect(queued()).toBeNull();
    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await threeSecondsPass();
    expect(copilot.runAgent).not.toHaveBeenCalled();
  });

  it('keeps one whose cancel this browser cannot take out of storage, and says why', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }));
    await settle();
    expect(queued()).toHaveTextContent(followUp);
    expect(screen.getByRole('alert')).toHaveTextContent('so it was not cancelled');
  });

  it('keeps all of one whose cancel storage refuses, its unsaved part too', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    await sendMessage('And one more');
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }));
    await settle();
    expect(queued()).toHaveTextContent(/Reply with exactly QUEUED_SURVIVED\.?\s*And one more/);
    expect(screen.getByRole('alert')).toHaveTextContent('so it was not cancelled');
  });

  it('keeps one added while a cancel storage then refuses waited on the lock', async () => {
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);
    const release = lockHeldElsewhere();
    vi.spyOn(localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued message' }));
    await sendMessage('A new one instead');
    await release();
    expect(queued()).toHaveTextContent(/Reply with exactly QUEUED_SURVIVED\.?\s*A new one instead/);
    expect(screen.getByRole('alert')).toHaveTextContent('so it was not cancelled');
  });

  it('forgets it under the lock at sign-out, even when the first removal fails', async () => {
    const state = auth({ accountId: 'acct-first' });
    await renderPage(state);
    await sendMessage(followUp);
    const remove = localStorage.removeItem.bind(localStorage);
    let failed = false;
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
      if (key === 'botcube.queued-follow-ups:acct-first' && !failed) {
        failed = true;
        throw new DOMException('The operation is insecure.', 'SecurityError');
      }
      remove(key);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fireEvent.click(sidebar().getByRole('button', { name: 'Account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await settle();
    expect(failed).toBe(true);
    expect(state.logout).toHaveBeenCalled();
    expect(localStorage.getItem('botcube.queued-follow-ups:acct-first')).toBeNull();
  });

  it('stays with its chat when the user opens another, and sends there on return', async () => {
    service.sideChats = [sideChat('side', 'Other chat')];
    await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);

    fireEvent.click(sidebar().getByText('Other chat'));
    await settle();
    expect(agent().threadId).toBe('side');
    expect(queued()).toBeNull();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    await sendMessage('Side question');
    expect(sentTo()).toEqual([['side', 'Side question']]);

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    fireEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await settle();
    expect(sentTo()).toEqual([['side', 'Side question'], ['main-1', followUp]]);
  });

  it("never shows or sends one account's follow-up for another", async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await sendMessage(followUp);

    service.mainChat = { id: 'main-1', messages: [question, reply], running: false };
    await reload(auth({ accountId: 'acct-second' }), view);
    await threeSecondsPass();
    expect(queued()).toBeNull();
    expect(copilot.runAgent).not.toHaveBeenCalled();
    expect(localStorage.getItem('botcube.queued-follow-ups:acct-second')).toBeNull();
  });

  it("never drops another account's follow-up from a tab still on its own account", async () => {
    const second = await renderPage(auth({ accountId: 'acct-second' }));
    await sendMessage(followUp);
    // A tab still on the first account loads, and hears of every change to storage.
    const first = await reload(auth({ accountId: 'acct-first' }), second);
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: null })); });
    await settle();

    await reload(auth({ accountId: 'acct-second' }), first);
    expect(queued()).toHaveTextContent(followUp);
  });

  it('leaves no follow-up in this browser after a sign-out', async () => {
    const state = auth({ accountId: 'acct-first' });
    await renderPage(state);
    await sendMessage(followUp);
    fireEvent.click(sidebar().getByRole('button', { name: 'Account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(state.logout).toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain(followUp);
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
    await userEvent.click(within(present(sidebar().getByText('Drop me').parentElement, 'the conversation item')).getByLabelText('Delete side chat'));
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

  it('shows five Side Chats, then five more per Show more until all show', async () => {
    service.sideChats = Array.from({ length: 7 }, (_, i) => sideChat(`chat${i + 1}`, `Chat ${i + 1}`));
    await renderPage();

    expect(recents()).toEqual(['Chat 1', 'Chat 2', 'Chat 3', 'Chat 4', 'Chat 5']);
    await userEvent.click(sidebar().getByRole('button', { name: 'Show more' }));

    expect(recents()).toEqual(service.sideChats.map(({ title }) => title));
    expect(sidebar().queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('moves focus to the first newly shown Side Chat after Show more', async () => {
    service.sideChats = Array.from({ length: 7 }, (_, i) => sideChat(`chat${i + 1}`, `Chat ${i + 1}`));
    await renderPage();

    await userEvent.click(sidebar().getByRole('button', { name: 'Show more' }));

    expect(sidebar().getByRole('button', { name: 'Chat 6' })).toHaveFocus();
  });

  it('offers no Show more with five Side Chats or fewer', async () => {
    service.sideChats = Array.from({ length: 5 }, (_, i) => sideChat(`chat${i + 1}`, `Chat ${i + 1}`));
    await renderPage();

    expect(recents()).toHaveLength(5);
    expect(sidebar().queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('reveals five more and focuses the first new Side Chat after a refresh moves the open chat past five', async () => {
    service.sideChats = Array.from({ length: 10 }, (_, i) => sideChat(`chat${i + 1}`, `Chat ${i + 1}`));
    await renderPage();
    await userEvent.click(sidebar().getByText('Chat 5'));

    service.sideChats = [
      ...Array.from({ length: 7 }, (_, i) => sideChat(`new${i + 1}`, `New ${i + 1}`)),
      ...service.sideChats,
    ];
    await userComesBack();
    expect(recents()).toHaveLength(12);

    await userEvent.click(sidebar().getByRole('button', { name: 'Show more' }));

    expect(recents()).toHaveLength(17);
    expect(sidebar().getByRole('button', { name: 'Chat 10' })).toBeInTheDocument();
    expect(sidebar().getByRole('button', { name: 'Chat 6' })).toHaveFocus();
    expect(sidebar().queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('still shows the open Side Chat once a refresh puts it past the first five', async () => {
    service.sideChats = Array.from({ length: 5 }, (_, i) => sideChat(`chat${i + 1}`, `Chat ${i + 1}`));
    await renderPage();
    await userEvent.click(sidebar().getByText('Chat 5'));

    service.sideChats = [sideChat('new1', 'New 1'), sideChat('new2', 'New 2'), ...service.sideChats];
    await userComesBack();

    expect(recents()).toEqual(service.sideChats.map(({ title }) => title));
    expect(document.querySelector('.sidebar-item-active')).toHaveTextContent('Chat 5');
    expect(sidebar().queryByRole('button', { name: 'Show more' })).toBeNull();
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

  it('does not restore a static welcome while the opening Turn has no messages', async () => {
    await renderPage();

    await act(async () => {
      agent().setMessages([]);
    });

    expect(welcome()).toBeNull();
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
    await userEvent.click(sidebar().getByText('First question'));
    await settle();
    await openSidebar();
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

    expect(agent().messages).toEqual([]);
  });

  it('starts a new Side Chat', async () => {
    await renderPage();
    await sendMessage('first question');
    await agentAddsMessage({ id: 'u1', role: 'user', content: 'first question' });

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));

    expect(welcome()).toBeNull();
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
      within(present(sidebar().getByText('Stuck').parentElement, 'the conversation item')).getByLabelText('Delete side chat'),
    );

    await userEvent.click(
      within(present(sidebar().getByText('Fine').parentElement, 'the conversation item')).getByLabelText('Delete side chat'),
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
      within(present(sidebar().getByText('Drop me').parentElement, 'the conversation item')).getByLabelText('Delete side chat'),
    );

    expect(recents()).toEqual(['Keep me']);
    expect(requests()).toContain('DELETE /threads/drop');
    expect(copilot.chat?.threadId).toBe('keep');
  });

  it('starts a new conversation after deleting the current one', async () => {
    service.sideChats = [sideChat('current', 'Current one')];
    await renderPage();
    await userEvent.click(sidebar().getByText('Current one'));

    await userEvent.click(sidebar().getByLabelText('Delete side chat'));

    expect(recents()).toEqual([]);
    expect(copilot.chat?.threadId).toBe('new-1');
    expect(welcome()).toBeNull();
  });

  describe('renaming', () => {
    const row = (title: string) => within(present(sidebar().getByText(title).closest<HTMLElement>('.sidebar-item'), `the ${title} row`));
    const nameField = () => sidebar().getByRole<HTMLInputElement>('textbox', { name: 'Side chat name' });
    const renames = () => fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'PATCH')
      .map(([url, init]) => [url.replace('http://chat.test', ''), init?.body]);

    beforeEach(() => {
      service.sideChats = [sideChat('rates', 'Rates question'), sideChat('other', 'Other question')];
    });

    it('renames a Side Chat from its row, keeping the name through switching and a reload', async () => {
      const view = await renderPage();
      await openSidebar();

      await userEvent.click(row('Rates question').getByRole('button', { name: 'Rename side chat' }));
      expect(nameField()).toHaveValue('Rates question');
      expect(nameField()).toHaveFocus();
      await userEvent.clear(nameField());
      await userEvent.type(nameField(), 'Rates desk{Enter}');

      expect(recents()).toEqual(['Rates desk', 'Other question']);
      expect(sidebar().queryByRole('textbox')).toBeNull();
      expect(renames()).toEqual([['/threads/rates', JSON.stringify({ title: 'Rates desk' })]]);
      await userEvent.click(sidebar().getByText('Other question'));
      await userEvent.click(sidebar().getByText('Rates desk'));
      expect(copilot.chat?.threadId).toBe('rates');
      expect(recents()).toEqual(['Rates desk', 'Other question']);
      view.unmount();
      await renderPage();
      expect(recents()).toEqual(['Rates desk', 'Other question']);
    });

    it('cancels on Escape, and saves nothing for an unchanged or blank name', async () => {
      await renderPage();
      await openSidebar();

      await userEvent.click(row('Rates question').getByRole('button', { name: 'Rename side chat' }));
      await userEvent.type(nameField(), ' edited{Escape}');
      await userEvent.click(row('Rates question').getByRole('button', { name: 'Rename side chat' }));
      await userEvent.type(nameField(), '{Enter}');
      await userEvent.click(row('Rates question').getByRole('button', { name: 'Rename side chat' }));
      await userEvent.clear(nameField());
      await userEvent.type(nameField(), '   {Enter}');

      expect(recents()).toEqual(['Rates question', 'Other question']);
      expect(renames()).toEqual([]);
    });

    it('saves the name as typed when the field loses focus', async () => {
      await renderPage();
      await openSidebar();

      await userEvent.click(row('Rates question').getByRole('button', { name: 'Rename side chat' }));
      await userEvent.clear(nameField());
      await userEvent.type(nameField(), ' Rates desk ');
      await userEvent.click(sidebar().getByText('Other question'));

      expect(recents()).toEqual([' Rates desk ', 'Other question']);
      expect(renames()).toEqual([['/threads/rates', JSON.stringify({ title: ' Rates desk ' })]]);
    });

    it('shows a failed rename and keeps the saved name', async () => {
      service.failing.set('PATCH /threads/rates', 503);
      await renderPage();
      await openSidebar();

      await userEvent.click(row('Rates question').getByRole('button', { name: 'Rename side chat' }));
      await userEvent.clear(nameField());
      await userEvent.type(nameField(), 'Rates desk{Enter}');

      expect(sidebar().getByRole('alert')).toHaveTextContent('Rates question could not be renamed: Failed to rename thread: 503');
      expect(recents()).toEqual(['Rates question', 'Other question']);
    });
  });

  it('shows a delete failure and keeps the Side Chat', async () => {
    service.sideChats = [sideChat('stuck', 'Stuck')];
    service.failing.set('DELETE /threads/stuck', 409);
    await renderPage();
    await openSidebar();

    await userEvent.click(sidebar().getByLabelText('Delete side chat'));

    expect(sidebar().getByRole('alert')).toHaveTextContent('Stuck could not be deleted: Failed to delete thread: 409');
    expect(recents()).toEqual(['Stuck']);
  });

  it('shows why the Side Chats could not load, rather than an empty list', async () => {
    service.failing.set('GET /threads', 503);

    await renderPage();
    await openSidebar();

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

  it('names a new Side Chat when its opening Turn starts', async () => {
    await renderPage();

    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    expect(window.location.search).toBe('?chat=new-1');
    expect(agent().messages).toEqual([]);

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
  it('retries a failed Main Chat load from its active browser copy when Main Chat is chosen', async () => {
    localStorage.setItem('botcube.main-chat', JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: [{ id: 'saved-question', role: 'user', content: 'Saved question' }] }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    service.failing.set('GET /main-chat', 503);
    await renderPage(auth({ accountId: 'acct-first' }));
    expect(sidebar().getByRole('button', { name: 'Main Chat' })).toHaveClass('sidebar-nav-item-active');
    expect(screen.getByText('Your Main Chat could not be opened.')).toBeInTheDocument();

    service.failing.delete('GET /main-chat');
    await openSidebar();
    await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
    await settle();

    expect(copilot.chat?.threadId).toBe('main-1');
    expect(screen.queryByText('Your Main Chat could not be opened.')).toBeNull();
  });

  it('keeps the active Main Chat Turn streaming when the sidebar opens and Main Chat is chosen', async () => {
    await renderPage();
    const current = agent();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test' && init?.method === 'POST'
        ? new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: current.threadId, runId: 'open-run' })}\n\n`));
            },
          }), { headers: { 'content-type': 'text/event-stream' } })
        : chatService(url, init),
    );
    let turn: Promise<unknown> | undefined;
    await act(async () => {
      current.addMessage({ id: 'open-question', role: 'user', content: 'Keep answering while I open the sidebar' });
      turn = current.runAgent({ runId: 'open-run' });
    });
    await settle();
    try {
      expect(current.isRunning).toBe(true);
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
      await openSidebar();
      await settle();
      expect(document.querySelector('aside')).toHaveClass('sidebar-expanded');
      expect(agent()).toBe(current);
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();

      await userEvent.click(sidebar().getByRole('button', { name: 'Main Chat' }));
      await settle();
      expect(document.querySelector('aside')).toHaveClass('sidebar-expanded');
      expect(agent()).toBe(current);
      expect(agent().messages).toContainEqual({ id: 'open-question', role: 'user', content: 'Keep answering while I open the sidebar' });
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
    } finally {
      await act(async () => {
        present(stream, 'the active Turn stream').close();
        await turn;
      });
    }
  });

  // Docked beside the chat, the desktop sidebar opens and shuts only from its menu button.
  it('opens and shuts the desktop sidebar only from its menu button', async () => {
    await renderPage(auth({ user: { name: 'Ada Lovelace' } }));
    const aside = present(document.querySelector('aside'), 'the sidebar');
    const menu = sidebar().getByRole('button', { name: 'Toggle sidebar' });
    expect(aside).toHaveClass('sidebar', 'sidebar-collapsed');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.user-menu .sidebar-nav-label')).toBeNull();

    menu.focus();
    await userEvent.keyboard('{Enter}');
    expect(aside).toHaveClass('sidebar', 'sidebar-expanded');
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('.user-menu .sidebar-nav-label')).toHaveTextContent(/^Ada$/);

    await userEvent.click(sidebar().getByRole('button', { name: 'Account' }));
    expect(aside).toHaveClass('sidebar-expanded');
    await userEvent.click(screen.getByRole('textbox'));
    expect(screen.getByRole('textbox')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(aside).toHaveClass('sidebar-expanded');

    menu.focus();
    await userEvent.keyboard(' ');
    expect(aside).toHaveClass('sidebar-collapsed');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(menu);
    expect(aside).toHaveClass('sidebar-expanded');
  });

  it('remembers whether the desktop sidebar was left open', async () => {
    localStorage.setItem('botcube.sidebar-expanded', 'true');
    await renderPage();
    expect(document.querySelector('aside')).toHaveClass('sidebar-expanded');

    const menu = sidebar().getByRole('button', { name: 'Toggle sidebar' });
    await userEvent.click(menu);
    expect(document.querySelector('aside')).toHaveClass('sidebar-collapsed');
    expect(localStorage.getItem('botcube.sidebar-expanded')).toBe('false');
    await userEvent.click(menu);
    expect(localStorage.getItem('botcube.sidebar-expanded')).toBe('true');
  });

  it('stays open when Plugins is chosen, and over a click on the Plugins stage', async () => {
    await renderPage();
    await openSidebar();
    await userEvent.click(sidebar().getByRole('button', { name: 'Plugins' }));
    expect(screen.getByRole('heading', { name: 'Plugins' })).toBeVisible();
    expect(document.querySelector('aside')).toHaveClass('sidebar-expanded');
    await userEvent.click(screen.getByRole('heading', { name: 'Plugins' }));
    expect(document.querySelector('aside')).toHaveClass('sidebar-expanded');
  });

  it('stays open over the failed Main Chat stage while its Retry restores the chat', async () => {
    service.failing.set('GET /main-chat', 503);
    await renderPage();
    await openSidebar();
    service.failing.delete('GET /main-chat');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(document.querySelector('aside')).toHaveClass('sidebar-expanded');
    expect(screen.getByRole('textbox')).toBeVisible();
    expect(copilot.chat?.threadId).toBe('main-1');
  });

  it('names the account menu after the cartridge account when there is no user', async () => {
    await renderPage(auth({ status: 'unauthed' }));
    await openSidebar();

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
    await openSidebar();

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
    await openSidebar();

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

// A phone's chat scrolls the page, so iOS Safari draws it under its status bar (#3613): as CopilotKit's own view does on
// its box, the page opens at the latest message, keeps to the bottom as the chat grows until the user scrolls up, and
// shows the jump to the bottom while away from it.
describe('phone chat scrolling the page', () => {
  const happyDOM = () => (window as unknown as HappyDomWindow).happyDOM;
  const page = () => present(document.scrollingElement, 'the page scroller');
  const jumpButton = () => screen.queryByTestId('copilot-scroll-to-bottom');
  let height = 2000;
  // Like a ResizeObserver: the chat reports each time it grows.
  const resized: ResizeObserverCallback[] = [];
  const observed = new Map<Element, ResizeObserverCallback[]>();
  const grow = (to: number) => act(async () => {
    height = to;
    for (const callback of [...resized]) callback([], {} as ResizeObserver);
  });
  const scrollTo = (top: number) => act(async () => {
    page().scrollTop = top;
    window.dispatchEvent(new Event('scroll'));
  });

  beforeEach(() => {
    happyDOM().setViewport({ width: 440, height: 956 });
    height = 2000;
    resized.length = 0;
    observed.clear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          resized.push(this.callback);
          observed.set(target, [...(observed.get(target) ?? []), this.callback]);
        }
        disconnect() {}
      },
    );
    Object.defineProperty(page(), 'clientHeight', { configurable: true, value: 796 });
    Object.defineProperty(page(), 'scrollHeight', { configurable: true, get: () => height });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    page().scrollTop = 0;
    Reflect.deleteProperty(page(), 'clientHeight');
    Reflect.deleteProperty(page(), 'scrollHeight');
    happyDOM().setViewport({ width: 1024, height: 768 });
  });

  it('opens at the bottom of the page and follows the chat as it grows, until the user scrolls up', async () => {
    await renderPage();
    expect(screen.queryByTestId('copilot-scroll-view')).toBeNull();
    expect(page().scrollTop).toBe(1204);
    expect(jumpButton()).toBeNull();

    await grow(2400);
    expect(page().scrollTop).toBe(1604);

    fireEvent.wheel(window, { deltaY: -100 });
    await scrollTo(1000);
    expect(jumpButton()).not.toBeNull();
    await grow(2600);
    expect(page().scrollTop).toBe(1000);

    await scrollTo(1804);
    expect(jumpButton()).toBeNull();
    await grow(2800);
    expect(page().scrollTop).toBe(2004);
  });

  it('restores the bottom after a 103px scroll up without input while the page height is unchanged', async () => {
    await renderPage();
    expect(page().scrollTop).toBe(1204);

    await scrollTo(1101);
    expect(page().scrollTop).toBe(1204);
    expect(jumpButton()).toBeNull();

    await grow(2400);
    expect(page().scrollTop).toBe(1604);
    expect(jumpButton()).toBeNull();
  });

  it.each(['wheel', 'touchmove', 'keydown'])('stops following an upward %s scroll while the page height is unchanged', async (input) => {
    await renderPage();
    expect(page().scrollTop).toBe(1204);

    if (input === 'wheel') fireEvent.wheel(window, { deltaY: -103 });
    else if (input === 'touchmove') fireEvent.touchMove(window, { touches: [{ clientY: 340 }] });
    else fireEvent.keyDown(window, { key: 'ArrowUp' });
    await scrollTo(1101);
    expect(page().scrollTop).toBe(1101);
    expect(jumpButton()).not.toBeNull();

    await grow(2400);
    expect(page().scrollTop).toBe(1101);
    expect(jumpButton()).not.toBeNull();
  });

  // WebKit clamped the page up as the opening chat's content shifted, and reported that scroll only once the chat had
  // grown again, before the chat's own resize: the chat took it for the user's and opened 133px short of its end.
  it('keeps to the bottom through a scroll up the page makes itself as the chat grows, not one the user makes', async () => {
    await renderPage();
    expect(page().scrollTop).toBe(1204);

    height = 2130;
    await scrollTo(1137);
    expect(page().scrollTop).toBe(1334);
    expect(jumpButton()).toBeNull();
    await grow(2200);
    expect(page().scrollTop).toBe(1404);

    // The user's wheel over the chat as it grows, or a key on the page, lets it go.
    height = 2300;
    fireEvent.wheel(screen.getByTestId('copilot-scroll-content'), { deltaY: -100 });
    await scrollTo(1000);
    expect(page().scrollTop).toBe(1000);
    expect(jumpButton()).not.toBeNull();

    await scrollTo(1504);
    expect(jumpButton()).toBeNull();
    height = 2400;
    fireEvent.keyDown(document.body, { key: 'PageUp' });
    await scrollTo(1300);
    expect(page().scrollTop).toBe(1300);
    expect(jumpButton()).not.toBeNull();
  });

  // Typing in the composer, scrolling a long draft in it and swiping the Agent Profile scroll no chat, but each latched
  // as the user's scroll intent until the next scroll: then a scroll up the page made itself as the chat grew unpinned
  // the chat.
  it.each([
    ['typing in the composer', async () => {
      fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'a' });
    }],
    ['wheeling a draft in the composer', async () => {
      fireEvent.wheel(screen.getByLabelText('Message'), { deltaY: -100 });
    }],
    ['dragging a draft in the composer', async () => {
      fireEvent.touchMove(screen.getByLabelText('Message'), { touches: [{ clientX: 200, clientY: 900 }] });
    }],
    ['swiping the Agent Profile', async () => {
      await userEvent.click(screen.getByLabelText('Agent profile', { selector: 'button' }));
      fireEvent.touchMove(screen.getByRole('dialog', { name: 'Agent profile' }), { touches: [{ clientX: 200, clientY: 340 }] });
      await userEvent.click(screen.getByLabelText('Close agent profile'));
    }],
  ])('keeps to the bottom through a scroll up the page makes itself after %s', async (_, interact) => {
    await renderPage();
    expect(page().scrollTop).toBe(1204);

    await interact();
    height = 2130;
    await scrollTo(1137);
    expect(page().scrollTop).toBe(1334);
    expect(jumpButton()).toBeNull();
  });

  // Android Chrome's keyboard shrinks only the visual viewport, and CopilotKit lifts the composer above it: the page
  // makes the keyboard's room below the chat, so its latest message clears the lifted composer.
  it("makes the keyboard's room below the chat while the composer is lifted above it", async () => {
    const viewport = Object.assign(new EventTarget(), { height: 956, offsetTop: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    onTestFinished(() => {
      Reflect.deleteProperty(window, 'visualViewport');
    });
    // The page's content includes the room the chat makes for the keyboard.
    Object.defineProperty(page(), 'scrollHeight', {
      configurable: true,
      get: () => height + parseFloat(document.querySelector<HTMLElement>('.chat-keyboard-room')?.style.height || '0'),
    });
    await renderPage();
    expect(page().scrollTop).toBe(1204);

    await act(async () => {
      viewport.height = 656;
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(page().scrollTop).toBe(1504);

    await act(async () => {
      viewport.height = 956;
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(page().scrollTop).toBe(1204);
  });

  // CopilotKit pads the chat by the composer's height once it measures it, after the chat opens: the chat kept to the
  // bottom only at its own resize, later, and in between the page sat 146px short of its end.
  it("keeps to the bottom as the composer's space arrives, in the same update", async () => {
    await renderPage();
    expect(page().scrollTop).toBe(1204);

    const overlay = screen.getByTestId('copilot-input-overlay');
    await act(async () => {
      height = 2146;
      const entry = { target: overlay, contentRect: { height: 146 } } as unknown as ResizeObserverEntry;
      for (const callback of observed.get(overlay) ?? []) callback([entry], {} as ResizeObserver);
    });
    expect(screen.getByTestId('copilot-scroll-content').style.paddingBottom).toBe('178px');
    expect(page().scrollTop).toBe(1350);
  });

  // The chat stays mounted under Plugins, which scrolls the same page: Plugins's shorter page clamped the page to
  // its end, which the hidden chat took for its own bottom and jumped back to on return.
  it("keeps the user's place in the chat while Plugins covers it", async () => {
    await renderPage();
    fireEvent.wheel(window, { deltaY: -100 });
    await scrollTo(1000);
    expect(jumpButton()).not.toBeNull();

    await userEvent.click(screen.getByLabelText('Toggle sidebar'));
    await userEvent.click(within(present(document.querySelector('aside'), 'the sidebar')).getByRole('button', { name: 'Plugins' }));
    height = 900;
    await scrollTo(104);

    await userEvent.click(screen.getByLabelText('Toggle sidebar'));
    await userEvent.click(within(present(document.querySelector('aside'), 'the sidebar')).getByRole('button', { name: 'Main Chat' }));
    height = 2000;
    await grow(2000);
    expect(page().scrollTop).toBe(1000);
    expect(jumpButton()).not.toBeNull();
  });

  it("jumps to the page's bottom and follows the chat from there", async () => {
    await renderPage();
    fireEvent.wheel(window, { deltaY: -100 });
    await scrollTo(1000);
    // The jump holds the bottom until frames pass without movement; here none pass.
    vi.stubGlobal('requestAnimationFrame', () => 0);
    fireEvent.click(present(jumpButton(), 'the jump to the bottom'));
    expect(page().scrollTop).toBe(1204);

    // Momentum that scrolls the page up as it jumps does not stop it.
    await scrollTo(1100);
    expect(page().scrollTop).toBe(1204);
    await grow(2400);
    expect(page().scrollTop).toBe(1604);
  });

  it('backs the page below the composer, and closes the keyboard as the chat is dragged up', async () => {
    await renderPage();
    expect(present(document.querySelector<HTMLElement>('.chat-composer-backing'), 'the backing').style.top).toBe('0px');

    const composer = screen.getByLabelText('Message');
    composer.focus();
    const chat = screen.getByTestId('copilot-scroll-content');
    fireEvent.touchStart(chat, { touches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(chat, { touches: [{ clientX: 200, clientY: 340 }] });
    expect(document.activeElement).not.toBe(composer);
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

  // Main hid the chat under the open phone profile, out of focus and the accessibility tree. Slid in over it (#3694), the
  // profile leaves it on screen beneath, inert. Beside the desktop profile, the chat stays in use.
  it.each([
    ['a phone', { width: 390, height: 844 }, true],
    ['a desktop', { width: 1024, height: 768 }, false],
  ])("leaves the chat under the open profile on %s inert as it was hidden (#3694)", async (_, viewport, covered) => {
    const { happyDOM } = window as unknown as HappyDomWindow;
    happyDOM.setViewport(viewport);
    onTestFinished(() => {
      happyDOM.setViewport({ width: 1024, height: 768 });
    });
    await renderPage();
    const chat = present(document.querySelector('.app-shell:not([hidden])'), 'the chat');
    // The collapsed sidebar behind the phone profile, whose menu button a Tab out of the profile reached.
    const sidebar = present(document.querySelector('aside.sidebar'), 'the sidebar');
    expect(chat).not.toHaveAttribute('inert');
    expect(sidebar).not.toHaveAttribute('inert');

    await userEvent.click(avatar());
    expect(openProfile()).toBeInTheDocument();
    expect(chat.hasAttribute('inert')).toBe(covered);
    expect(sidebar.hasAttribute('inert')).toBe(covered);

    await userEvent.click(screen.getByLabelText('Close agent profile'));
    expect(chat).not.toHaveAttribute('inert');
    expect(sidebar).not.toHaveAttribute('inert');
  });

  // Inert under the open phone profile, the chat let go of the opener's focus to the page: a keyboard's next Tab, not
  // the open, reached the profile, and closing it left focus nowhere (#3694).
  describe('keyboard focus on a phone', () => {
    beforeEach(() => {
      const { happyDOM } = window as unknown as HappyDomWindow;
      happyDOM.setViewport({ width: 390, height: 844 });
      onTestFinished(() => {
        happyDOM.setViewport({ width: 1024, height: 768 });
      });
    });
    const close = () => screen.getByLabelText('Close agent profile');

    it.each([
      ['its Close', async () => { await userEvent.click(close()); }],
      ['Escape', async () => { await userEvent.keyboard('{Escape}'); }],
    ])('moves into the open profile, and back to the avatar once %s closes it', async (_, shut) => {
      await renderPage();
      avatar().focus();
      await userEvent.keyboard('{Enter}');
      expect(openProfile()).toBeInTheDocument();
      expect(close()).toHaveFocus();

      await shut();
      expect(profile()).toBeNull();
      expect(avatar()).toHaveFocus();
    });

    // A fresh page's first open portaled the profile in some 330ms after it opened, as the chat rendered it, once the
    // open's focus had found no profile: focus stayed on the page. happy-dom mounts it at once, so here it mounts a tick
    // late.
    it('moves into a profile that mounts after it opens', async () => {
      (await renderPage()).unmount();
      vi.resetModules();
      vi.doMock('./agent-profile', async (importOriginal) => {
        const actual = await importOriginal<typeof import('./agent-profile')>();
        function LateAgentProfile(props: Parameters<typeof actual.AgentProfile>[0]) {
          const [mounted, setMounted] = useState(false);
          useEffect(() => {
            const timer = setTimeout(() => setMounted(true), 20);
            return () => clearTimeout(timer);
          }, []);
          return mounted ? createElement(actual.AgentProfile, props) : null;
        }
        return { ...actual, AgentProfile: LateAgentProfile };
      });
      try {
        const { default: FreshPage } = await import('./page');
        cartridge.auth = auth();
        render(<FreshPage />);
        await settle();
        avatar().focus();
        await userEvent.keyboard('{Enter}');
        await waitFor(() => expect(openProfile()).toBeInTheDocument());
        await waitFor(() => expect(close()).toHaveFocus());

        await userEvent.keyboard('{Escape}');
        expect(profile()).toBeNull();
        expect(avatar()).toHaveFocus();
      } finally {
        vi.doUnmock('./agent-profile');
      }
    });

    it('returns focus from anywhere in the profile, and lets go of a profile open as the page unmounts', async () => {
      const page = await renderPage();
      await userEvent.click(avatar());
      expect(close()).toHaveFocus();
      within(openProfile()).getByRole('tab', { name: 'Activity' }).focus();
      await userEvent.keyboard('{Escape}');
      expect(avatar()).toHaveFocus();

      await userEvent.click(avatar());
      expect(close()).toHaveFocus();
      page.unmount();
      expect(document.activeElement).toBe(document.body);
    });
  });

  it("keeps the desktop profile beside the chat out of the keyboard's way", async () => {
    await renderPage();
    avatar().focus();
    await userEvent.keyboard('{Enter}');
    expect(openProfile()).toBeInTheDocument();
    expect(avatar()).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(openProfile()).toBeInTheDocument();
  });

  it("opens from the agent's avatar and name in the chat's header", async () => {
    await renderPage();
    expect(avatar()).toHaveTextContent(/^Ada Bot$/);
    expect(avatar().querySelector('.avatar-agent .avatar-monocle')).not.toBeNull();
    // At rest, no laptop.
    expect(avatar()).not.toHaveAttribute('data-working');
    expect(avatar().querySelector('.avatar-laptop')).toBeNull();
    expect(avatar().closest('main > header')).not.toBeNull();
    // A tooltip names what the avatar opens.
    expect(avatar()).toHaveAttribute('title', 'Agent profile');
    expect(profile()).toBeNull();

    await userEvent.click(avatar());

    expect(openProfile().querySelector('.agent-profile-name')).toHaveTextContent(/^Ada Bot$/);
    expect(openProfile().querySelector('.agent-profile-status')).toHaveTextContent(/^Connected$/);
    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent', { credentials: 'include', cache: 'no-store' });
  });

  it('opens from a press on the loading chat that is released once the chat has loaded', async () => {
    // This file's page loads its chat controls first, so the other tests keep them whatever runs after this one.
    (await renderPage()).unmount();
    // A fresh page, whose chat controls load only when the test lets them.
    const controls = Promise.withResolvers<void>();
    vi.resetModules();
    vi.doMock('./chat-surface', async (importOriginal) => {
      await controls.promise;
      return importOriginal();
    });
    try {
      const { default: LoadingPage } = await import('./page');
      cartridge.auth = auth();
      render(<LoadingPage />);
      await settle();
      const loading = () => screen.queryByRole('status', { name: 'Loading chat controls' });
      expect(loading()).not.toBeNull();
      const user = userEvent.setup();

      await user.pointer({ keys: '[MouseLeft>]', target: avatar() });
      controls.resolve();
      await waitFor(() => expect(loading()).toBeNull());
      await user.pointer({ keys: '[/MouseLeft]', target: avatar() });

      expect(openProfile().querySelector('.agent-profile-name')).toHaveTextContent(/^Ada Bot$/);
    } finally {
      vi.doUnmock('./chat-surface');
    }
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
    ended: false,
    sideChat: false,
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
  /** Opens More, unless it is: the Edit form's or the sheet's, over Starts, Ends and the model. */
  const more = async (inSheet: ReturnType<typeof within>) => {
    const button = inSheet.getByRole('button', { name: 'More' });
    if (button.getAttribute('aria-expanded') !== 'true') await userEvent.click(button);
  };
  /** The sheet's details it shows, each term with what it reads. */
  const shown = (sheet: HTMLElement) => [...sheet.querySelectorAll('dl > div')].map((row) => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]);
  /** The sheet's details, More open. */
  const details = async (sheet: HTMLElement) => {
    await more(within(sheet));
    return shown(sheet);
  };
  const detail = async (sheet: HTMLElement, term: string) => {
    await more(within(sheet));
    return within(sheet).getByText(term, { selector: 'dt' }).nextElementSibling?.textContent;
  };
  /** The Edit form's line saying why Save can't yet. */
  const why = (sheet: HTMLElement) => within(sheet).getByRole('status').textContent;
  /** Types a count into Interval's Every. */
  const every = async (inSheet: ReturnType<typeof within>, count: string) => {
    await userEvent.clear(inSheet.getByLabelText('Every'));
    await userEvent.type(inSheet.getByLabelText('Every'), count);
  };
  /** "Three updates only" (#3960): every minute from 3:02 PM New York on 6 October, for 3 runs. */
  const COUNTED = {
    ...MORNING_BRIEF,
    title: 'US rates analysis: three minute-by-minute updates',
    schedule: 'rate(1 minute)',
    startDate: '2026-10-06T19:02:00.000Z',
    nextRun: '2026-10-06T19:02:00.000Z',
    maxRuns: 3,
    runsMade: 0,
  };
  /** 1:00 AM New York on 6 October, before the counted task's first run. */
  const beforeCountedRuns = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-10-06T05:00:00Z');
  };

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
      ['Weekly on Saturday', ['12:05 PM · Brief me on rates']],
      // rate(1 day) runs every 24 hours, not at a time of day: a clock change moves it (#4021).
      ['Every 24 hours', ['Brief me on rates']],
      ['Weekly on Monday', ['2:30 PM · Brief me on rates']],
      ['Every 2 hours', ['Brief me on rates']],
      ['Once', ['Oct 14, 8:30 AM · Brief me on rates']],
    ]);
  });

  // A task past its stop time no longer runs, and says so; Resume waits until the stop time moves.
  it('marks a task past its stop time Ended, in its row and its sheet, with no Pause or Resume', async () => {
    service.scheduled = [
      { ...MORNING_BRIEF, endDate: '2020-01-01T05:00:00.000Z', paused: true, ended: true },
      { ...MORNING_BRIEF, id: 'task-2', title: 'Later brief', endDate: '2099-12-31T22:00:00.000Z' },
    ];
    await renderPage();
    await userEvent.click(avatar());
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Scheduled' }));
    const [ended, later] = await within(openProfile()).findAllByRole('listitem');

    expect(within(present(ended, 'the ended task')).getByText('Ended')).toHaveClass('status-pill');
    expect(within(present(ended, 'the ended task')).queryByText('Paused')).toBeNull();
    expect(within(present(later, 'the later task')).queryByText('Ended')).toBeNull();
    const sheet = await openTask(present(ended, 'the ended task'));
    // Its Next run, out of More, reads Ended, over Paused, and nothing else says so again.
    expect(within(sheet).getByText('Ended', { selector: 'dd' })).toBeInTheDocument();
    expect(within(sheet).getAllByText(/Ended/)).toHaveLength(1);
    expect(within(sheet).queryByText('Paused')).toBeNull();
    expect(within(sheet).queryByRole('button', { name: /^(Pause|Resume)$/ })).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Edit' })).toBeEnabled();
    await closeTask(sheet);

    const open = await openTask(present(later, 'the later task'));
    expect(await detail(open, 'Ends')).toBe('Thu, Dec 31, 5:00 PM ET');
    expect(within(open).getByRole('button', { name: 'Pause' })).toBeEnabled();
  });

  it('marks a paused one-off task whose time passed Ended, until Edit moves its date', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'at(2020-01-02T08:30:00)', paused: true, ended: true }];
    await renderPage();
    const task = await openScheduled();

    expect(within(task).getByText('Ended')).toHaveClass('status-pill');
    const sheet = await openTask(task);
    expect(within(sheet).queryByRole('button', { name: /^(Pause|Resume)$/ })).toBeNull();
  });

  // The Chat Service knows when a task has no run left before its stop time; the page takes its word.
  it('marks a task Ended when the Chat Service says it has no run left, though its stop time is ahead', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'cron(0 8 1 1 ? 2025)', endDate: '2099-12-31T22:00:00.000Z', ended: true }];
    await renderPage();
    const task = await openScheduled();

    expect(within(task).getByText('Ended')).toHaveClass('status-pill');
    const sheet = await openTask(task);
    expect(within(sheet).getByText('Ended', { selector: 'dd' })).toBeInTheDocument();
    // Its stop time reads as a time; Next run alone says Ended.
    expect(await detail(sheet, 'Ends')).toBe('Thu, Dec 31, 5:00 PM ET');
    expect(within(sheet).getAllByText(/Ended/)).toHaveLength(1);
    expect(within(sheet).queryByRole('button', { name: /^(Pause|Resume)$/ })).toBeNull();
  });

  // Its last run is unknown on a schedule the controls can't show.
  it('says in its sheet how many runs a task makes before it stops (#3950)', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'cron(0 8 1 * ? *)', maxRuns: 1 }];
    await renderPage();
    const sheet = await openTask(await openScheduled());

    expect(await detail(sheet, 'Ends')).toBe('After 1 run');
  });

  // The maintainer: "dont want to see "N", and 3 rounds or 3min? and start and end time why not set?"; and then
  // preferred start and end times to a count of runs.
  it('shows a counted every-minute task as Repeat, Starts and Ends at its last run, with no N anywhere (#3960)', async () => {
    beforeCountedRuns();
    service.scheduled = [COUNTED];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);

    // It hasn't run yet, so its next run is its first; Next run stays out of More, which holds Edit's rows (#4041).
    expect(shown(sheet)).toEqual([
      ['Repeat', 'Interval'],
      ['Every', '1 minute'],
      ['Next run', 'Tue, Oct 6, 3:02 PM ET'],
    ]);
    expect(await details(sheet)).toEqual([
      ['Repeat', 'Interval'],
      ['Every', '1 minute'],
      ['Next run', 'Tue, Oct 6, 3:02 PM ET'],
      ['Starts', 'Tue, Oct 6, 3:02 PM ET'],
      ['Ends', 'Tue, Oct 6, 3:04 PM ET'],
      ['Model', 'Deep'],
    ]);
    expect(sheet).not.toHaveTextContent(/\bN\b/);

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));

    // Every minute is an Interval of 1 minute, the count bare, with no box (#4041).
    expect(inSheet.getByLabelText('Repeat')).toHaveDisplayValue('Interval');
    expect(inSheet.getByLabelText('Every')).toHaveValue('1');
    expect(inSheet.getByText('minute')).toBeInTheDocument();
    await more(inSheet);
    // The sheet is named for what it does while the Title field shows the title.
    expect(sheet).toHaveAccessibleName('Edit task');
    // No line under the rows while Save can.
    expect(inSheet.queryByRole('status')).toBeNull();
    // Starts is its date and time, in words as Ends reads.
    expect(inSheet.getByLabelText('Starts')).toHaveValue('2026-10-06T15:02');
    expect(inSheet.getByText('Tue, Oct 6, 3:02 PM ET')).toBeInTheDocument();
    // One Ends row, Never or a date and time: a counted task's is its last run.
    expect(within(inSheet.getByLabelText('Ends')).getAllByRole('option').map((option) => option.textContent)).toEqual(['Never', 'On a date…']);
    expect(inSheet.getByLabelText('Ends')).toHaveDisplayValue('Tue, Oct 6, 3:04 PM ET');
    expect(inSheet.getByLabelText('End date')).toHaveValue('2026-10-06T15:04');
    expect(inSheet.queryByLabelText('Runs')).toBeNull();
    expect(inSheet.queryByLabelText('Time zone')).toBeNull();
    expect(sheet).not.toHaveTextContent(/\bN\b/);
    // Cancel, then Save, as Codex's footer.
    expect(within(present(sheet.querySelector<HTMLElement>('.scheduled-edit-actions'), 'the actions')).getAllByRole('button').map((button) => button.textContent)).toEqual(['Cancel', 'Save']);

    // Saved with only its title changed, it keeps its count: a stop time at its last tick may cut that run.
    await userEvent.type(inSheet.getByLabelText('Title'), ' (US)');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([{ title: `${COUNTED.title} (US)`, prompt: 'Brief me on rates' }]);
    expect(sheet).toHaveAccessibleName(`${COUNTED.title} (US)`);
    expect(await detail(sheet, 'Ends')).toBe('Tue, Oct 6, 3:04 PM ET');
  });

  it("counts a paused task's last run on from its start (#3960)", async () => {
    beforeCountedRuns();
    vi.setSystemTime('2026-10-06T19:02:30Z');
    service.scheduled = [{ ...COUNTED, paused: true, runsMade: 1, nextRun: undefined }];
    await renderPage();
    const sheet = await openTask(await openScheduled());

    expect(await detail(sheet, 'Ends')).toBe('Tue, Oct 6, 3:04 PM ET');
  });

  it('counts the last run on from the runs a task has made, from its next run once Starts has passed (#3960)', async () => {
    beforeCountedRuns();
    vi.setSystemTime('2026-10-06T19:02:30Z');
    service.scheduled = [{ ...COUNTED, runsMade: 1, nextRun: '2026-10-06T19:03:00.000Z' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    // Its start has passed, so Next run stands in its place.
    expect(await details(sheet)).toEqual([
      ['Repeat', 'Interval'],
      ['Every', '1 minute'],
      ['Next run', 'Tue, Oct 6, 3:03 PM ET'],
      ['Starts', 'Tue, Oct 6, 3:02 PM ET'],
      ['Ends', 'Tue, Oct 6, 3:04 PM ET'],
      ['Model', 'Deep'],
    ]);

    await userEvent.click(within(sheet).getByRole('button', { name: 'Edit' }));
    await more(within(sheet));

    expect(within(sheet).getByLabelText('End date')).toHaveValue('2026-10-06T15:04');
  });

  it.each([
    ['Starts', '2026-10-07T09:30', '2026-10-07T09:30', { startDate: '2026-10-07T13:30:00.000Z' }],
    ['Every', '5', '2026-10-06T15:07', { schedule: 'rate(5 minutes)', startDate: '2026-10-06T19:02:00.000Z' }],
  ])('keeps only the remaining run when a counted task changes %s', async (label, value, ending, changes) => {
    beforeCountedRuns();
    vi.setSystemTime('2026-10-06T19:03:30Z');
    service.scheduled = [{ ...COUNTED, runsMade: 2, nextRun: '2026-10-06T19:04:00.000Z' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    if (label === 'Every') await every(inSheet, value);
    else fireEvent.change(inSheet.getByLabelText(label), { target: { value } });

    expect(inSheet.getByLabelText('End date')).toHaveValue(ending);
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([{ title: COUNTED.title, prompt: COUNTED.prompt, ...changes }]);
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    expect(inSheet.getByLabelText('End date')).toHaveValue(ending);
  });

  it('moves the first run from Starts, sent as its instant (#3960)', async () => {
    beforeCountedRuns();
    service.scheduled = [COUNTED];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    await userEvent.clear(inSheet.getByLabelText('Starts'));
    expect(inSheet.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(why(sheet)).toBe('Starts needs a date and time');
    await userEvent.type(inSheet.getByLabelText('Starts'), '2026-10-07T09:30');
    expect(inSheet.queryByRole('status')).toBeNull();
    // A counted task's End date follows its start.
    expect(inSheet.getByLabelText('End date')).toHaveValue('2026-10-07T09:32');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));

    // It keeps its count, whose last run follows the new start.
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([
      { title: COUNTED.title, prompt: 'Brief me on rates', startDate: '2026-10-07T13:30:00.000Z' },
    ]);
    expect(await detail(sheet, 'Ends')).toBe('Wed, Oct 7, 9:32 AM ET');
  });

  // A rate counts its ticks from its start, else from its creation: a new schedule starts at the Starts the form showed.
  it('starts a schedule changed to a rate at the Starts the form showed (#3960)', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'cron(0 9 * * ? *)', startDate: '2026-10-13T13:00:00.000Z' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    // A daily task's Starts is its first run, at the time of day it runs.
    expect(inSheet.getByLabelText('Starts')).toHaveValue('2026-10-13T09:00');
    expect(inSheet.getByLabelText('Repeat')).toHaveDisplayValue('Daily');
    await userEvent.selectOptions(inSheet.getByLabelText('Repeat'), 'Interval');
    await every(inSheet, '2');
    expect(inSheet.getByLabelText('Starts')).toHaveValue('2026-10-13T09:00');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));

    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([
      { title: 'Morning brief', prompt: 'Brief me on rates', schedule: 'rate(2 minutes)', startDate: '2026-10-13T13:00:00.000Z' },
    ]);
  });

  it('ends a task never or on a date and time, sending a stop time and no count of runs (#3960)', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, endDate: '2026-10-08T12:01:00.000Z' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);
    const fields = { title: 'Morning brief', prompt: 'Brief me on rates' };

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    await userEvent.selectOptions(inSheet.getByLabelText('Ends'), 'Never');
    expect(inSheet.getByLabelText('Ends')).toHaveDisplayValue('Never');
    expect(inSheet.getByLabelText('End date')).toHaveValue('');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(await detail(sheet, 'Ends')).toBe('Never');

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    // Where the browser can't open its picker when asked (Safari before 16.4), On a date… focuses the picker, which then
    // takes the row's taps.
    await userEvent.selectOptions(inSheet.getByLabelText('Ends'), 'On a date…');
    expect(inSheet.getByLabelText('End date')).toHaveFocus();
    expect(inSheet.getByLabelText('End date').closest('.settings-row')).toHaveClass('settings-ends-direct');
    // Elsewhere On a date… opens the native picker, and the row stays Never until it picks a date.
    const showPicker = vi.fn();
    Object.defineProperty(HTMLInputElement.prototype, 'showPicker', { configurable: true, value: showPicker });
    await userEvent.selectOptions(inSheet.getByLabelText('Ends'), 'On a date…');
    Reflect.deleteProperty(HTMLInputElement.prototype, 'showPicker');
    expect(showPicker.mock.contexts).toEqual([inSheet.getByLabelText('End date')]);
    expect(inSheet.getByLabelText('Ends')).toHaveDisplayValue('Never');
    await userEvent.type(inSheet.getByLabelText('End date'), '2099-06-30T18:00');
    expect(inSheet.getByLabelText('Ends')).toHaveDisplayValue('Tue, Jun 30, 6:00 PM ET');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(await detail(sheet, 'Ends')).toBe('Tue, Jun 30, 6:00 PM ET');

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    // Never, then the same date again, is the ending Edit opened with: Save leaves it alone.
    await userEvent.selectOptions(inSheet.getByLabelText('Ends'), 'Never');
    await userEvent.type(inSheet.getByLabelText('End date'), '2099-06-30T18:00');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));

    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([
      { ...fields, endDate: null },
      { ...fields, endDate: '2099-06-30T22:00:00.000Z' },
      fields,
    ]);
  });

  it('says a task whose schedule the Chat Service cannot read runs next at an unknown time', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'cron(0 9 W * ? *)', nextRunUnknown: 'The schedule cron(0 9 W * ? *) cannot be read' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());

    await more(within(sheet));
    expect(within(sheet).getByText('Unknown', { selector: 'dd' })).toHaveAttribute('title', 'The schedule cron(0 9 W * ? *) cannot be read');
  });

  // Its Side Chat exists once a run has reached it: a run that failed before it, or was skipped, made none.
  it.each([
    [false, { at: '2026-10-09T12:00:00.000Z', status: 'failed' }],
    [true, { at: '2026-10-09T12:00:00.000Z', status: 'done' }],
  ])('offers Open chat in the sheet only where the task has a Side Chat (%s)', async (sideChat, lastRun) => {
    service.scheduled = [{ ...MORNING_BRIEF, sideChat, lastRun }];
    await renderPage();
    const sheet = await openTask(await openScheduled());

    expect(within(sheet).queryAllByRole('button', { name: 'Open chat' })).toHaveLength(sideChat ? 1 : 0);
    // Its last run, with how it ended, is out of More, in a card of its own under Repeat's (#4041).
    expect(shown(sheet)).toEqual([
      ['Repeat', 'Weekdays'],
      ['Time', '8:00 AM ET'],
      ['Last run', `${lastRun.status === 'done' ? 'Done' : 'Failed'}Fri, Oct 9, 8:00 AM ET`],
    ]);
    expect(sheet.querySelectorAll('dl.settings-group')).toHaveLength(2);
  });

  it("holds Edit's More rows under the sheet's More: Model alone for a one-off, with no card for a next run it lacks (#4041)", async () => {
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'at(2099-10-14T08:30:00)' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());

    expect(shown(sheet)).toEqual([['Repeat', 'Once'], ['Time', 'Wed, Oct 14, 8:30 AM ET']]);
    expect(sheet.querySelectorAll('dl.settings-group')).toHaveLength(1);
    expect(await details(sheet)).toEqual([['Repeat', 'Once'], ['Time', 'Wed, Oct 14, 8:30 AM ET'], ['Model', 'Deep']]);
  });

  it('moves a stop time, or clears it, from the Edit form', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, endDate: '2020-01-01T05:00:00.000Z', paused: true, ended: true }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    // Read in the task's own time zone.
    expect(inSheet.getByLabelText('Ends')).toHaveDisplayValue('Wed, Jan 1, 12:00 AM ET');
    expect(inSheet.getByLabelText('End date')).toHaveValue('2020-01-01T00:00');
    await userEvent.clear(inSheet.getByLabelText('End date'));
    await userEvent.type(inSheet.getByLabelText('End date'), '2099-06-30T18:00');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));

    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([{ title: 'Morning brief', prompt: 'Brief me on rates', endDate: '2099-06-30T22:00:00.000Z' }]);
    expect(within(sheet).queryByText('Ended')).toBeNull();
    expect(inSheet.getByRole('button', { name: 'Resume' })).toBeEnabled();

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    await userEvent.selectOptions(inSheet.getByLabelText('Ends'), 'Never');
    expect(inSheet.getByLabelText('Ends')).toHaveDisplayValue('Never');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));

    expect(sent('PATCH', '/scheduled-tasks/task-1').at(-1)).toEqual({ title: 'Morning brief', prompt: 'Brief me on rates', endDate: null });
    expect(await detail(sheet, 'Ends')).toBe('Never');
  });

  it('makes a task run once, at a date and time, from the Edit form', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, startDate: '2099-01-01T13:00:00.000Z', endDate: '2099-12-31T22:00:00.000Z' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await userEvent.selectOptions(inSheet.getByLabelText('Repeat'), 'Once');
    // A task that runs once ends after it runs: its Time is its only run, and More holds only the model.
    await more(inSheet);
    expect(rows(sheet)).toEqual(['Repeat', 'Time', 'Model']);
    expect(inSheet.getByLabelText('Time')).toHaveValue('2099-01-01T08:00');
    await userEvent.clear(inSheet.getByLabelText('Time'));
    expect(why(sheet)).toBe('Time needs a date and time');
    await userEvent.type(inSheet.getByLabelText('Time'), '2099-11-06T08:30');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));

    // Its schedule carries its time, so it sends no start.
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([
      { title: 'Morning brief', prompt: 'Brief me on rates', schedule: 'at(2099-11-06T08:30:00)', endDate: null, startDate: null },
    ]);
    expect(await detail(sheet, 'Repeat')).toBe('Once');
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
      // More shut: Repeat's card alone.
      words.push(shown(sheet));
      // eslint-disable-next-line no-await-in-loop -- one sheet open at a time
      await closeTask(sheet);
    }

    expect(words).toEqual([
      [['Repeat', 'Weekdays'], ['Time', '8:00 AM ET']],
      [['Repeat', 'Custom'], ['Schedule', 'Every hour']],
      [['Repeat', 'Custom'], ['Schedule', 'cron(nonsense)']],
    ]);
  });

  it("shuts the sheet's More each time the sheet opens (#4041)", async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const task = await openScheduled();
    const sheet = await openTask(task);
    expect(await detail(sheet, 'Ends')).toBe('Never');
    await closeTask(sheet);

    const again = await openTask(task);
    expect(within(again).getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(again).queryByText('Ends')).toBeNull();
    expect(shown(again)).toEqual([['Repeat', 'Weekdays'], ['Time', '8:00 AM ET']]);
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
    // The sheet's Next run reads Paused; the row's Paused is a status pill beside the name, not part of it.
    await more(within(sheet));
    expect(within(sheet).getByText('Paused', { selector: 'dd' })).toBeInTheDocument();
    expect(task.querySelector('.scheduled-task-title')).toHaveTextContent(/^Morning brief$/);
    expect(within(task).getByText('Paused')).toHaveClass('status-pill');
    expect(task.querySelector('.scheduled-task')).toHaveClass('scheduled-task-paused');

    await userEvent.click(within(sheet).getByRole('button', { name: 'Resume' }));

    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([{ paused: true }, { paused: false }]);
    expect(within(task).queryByText('Paused')).toBeNull();
  });

  it('edits what a scheduled task asks', async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const sheet = await openTask(await openScheduled());

    await userEvent.click(within(sheet).getByRole('button', { name: 'Edit' }));
    await userEvent.clear(within(sheet).getByLabelText('Prompt'));
    await userEvent.type(within(sheet).getByLabelText('Prompt'), 'Brief me on FX');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save' }));

    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([
      { title: 'Morning brief', prompt: 'Brief me on FX' },
    ]);
    expect(sheet.querySelector('.scheduled-task-prompt')).toHaveTextContent(/^Brief me on FX$/);
  });

  /** The Edit form's settings rows, by their labels. */
  const rows = (sheet: HTMLElement) => [...sheet.querySelectorAll('.scheduled-edit .settings-row')].map((row) => row.firstElementChild?.textContent);
  const choices = (sheet: HTMLElement) => within(within(sheet).getByLabelText('Repeat')).getAllByRole('option').map((option) => option.textContent);

  it('keeps a schedule as written when an edit leaves its controls alone', async () => {
    beforeCountedRuns();
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'cron(08 8 ? * 2,5 *)' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    // Weekly on two days is none of Repeat's choices: it is Custom, in its own words. With no start, Starts is today.
    expect(inSheet.getByLabelText('Repeat')).toHaveDisplayValue('Custom');
    expect(choices(sheet)).toEqual(['Interval', 'Daily', 'Weekdays', 'Weekly', 'Once', 'Custom']);
    expect(rows(sheet)).toEqual(['Repeat', 'Schedule']);
    expect(inSheet.getByText('Weekly on Monday and Thursday at 8:08 AM')).toBeInTheDocument();
    await more(inSheet);
    expect(inSheet.getByLabelText('Starts')).toHaveValue('2026-10-06T08:08');
    await userEvent.type(inSheet.getByLabelText('Title'), ' (FX)');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));

    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([{ title: 'Morning brief (FX)', prompt: 'Brief me on rates' }]);
  });

  // Changing a schedule meant writing an AWS expression such as cron(0 9 ? * MON-FRI *).
  it('moves a weekday task to 10:00 without an AWS expression', async () => {
    beforeCountedRuns();
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    expect(inSheet.queryByLabelText('Schedule')).toBeNull();
    expect(inSheet.getByLabelText('Repeat')).toHaveDisplayValue('Weekdays');
    // A task from before tasks kept their first run starts at its next one; Time is the time of day it runs.
    expect(inSheet.getByLabelText('Time')).toHaveValue('08:00');
    expect(inSheet.getByText('8:00 AM ET')).toBeInTheDocument();
    fireEvent.change(inSheet.getByLabelText('Time'), { target: { value: '10:00' } });
    expect(inSheet.getByText('10:00 AM ET')).toBeInTheDocument();
    await more(inSheet);
    expect(inSheet.getByText('Tue, Oct 6, 10:00 AM ET')).toBeInTheDocument();
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));

    // It keeps its time zone.
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([
      { title: 'Morning brief', prompt: 'Brief me on rates', schedule: 'cron(0 10 ? * MON-FRI *)', startDate: '2026-10-06T14:00:00.000Z' },
    ]);
    expect((await details(sheet)).slice(0, 2)).toEqual([['Repeat', 'Weekdays'], ['Time', '10:00 AM ET']]);
  });

  // The maintainer (#4041): "we want simple screen, so just should frequencty like minute, hour, day etc and every x,
  // but avoid the stupid regtangle box?"; "more deafult collapsed, with more things like start, end, model"; "lets just
  // follow codex?".
  it('shows Repeat and only what it needs, with Starts, Ends and the model under More, shut (#4041)', async () => {
    beforeCountedRuns();
    // Dev's daily task: rate(1 day), from 7:15 AM New York on 6 October.
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'rate(1 day)', startDate: '2026-10-06T11:15:00.000Z' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);
    // It runs every 24 hours, so a clock change moves it off 7:15 AM: it isn't Daily, nor an Interval of minutes.
    expect((await details(sheet)).slice(0, 2)).toEqual([['Repeat', 'Custom'], ['Schedule', 'Every 24 hours']]);

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    expect(inSheet.getByLabelText('Repeat')).toHaveDisplayValue('Custom');
    expect(inSheet.getByText('Every 24 hours')).toBeInTheDocument();
    expect(choices(sheet)).toEqual(['Interval', 'Daily', 'Weekdays', 'Weekly', 'Once', 'Custom']);
    expect(inSheet.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false');
    const shut = {
      Interval: ['Repeat', 'Every'], Daily: ['Repeat', 'Time'], Weekdays: ['Repeat', 'Time'], Weekly: ['Repeat', 'Day', 'Time'], Once: ['Repeat', 'Time'],
      Custom: ['Repeat', 'Schedule'],
    };
    for (const [choice, labels] of Object.entries(shut)) {
      // eslint-disable-next-line no-await-in-loop -- one choice at a time
      await userEvent.selectOptions(inSheet.getByLabelText('Repeat'), choice);
      expect(rows(sheet)).toEqual(labels);
      expect(inSheet.queryByRole('status')).toBeNull();
    }
    // Weekly runs on Starts' weekday, a Tuesday, until Day picks another.
    await userEvent.selectOptions(inSheet.getByLabelText('Repeat'), 'Weekly');
    expect(inSheet.getByLabelText('Day')).toHaveDisplayValue('Tuesday');
    expect(inSheet.getByText('7:15 AM ET')).toBeInTheDocument();
    // Interval counts minutes, from 30.
    await userEvent.selectOptions(inSheet.getByLabelText('Repeat'), 'Interval');
    expect(inSheet.getByLabelText('Every')).toHaveValue('30');
    expect(inSheet.getByText('minutes')).toBeInTheDocument();
    await userEvent.selectOptions(inSheet.getByLabelText('Repeat'), 'Custom');
    await more(inSheet);
    expect(inSheet.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'true');
    expect(rows(sheet)).toEqual(['Repeat', 'Schedule', 'Starts', 'Ends', 'Model']);
    expect(inSheet.getByLabelText('Starts')).toHaveValue('2026-10-06T07:15');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));

    // Back on Custom, it stays rate(1 day).
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([{ title: 'Morning brief', prompt: 'Brief me on rates' }]);
    expect(await detail(sheet, 'Schedule')).toBe('Every 24 hours');
  });

  it('moves a daily task to every 5 minutes, weekly on Thursday, once, and back to daily (#4041)', async () => {
    beforeCountedRuns();
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'cron(30 7 ? * * *)', startDate: '2026-10-06T11:30:00.000Z' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);
    const fields = { title: 'Morning brief', prompt: 'Brief me on rates' };
    const edit = async (choice: string, pick?: () => Promise<void>) => {
      await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
      await userEvent.selectOptions(inSheet.getByLabelText('Repeat'), choice);
      await pick?.();
      await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    };
    expect((await details(sheet)).slice(0, 2)).toEqual([['Repeat', 'Daily'], ['Time', '7:30 AM ET']]);

    await edit('Interval', () => every(inSheet, '5'));
    expect((await details(sheet)).slice(0, 2)).toEqual([['Repeat', 'Interval'], ['Every', '5 minutes']]);
    await edit('Weekly', () => userEvent.selectOptions(inSheet.getByLabelText('Day'), 'Thursday'));
    expect((await details(sheet)).slice(0, 3)).toEqual([['Repeat', 'Weekly'], ['Day', 'Thursday'], ['Time', '7:30 AM ET']]);
    // Thursday 8 October.
    await edit('Once', async () => {
      fireEvent.change(inSheet.getByLabelText('Time'), { target: { value: '2026-10-08T07:30' } });
    });
    expect(await detail(sheet, 'Repeat')).toBe('Once');
    await edit('Daily');
    expect((await details(sheet)).slice(0, 2)).toEqual([['Repeat', 'Daily'], ['Time', '7:30 AM ET']]);

    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([
      { ...fields, schedule: 'rate(5 minutes)', startDate: '2026-10-06T11:30:00.000Z' },
      { ...fields, schedule: 'cron(30 7 ? * THU *)', startDate: '2026-10-06T11:30:00.000Z' },
      { ...fields, schedule: 'at(2026-10-08T07:30:00)', startDate: null },
      { ...fields, schedule: 'cron(30 7 * * ? *)', startDate: '2026-10-08T11:30:00.000Z' },
    ]);
  });

  it('keeps every 3 minutes when Every goes to 6 and back, and saves Every only as a whole number (#4041)', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'rate(3 minutes)', startDate: '2026-10-06T11:00:00.000Z' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    expect(inSheet.getByLabelText('Every')).toHaveValue('3');
    expect(inSheet.getByText('minutes')).toBeInTheDocument();
    await userEvent.clear(inSheet.getByLabelText('Every'));
    expect(why(sheet)).toBe('Every needs a whole number from 1');
    expect(inSheet.getByRole('button', { name: 'Save' })).toBeDisabled();
    // It takes digits alone.
    await userEvent.type(inSheet.getByLabelText('Every'), '0');
    expect(why(sheet)).toBe('Every needs a whole number from 1');
    await every(inSheet, '6.');
    expect(inSheet.getByLabelText('Every')).toHaveValue('6');
    await every(inSheet, '3');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await every(inSheet, '6');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));

    const fields = { title: 'Morning brief', prompt: 'Brief me on rates' };
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([fields, { ...fields, schedule: 'rate(6 minutes)', startDate: '2026-10-06T11:00:00.000Z' }]);
  });

  // The maintainer (#4041): Interval is minutes only; its unit is words, not a control.
  it('shows Every as a bare count of minutes, with no Unit control (#4041)', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'rate(5 minutes)', startDate: '2026-10-06T11:00:00.000Z' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);
    expect((await details(sheet)).slice(0, 2)).toEqual([['Repeat', 'Interval'], ['Every', '5 minutes']]);

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    expect(inSheet.queryByLabelText('Unit')).toBeNull();
    const row = inSheet.getByLabelText('Every').closest('.settings-row');
    expect(row?.querySelectorAll('input, select')).toHaveLength(1);
    expect(row).toHaveTextContent(/^Everyminutes$/);
    await every(inSheet, '1');
    expect(row).toHaveTextContent(/^Everyminute$/);
  });

  // An hour's or a day's rate is none of Repeat's choices, now Interval counts minutes alone (#4041).
  it.each([
    ['rate(3 hours)', 'Every 3 hours'],
    ['rate(3 days)', 'Every 3 days'],
    ['rate(14 days)', 'Every 14 days'],
  ])('opens %s as Custom, %s, and Save leaves it alone; Interval makes minutes (#4041)', async (schedule, words) => {
    service.scheduled = [{ ...MORNING_BRIEF, schedule, startDate: '2026-10-06T11:00:00.000Z' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);
    expect((await details(sheet)).slice(0, 2)).toEqual([['Repeat', 'Custom'], ['Schedule', words]]);

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    expect(inSheet.getByLabelText('Repeat')).toHaveDisplayValue('Custom');
    expect(rows(sheet)).toEqual(['Repeat', 'Schedule']);
    expect(inSheet.getByText(words)).toBeInTheDocument();
    expect(inSheet.queryByLabelText('Every')).toBeNull();
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(service.scheduled[0]?.schedule).toBe(schedule);
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await userEvent.selectOptions(inSheet.getByLabelText('Repeat'), 'Interval');
    await every(inSheet, '4');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));

    const fields = { title: 'Morning brief', prompt: 'Brief me on rates' };
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([fields, { ...fields, schedule: 'rate(4 minutes)', startDate: '2026-10-06T11:00:00.000Z' }]);
  });

  it('keeps a schedule no other choice says as Custom, in its words, and Save leaves it alone (#4041)', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, schedule: 'cron(0 8 1 * ? *)' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));

    expect(inSheet.getByLabelText('Repeat')).toHaveDisplayValue('Custom');
    expect(rows(sheet)).toEqual(['Repeat', 'Schedule']);
    expect(inSheet.getByText('At 8:00 AM, on day 1 of the month')).toBeInTheDocument();
    await userEvent.selectOptions(inSheet.getByLabelText('Repeat'), 'Daily');
    await userEvent.selectOptions(inSheet.getByLabelText('Repeat'), 'Custom');
    await userEvent.clear(inSheet.getByLabelText('Prompt'));
    await userEvent.type(inSheet.getByLabelText('Prompt'), 'Brief me on FX');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([{ title: 'Morning brief', prompt: 'Brief me on FX' }]);
    expect(service.scheduled[0]?.schedule).toBe('cron(0 8 1 * ? *)');
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
    await more(inSheet);
    expect(inSheet.getByLabelText('Model')).toHaveValue('plan');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    await userEvent.selectOptions(inSheet.getByLabelText('Model'), 'Sonnet');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);

    const fields = { title: 'Morning brief', prompt: 'Brief me on rates' };
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([fields, { ...fields, model: 'sonnet' }]);
    expect(inSheet.getByLabelText('Model')).toHaveValue('sonnet');
  });

  it('shows a model the account no longer has as unavailable, not as its default', async () => {
    service.models = [{ key: 'plan', label: 'GPT', provider: 'openai' }];
    service.scheduled = [{ ...MORNING_BRIEF, model: 'retired' }];
    await renderPage();
    const sheet = await openTask(await openScheduled());
    const inSheet = within(sheet);
    // The sheet reads the model as Edit's Model shows it (#4041).
    expect(await detail(sheet, 'Model')).toBe('retired (unavailable)');

    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);

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
    // The sheet's Model reads as Edit's does (#4041).
    const words = `${model ?? 'Account default'} (models unavailable)`;
    expect(await detail(sheet, 'Model')).toBe(words);
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    expect(inSheet.getByLabelText('Model')).toBeDisabled();
    expect(inSheet.getByLabelText('Model')).toHaveValue(model ?? '');
    expect(inSheet.getByLabelText('Model')).toHaveDisplayValue(words);
    await userEvent.clear(inSheet.getByLabelText('Prompt'));
    await userEvent.type(inSheet.getByLabelText('Prompt'), 'Brief me on FX');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(sent('PATCH', '/scheduled-tasks/task-1')).toEqual([
      { title: 'Morning brief', prompt: 'Brief me on FX' },
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
    await more(inSheet);
    const chooser = inSheet.getByLabelText('Model');
    expect(chooser).toBeEnabled();
    expect(chooser).toHaveValue(model ?? '');
    expect(within(chooser).queryByRole('option', { name: 'GPT' })).not.toBeInTheDocument();
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    expect(sent('PATCH', '/scheduled-tasks/task-1')[0]).not.toHaveProperty('model');
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
    await userEvent.selectOptions(inSheet.getByLabelText('Model'), 'Sonnet');
    await userEvent.click(inSheet.getByRole('button', { name: 'Save' }));
    await userEvent.click(inSheet.getByRole('button', { name: 'Edit' }));
    await more(inSheet);
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
    await more(inSheet);
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
      { title: 'Morning brief', prompt: 'Brief me on FX' },
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

  it('reads the sheet\'s Model as loading, not unavailable, until the models load', async () => {
    service.scheduled = [{ ...MORNING_BRIEF, model: 'sonnet' }];
    await renderPage();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/agent/models' ? new Promise<Response>(() => {}) : chatService(url, init),
    );

    const sheet = await openTask(await openScheduled());

    expect(await detail(sheet, 'Model')).toBe('Loading…');
  });

  it('asks before deleting a scheduled task, and keeps it on Cancel', async () => {
    service.scheduled = [MORNING_BRIEF];
    await renderPage();
    const sheet = await openTask(await openScheduled());

    await userEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));

    expect(within(sheet).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Close', 'More', 'Delete task', 'Cancel']);
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

  it('removes an absent scheduled task while reporting the deletion error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service.scheduled = [MORNING_BRIEF];
    service.failing.set('DELETE /scheduled-tasks/task-1', 404);
    await renderPage();
    const sheet = await openTask(await openScheduled());

    await deleteTask(sheet);

    expect(await within(openProfile()).findByText("Couldn't delete Morning brief. Try again.")).toHaveClass('agent-profile-error');
    expect(error).toHaveBeenCalledWith(new Error('Deleting Morning brief failed: 404'));
    expect(within(openProfile()).queryByRole('listitem')).toBeNull();
    expect(within(openProfile()).getByText('No scheduled tasks yet.')).toBeInTheDocument();
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

    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Personalization' }));
    expect(within(openProfile()).getByRole('tabpanel')).toHaveAccessibleName('Personalization');
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

  const openPersonalization = async () => {
    await userEvent.click(avatar());
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Personalization' }));
    await settle();
    return within(openProfile().querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])') as HTMLElement);
  };
  /** Agent Identity's editor, opened from the pencil on the agent's avatar in the open profile. */
  const editIdentity = async () => {
    await userEvent.click(within(openProfile()).getByRole('button', { name: 'Edit agent' }));
    await settle();
    return within(openProfile().querySelector<HTMLElement>('.agent-profile-panel:not([hidden])') as HTMLElement);
  };
  const identityArticle = () => document.querySelector('article[aria-label="Identity"]');

  it("opens Agent Identity's editor from the edit badge on the agent's avatar, in place of the tab it returns to", async () => {
    await renderPage();
    await userEvent.click(avatar());

    const editor = await editIdentity();

    expect(within(openProfile()).queryByRole('tab', { selected: true })).toBeNull();
    expect(within(openProfile()).queryByRole('tabpanel')).toBeNull();
    expect(editor.getByLabelText<HTMLInputElement>('Name').value).toBe('Ada Bot');
    expect(editor.getByLabelText<HTMLInputElement>('Character').value).toBe('A research assistant');
    expect(editor.getByLabelText<HTMLInputElement>('Vibe').value).toBe('Warm');
    expect(editor.getByLabelText<HTMLInputElement>('Avatar').value).toBe('');
    expect(editor.queryByRole('button', { name: 'Edit Identity' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/identity', { credentials: 'include', cache: 'no-store' });
    expect(editor.getByRole('region', { name: 'About Identity' })).toHaveTextContent(
      /^Who your agent is to you: its name, character, vibe, and avatar \(an emoji, or blank for the default avatar\)\. The agent reads it at the start of every message and uses your edits from your next message on\. It may change this file itself, and tells you in the chat when it does\.$/,
    );

    await click(editor, 'Cancel editing Identity');

    expect(identityArticle()).toBeNull();
    expect(within(openProfile()).getByRole('tab', { selected: true })).toHaveAccessibleName('Computer');
    expect(within(openProfile()).getByRole('tabpanel')).toHaveTextContent(/^Ada Bot: research-agent computer for main-1$/);
    expect(cartridge.computerMounts).toBe(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });

  it.each(['Back', 'tab'])('closes Agent Identity unsaved with %s, back to the tab the user was on', async (way) => {
    await renderPage();
    await openPersonalization();
    const editor = await editIdentity();
    await userEvent.type(editor.getByLabelText('Name'), '!');

    if (way === 'Back') await click(editor, 'Back');
    else await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Personalization' }));
    await settle();

    expect(identityArticle()).toBeNull();
    expect(within(openProfile()).getByRole('tabpanel')).toHaveAccessibleName('Personalization');
    expect(service.agentIdentity.name).toBe('Ada Bot');
  });

  it.each([
    { character: 'A research assistant', line: 'A research assistant' },
    { character: '  ', line: null },
  ])("shows Agent Identity's character $character under the agent's name, above its status, only when set", async ({ character, line }) => {
    service.agentIdentity = { ...service.agentIdentity, character };
    await renderPage();
    await userEvent.click(avatar());
    await settle();

    const name = present(openProfile().querySelector('.agent-profile-name'), 'the name');
    if (line === null) {
      expect(openProfile().querySelector('.agent-profile-character')).toBeNull();
      expect(name.nextElementSibling).toHaveClass('agent-profile-status');
    } else {
      expect(name.nextElementSibling).toHaveClass('agent-profile-character');
      expect(name.nextElementSibling).toHaveTextContent(new RegExp(`^${line}$`));
      expect(name.nextElementSibling?.nextElementSibling).toHaveClass('agent-profile-status');
    }
  });

  it('shows Soul and Memory as side-by-side cards, each counting what it holds', async () => {
    service.soul = '\n  Be candid.  \n\nAlways.';
    await renderPage();

    const panel = await openPersonalization();

    expect(panel.getAllByRole('button').map((card) => card.getAttribute('aria-label'))).toEqual(['Open Soul', 'Open Memory']);
    expect(panel.getAllByRole('button').map((card) => card.textContent)).toEqual([
      'SoulValues and habits2 lines',
      'MemoryWhat it knows2 memories',
    ]);
    expect(panel.queryByRole('textbox')).toBeNull();
  });

  it.each([
    { soul: 'Be candid.', lines: [], counts: ['1 line', 'No memories yet'] },
    { soul: '  ', lines: [{ id: 'mem-paris', text: 'Lives in Paris' }], counts: ['Empty', '1 memory'] },
  ])('counts $counts', async ({ soul, lines, counts }) => {
    service.soul = soul;
    service.memory = lines;
    await renderPage();

    await openPersonalization();

    expect([...openProfile().querySelectorAll('.agent-file-card-count')].map((count) => count.textContent)).toEqual(counts);
  });

  type Panel = ReturnType<typeof within>;
  const openFile = async (panel: Panel, file: string) => {
    await userEvent.click(panel.getByRole('button', { name: `Open ${file}` }));
    return within(panel.getByRole('article', { name: file }));
  };
  const editFile = async (panel: Panel, file: string) => {
    const opened = await openFile(panel, file);
    await userEvent.click(opened.getByRole('button', { name: `Edit ${file}` }));
    return opened;
  };
  const click = async (panel: Panel, name: string) => {
    await userEvent.click(panel.getByRole('button', { name }));
    await settle();
  };

  it('opens Soul read-only, with a note on what it is, and edits it from its saved text', async () => {
    await renderPage();
    const panel = await openPersonalization();

    const soul = await openFile(panel, 'Soul');

    expect(panel.queryByRole('textbox')).toBeNull();
    expect(soul.getByText('Be candid.')).toHaveClass('agent-file-text');
    expect(soul.getByRole('region', { name: 'About Soul' })).toHaveTextContent(
      /^The values and habits your agent keeps in every chat\. The agent reads it at the start of every message and uses your edits from your next message on\. It may change this file itself, and tells you in the chat when it does\. Soul shapes only its manner: its rules for grounding answers and running commands live in its skills, which Soul cannot change\.$/,
    );

    await click(panel, 'Edit Soul');

    expect(panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'Soul' }).value).toBe('Be candid.');
  });

  it('renames the agent, updating its header and profile, and closes the editor', async () => {
    await renderPage();
    await openPersonalization();
    const editor = await editIdentity();

    await userEvent.clear(editor.getByLabelText('Name'));
    await userEvent.type(editor.getByLabelText('Name'), 'Quill');
    await userEvent.clear(editor.getByLabelText('Character'));
    await userEvent.type(editor.getByLabelText('Character'), 'A poet');
    await click(editor, 'Save Identity');

    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/identity', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Quill', character: 'A poet', vibe: 'Warm', avatar: '' }),
    });
    expect(avatar()).toHaveTextContent(/^Quill$/);
    expect(openProfile().querySelector('.agent-profile-name')).toHaveTextContent(/^Quill$/);
    expect(openProfile().querySelector('.agent-profile-character')).toHaveTextContent(/^A poet$/);
    expect(identityArticle()).toBeNull();
    expect(within(openProfile()).getByRole('tabpanel')).toHaveAccessibleName('Personalization');
  });

  it('saves an edited Soul and shows it read-only again', async () => {
    await renderPage();
    const panel = await openPersonalization();
    const soul = await editFile(panel, 'Soul');

    await userEvent.clear(panel.getByRole('textbox', { name: 'Soul' }));
    await userEvent.type(panel.getByRole('textbox', { name: 'Soul' }), 'Answer in haiku.');
    await click(panel, 'Save Soul');

    expect(service.soul).toBe('Answer in haiku.');
    // Saved sits in the file's header, just before Edit, so the document does not move down a line.
    const saved = soul.getByRole('status');
    expect(saved).toHaveTextContent(/^Saved$/);
    expect(saved.nextElementSibling).toBe(soul.getByRole('button', { name: 'Edit Soul' }));
    expect(panel.queryByRole('textbox')).toBeNull();
    expect(soul.getByText('Answer in haiku.')).toHaveClass('agent-file-text');
  });

  it('discards an edit on Cancel', async () => {
    await renderPage();
    const panel = await openPersonalization();
    const soul = await editFile(panel, 'Soul');

    await userEvent.type(panel.getByRole('textbox', { name: 'Soul' }), ' Always.');
    await click(panel, 'Cancel editing Soul');

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    expect(panel.queryByRole('textbox')).toBeNull();
    expect(soul.getByText('Be candid.')).toHaveClass('agent-file-text');

    await click(panel, 'Edit Soul');

    expect(panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'Soul' }).value).toBe('Be candid.');
  });

  const memoryLines = (panel: Panel) =>
    panel.getAllByRole('textbox', { name: /^Memory line \d+$/ }).map((line: HTMLElement) => (line as HTMLInputElement).value);
  const memoryText = (panel: Panel) => panel.getAllByRole('listitem').map((line: HTMLElement) => line.textContent);

  it('shows Memory as one line per memory, with a note on what it is', async () => {
    await renderPage();
    const panel = await openPersonalization();

    const memory = await openFile(panel, 'Memory');

    expect(memoryText(memory)).toEqual(['Trades copper futures', 'Lives in Paris']);
    expect(panel.queryByRole('textbox')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/memory', { credentials: 'include', cache: 'no-store' });
    expect(memory.getByRole('region', { name: 'About Memory' })).toHaveTextContent(
      /^What your agent has learned about you and keeps from chat to chat, one memory per line\. The agent reads it once when a chat starts\. Chats already open, including your Main chat, keep what they read\. Side chats you start later get your edits, but a memory the agent saved less than 15 minutes ago keeps its old text until then\. Edit a line to correct it, or delete it to make the agent forget it\.$/,
    );

    await click(panel, 'Edit Memory');

    expect(memoryLines(panel)).toEqual(['Trades copper futures', 'Lives in Paris']);
  });

  const memoryPuts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');

  it('saves the Memory lines the user edited, and only those', async () => {
    await renderPage();
    const panel = await openPersonalization();
    const memory = await editFile(panel, 'Memory');

    await userEvent.clear(panel.getByRole('textbox', { name: 'Memory line 2' }));
    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 2' }), 'Lives in London');
    await click(panel, 'Save Memory');

    expect(memoryText(memory)).toEqual(['Trades copper futures', 'Lives in London']);
    expect(panel.getByRole('status')).toHaveTextContent(/^Saved$/);

    // A saved line is no longer an edit: saving again sends nothing.
    await click(panel, 'Edit Memory');
    await click(panel, 'Save Memory');

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
    const panel = await openPersonalization();
    const memory = await editFile(panel, 'Memory');

    await click(panel, 'Delete Memory line 1');

    expect(memoryDeletes()).toHaveLength(0);
    expect(memoryLines(panel)).toEqual(['Lives in Paris']);

    // The lines left after a delete are not edits.
    await click(panel, 'Save Memory');

    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/memory/mem-copper', { method: 'DELETE', credentials: 'include' });
    expect(memoryPuts()).toHaveLength(0);
    expect(memoryText(memory)).toEqual(['Lives in Paris']);
    expect(service.memory.map((line) => line.text)).toEqual(['Lives in Paris']);
  });

  it('keeps a deleted Memory line when the edit is cancelled', async () => {
    await renderPage();
    const panel = await openPersonalization();
    const memory = await editFile(panel, 'Memory');

    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    await click(panel, 'Delete Memory line 1');
    await click(panel, 'Cancel editing Memory');

    expect(memoryPuts()).toHaveLength(0);
    expect(memoryDeletes()).toHaveLength(0);
    expect(memoryText(memory)).toEqual(['Trades copper futures', 'Lives in Paris']);
  });

  it('says a saved Memory line was already removed and refreshes the list', async () => {
    await renderPage();
    const panel = await openPersonalization();
    await editFile(panel, 'Memory');
    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    service.memory = service.memory.filter((line) => line.id !== 'mem-paris');
    service.failing.set('PUT /agent/memory/mem-paris', 404);

    await click(panel, 'Save Memory');

    expect(panel.getByRole('alert')).toHaveTextContent(/^This Memory line was already removed\.$/);
    await waitFor(() => expect(memoryText(panel)).toEqual(['Trades copper futures']));
    expect(panel.queryByText('Saved')).toBeNull();
    expect(panel.queryByRole('textbox', { name: 'Memory line 2' })).toBeNull();
  });

  it.each([false, true])('preserves an unsent Memory draft after a removed first edit and refresh failure %s', async (refreshFails) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    const panel = await openPersonalization();
    await editFile(panel, 'Memory');
    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 1' }), ' and gold');
    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    service.memory = service.memory.filter((line) => line.id !== 'mem-copper');
    service.failing.set('PUT /agent/memory/mem-copper', 404);
    if (refreshFails) service.failing.set('GET /agent/memory', 503);

    await click(panel, 'Save Memory');

    expect(panel.getByText('This Memory line was already removed.')).toHaveAttribute('role', 'alert');
    expect(memoryPuts().map(([url]) => url)).toEqual(['http://chat.test/agent/memory/mem-copper']);
    expect(service.memory).toEqual([{ id: 'mem-paris', text: 'Lives in Paris' }]);
    if (refreshFails) {
      expect(await panel.findByText('Memory could not be loaded.')).toBeInTheDocument();
      service.failing.delete('GET /agent/memory');
      await click(panel, 'Retry');
    }
    await waitFor(() => expect(memoryLines(panel)).toEqual(['Lives in Paris and London']));
    expect(panel.queryByText('Trades copper futures and gold')).toBeNull();
    expect(panel.queryByText('Saved')).toBeNull();

    await click(panel, 'Save Memory');

    expect(service.memory).toEqual([{ id: 'mem-paris', text: 'Lives in Paris and London' }]);
    expect(memoryPuts().map(([url]) => url)).toEqual([
      'http://chat.test/agent/memory/mem-copper',
      'http://chat.test/agent/memory/mem-paris',
    ]);
    expect(memoryText(panel)).toEqual(['Lives in Paris and London']);
    expect(panel.getByRole('status')).toHaveTextContent(/^Saved$/);
  });

  it('recovers only unsent edits and retains fresh remote lines after a middle Memory edit disappears', async () => {
    service.memory.push({ id: 'mem-third', text: 'Prefers tea' });
    await renderPage();
    const panel = await openPersonalization();
    await editFile(panel, 'Memory');
    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 1' }), ' and gold');
    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 3' }), ' and coffee');
    service.memory = service.memory.filter((line) => line.id !== 'mem-paris');
    service.memory.push({ id: 'mem-new', text: 'Works remotely' });
    service.failing.set('PUT /agent/memory/mem-paris', 404);

    await click(panel, 'Save Memory');

    await waitFor(() => expect(memoryLines(panel)).toEqual([
      'Trades copper futures and gold', 'Prefers tea and coffee', 'Works remotely',
    ]));
    expect(memoryPuts().map(([url]) => url)).toEqual([
      'http://chat.test/agent/memory/mem-copper', 'http://chat.test/agent/memory/mem-paris',
    ]);
    expect(service.memory.map((line) => line.text)).toEqual([
      'Trades copper futures and gold', 'Prefers tea', 'Works remotely',
    ]);

    await click(panel, 'Save Memory');

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
    const panel = await openPersonalization();
    await editFile(panel, 'Memory');
    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 1' }), ' and gold');
    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    service.memory = service.memory.filter((line) => line.id !== 'mem-copper');
    service.failing.set('PUT /agent/memory/mem-copper', 404);
    await click(panel, 'Save Memory');
    await waitFor(() => expect(memoryLines(panel)).toEqual(['Lives in Paris and London']));

    await click(panel, 'Cancel editing Memory');
    await click(panel, 'Edit Memory');

    expect(memoryLines(panel)).toEqual(['Lives in Paris']);
  });

  it('shows a failed refresh after a removed Memory line without claiming it was saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    const panel = await openPersonalization();
    await editFile(panel, 'Memory');
    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    service.memory = service.memory.filter((line) => line.id !== 'mem-paris');
    service.failing.set('PUT /agent/memory/mem-paris', 404);
    service.failing.set('GET /agent/memory', 503);

    await click(panel, 'Save Memory');

    expect(panel.getByText('This Memory line was already removed.')).toHaveAttribute('role', 'alert');
    expect(await panel.findByText('Memory could not be loaded.')).toBeInTheDocument();
    expect(panel.queryByText('Saved')).toBeNull();
    expect(panel.queryByRole('textbox', { name: 'Memory line 2' })).toBeNull();
    service.failing.delete('GET /agent/memory');
    await click(panel, 'Retry');
    await waitFor(() => expect(memoryText(panel)).toEqual(['Trades copper futures']));
    expect(panel.queryByText('Saved')).toBeNull();
  });

  it('says why a Memory edit could not be saved, until the next save', async () => {
    service.failing.set('PUT /agent/memory/mem-paris', 503);
    await renderPage();
    const panel = await openPersonalization();
    await editFile(panel, 'Memory');

    await userEvent.type(panel.getByRole('textbox', { name: 'Memory line 2' }), ' and London');
    await click(panel, 'Save Memory');

    expect(panel.getByRole('alert')).toHaveTextContent(/^Saving Memory failed: 503$/);
    expect(panel.queryByRole('status')).toBeNull();

    service.failing.delete('PUT /agent/memory/mem-paris');
    await click(panel, 'Save Memory');

    expect(panel.queryByRole('alert')).toBeNull();
    expect(panel.getByRole('status')).toHaveTextContent(/^Saved$/);
    expect(service.memory.map((line) => line.text)).toEqual(['Trades copper futures', 'Lives in Paris and London']);
  });

  it('says why a Memory line could not be deleted', async () => {
    service.failing.set('DELETE /agent/memory/mem-copper', 502);
    await renderPage();
    const panel = await openPersonalization();
    await editFile(panel, 'Memory');

    await click(panel, 'Delete Memory line 1');
    await click(panel, 'Save Memory');

    expect(panel.getByRole('alert')).toHaveTextContent(/^Deleting a Memory line failed: 502$/);
    expect(memoryLines(panel)).toEqual(['Lives in Paris']);

    service.failing.delete('DELETE /agent/memory/mem-copper');
    await click(panel, 'Save Memory');

    expect(panel.queryByRole('alert')).toBeNull();
    expect(service.memory.map((line) => line.text)).toEqual(['Lives in Paris']);
  });

  it('says when the agent has no Memory yet', async () => {
    service.memory = [];
    await renderPage();
    const panel = await openPersonalization();

    await openFile(panel, 'Memory');

    expect(panel.getByText('No memories yet.')).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Edit Memory' })).toBeNull();
    expect(panel.queryByRole('button', { name: 'Save Memory' })).toBeNull();
  });

  it('shows a file loading until it arrives, while the other files open', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/agent/soul' ? new Promise<Response>(() => {}) : chatService(url, init),
    );
    await renderPage();
    const panel = await openPersonalization();

    const soul = await openFile(panel, 'Soul');

    expect(soul.getByRole('status')).toHaveAccessibleName('Loading Soul');
    expect(soul.queryByRole('button', { name: 'Edit Soul' })).toBeNull();
    await click(panel, 'Back');
    const memory = await openFile(panel, 'Memory');
    expect(memory.getAllByRole('listitem').map((line) => line.textContent)).toEqual(['Trades copper futures', 'Lives in Paris']);
  });

  it('says why one file could not load on that file only, and loads it on Retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    service.failing.set('GET /agent/soul', 500);
    await renderPage();
    const panel = await openPersonalization();

    expect(panel.queryByRole('alert')).toBeNull();
    expect(panel.getByRole('button', { name: 'Open Soul' })).toHaveTextContent(/^SoulValues and habits$/);
    const memory = await openFile(panel, 'Memory');
    expect(memory.getAllByRole('listitem').map((line) => line.textContent)).toEqual(['Trades copper futures', 'Lives in Paris']);
    await click(panel, 'Back');
    const soul = await openFile(panel, 'Soul');
    expect(soul.getByRole('alert')).toHaveTextContent(/^Soul could not be loaded\.$/);
    expect(error).toHaveBeenCalledWith(new Error('Loading Soul failed: 500'));
    expect(soul.queryByRole('button', { name: 'Edit Soul' })).toBeNull();

    service.failing.delete('GET /agent/soul');
    await click(panel, 'Retry');

    const loaded = within(panel.getByRole('article', { name: 'Soul' }));
    expect(loaded.queryByRole('alert')).toBeNull();
    expect(loaded.getByText('Be candid.')).toHaveClass('agent-file-text');
  });

  it("says why Agent Identity could not load in its editor, without a character line, and loads both on Retry", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    service.failing.set('GET /agent/identity', 500);
    await renderPage();
    await userEvent.click(avatar());
    await settle();
    expect(openProfile().querySelector('.agent-profile-character')).toBeNull();

    const editor = await editIdentity();

    expect(editor.getByRole('alert')).toHaveTextContent(/^Identity could not be loaded\.$/);
    expect(error).toHaveBeenCalledWith(new Error('Loading Identity failed: 500'));
    expect(editor.queryByRole('button', { name: 'Save Identity' })).toBeNull();

    service.failing.delete('GET /agent/identity');
    await click(editor, 'Retry');

    expect(editor.queryByRole('alert')).toBeNull();
    expect(editor.getByLabelText<HTMLInputElement>('Name').value).toBe('Ada Bot');
    expect(openProfile().querySelector('.agent-profile-character')).toHaveTextContent(/^A research assistant$/);
  });

  it.each(['Soul', 'Memory'])('saves %s in place, without submitting the page', async (file) => {
    await renderPage();
    const panel = await openPersonalization();
    await editFile(panel, file);

    // Save sits in the file's header, outside the form it submits.
    const form = present(panel.getByRole<HTMLButtonElement>('button', { name: `Save ${file}` }).form, `the ${file} form`);
    expect(fireEvent.submit(form)).toBe(false);
    await settle();
  });

  it('says why an edit could not be saved, until the next save', async () => {
    await renderPage();
    const panel = await openPersonalization();
    const saveSoul = async () => {
      await click(panel, 'Save Soul');
    };
    await editFile(panel, 'Soul');

    await saveSoul();
    service.failing.set('PUT /agent/soul', 503);
    await click(panel, 'Edit Soul');
    await saveSoul();

    expect(panel.getByRole('alert')).toHaveTextContent(/^Saving Soul failed: 503$/);
    expect(panel.queryByRole('status')).toBeNull();

    service.failing.delete('PUT /agent/soul');
    await saveSoul();

    expect(panel.queryByRole('alert')).toBeNull();
    expect(panel.getByRole('status')).toHaveTextContent(/^Saved$/);
  });

  it('drops a failed save message once the edit is cancelled', async () => {
    service.failing.set('PUT /agent/soul', 503);
    await renderPage();
    const panel = await openPersonalization();
    await editFile(panel, 'Soul');

    await click(panel, 'Save Soul');
    await click(panel, 'Cancel editing Soul');

    expect(panel.queryByRole('alert')).toBeNull();
  });

  const choosePicture = async (panel: Panel, name: string) => {
    await userEvent.upload(panel.getByLabelText('Upload picture'), new File(['png'], name, { type: 'image/png' }));
    await settle();
  };

  it("shows the agent's picture in the chat header, the profile header, and Identity", async () => {
    service.agentPicture = PICTURE;
    await renderPage();

    expect(pictureIn(avatar())).toBe(PICTURE);
    await userEvent.click(avatar());
    expect(pictureIn(openProfile().querySelector('.agent-profile-header'))).toBe(PICTURE);
    await editIdentity();

    expect(pictureIn(identityArticle())).toBe(PICTURE);
  });

  it('uploads a picture for the agent, resized small, from the Identity edit view', async () => {
    const resized = 'data:image/webp;base64,UklGRg==';
    const canvas = resizing(resized);
    await renderPage();
    await userEvent.click(avatar());
    const panel = await editIdentity();

    await choosePicture(panel, 'quill.png');

    expect(canvas.drawImage).toHaveBeenCalledWith(canvas.image, 0, 0, 256, 128);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/webp', 0.9);
    expect(pictureIn(identityArticle())).toBe(resized);
    expect(requestsTo('/agent/picture')).toEqual([]);

    await click(panel, 'Save Identity');

    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/picture', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ picture: resized }),
    });
    expect(pictureIn(avatar())).toBe(resized);
    expect(identityArticle()).toBeNull();
    expect(pictureIn(openProfile().querySelector('.agent-profile-header'))).toBe(resized);
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
    await userEvent.click(avatar());
    const panel = await editIdentity();
    await choosePicture(panel, 'first-account.png');
    await userEvent.click(panel.getByRole('button', { name: 'Save Identity' }));
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
    await userEvent.click(avatar());
    const panel = await editIdentity();
    await choosePicture(panel, 'first-account.png');
    await userEvent.click(panel.getByRole('button', { name: 'Save Identity' }));
    // The switch request starts before its response installs the cookie; React has not rerendered.
    current = false;
    cookieAccount = 'acct-second';
    finishIdentity(answer(200, { status: 'saved' }));
    await settle();
    expect(pictureOwners).toEqual([]);
    expect(panel.getByRole('alert')).toHaveTextContent('Saving Identity cancelled');
    expect(panel.queryByText('Saved')).toBeNull();
  });

  it.each(['save', 'event'])('refuses an old profile %s before a switching account rerenders', async (trigger) => {
    let current = true;
    await renderPage(Object.assign(auth({ accountId: 'acct-first' }), { isAccountCurrent: () => current }));
    const panel = await openPersonalization();
    const subscribers = [...agent().subscribers];
    let finishSave!: (response: Response) => void;
    const pendingSave = new Promise<Response>((resolve) => { finishSave = resolve; });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://chat.test/agent/soul' && init?.method === 'PUT') return pendingSave;
      return chatService(url, init);
    });
    if (trigger === 'save') {
      await editFile(panel, 'Soul');
      await userEvent.click(panel.getByRole('button', { name: 'Save Soul' }));
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
    const panel = await openPersonalization();
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
      await editFile(panel, 'Soul');
      await userEvent.click(panel.getByRole('button', { name: 'Save Soul' }));
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
    await userEvent.click(within(openProfile()).getByRole('tab', { name: 'Personalization' }));
    await settle();
    expect(screen.getByRole('button', { name: 'Open Soul' })).toBeInTheDocument();
    await emit('botcube:agent-document-edited');
    expect(profiles).toHaveLength(2);
    await act(async () => { present(profiles[1], 'current account profile')(answer(200, { name: 'Updated second account agent', picture: null })); });
    await settle();
    expect(openProfile().querySelector('.agent-profile-name')).toHaveTextContent('Updated second account agent');
  });

  it.each([null, 'data:image/png;base64,c2Vjb25k'])('keeps the new account picture %s while its profile loads', async (picture) => {
    service.agentPicture = PICTURE;
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    await userEvent.click(avatar());
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
    if (!profile()) await userEvent.click(avatar());
    // Until the new account's profile loads, there is no pencil to edit with.
    expect(within(openProfile()).queryByRole('button', { name: 'Edit agent' })).toBeNull();
    finishProfile(answer(200, { name: 'Second account agent', picture }));
    await settle();
    const panel = await editIdentity();
    await userEvent.click(panel.getByRole('button', { name: 'Save Identity' }));
    await settle();
    expect(requestsTo('/agent/picture')).not.toContain('PUT');
    expect(service.agentPicture).toBe(picture);
  });

  it("clears the agent's picture back to its default avatar", async () => {
    service.agentPicture = PICTURE;
    await renderPage();
    await userEvent.click(avatar());
    const panel = await editIdentity();

    await click(panel, 'Remove picture');

    expect(panel.queryByRole('button', { name: 'Remove picture' })).toBeNull();
    expect(pictureIn(identityArticle())).toBeUndefined();

    await click(panel, 'Save Identity');

    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/agent/picture', { method: 'DELETE', credentials: 'include' });
    expect(pictureIn(avatar())).toBeUndefined();
    expect(avatar()).toHaveTextContent(/^Ada Bot$/);
    expect(avatar().querySelector('.avatar-agent .avatar-monocle')).not.toBeNull();
  });

  it('leaves the picture alone when only the name changes', async () => {
    service.agentPicture = PICTURE;
    await renderPage();
    await userEvent.click(avatar());
    const panel = await editIdentity();

    await userEvent.type(panel.getByLabelText('Name'), '!');
    await click(panel, 'Save Identity');

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
    await userEvent.click(avatar());
    const panel = await editIdentity();

    await choosePicture(panel, 'huge.png');
    await click(panel, 'Save Identity');

    expect(panel.getByRole('alert')).toHaveTextContent(/^Saving the picture failed: The agent's picture must be at most 256 KB$/);
    expect(panel.getByLabelText('Upload picture')).toBeInTheDocument();
  });

  it('says when the chosen file is not an image', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => Promise.reject(new DOMException('undecodable', 'InvalidStateError'))),
    );
    await renderPage();
    await userEvent.click(avatar());
    const panel = await editIdentity();

    await choosePicture(panel, 'notes.png');

    expect(panel.getByRole('alert')).toHaveTextContent(/^notes\.png is not an image$/);
    expect(requestsTo('/agent/picture')).toEqual([]);
  });

  it("shows the agent's own edit in the header, profile, and Personalization tab", async () => {
    await renderPage();
    const panel = await openPersonalization();
    const soul = await openFile(panel, 'Soul');

    service.agentIdentity = { ...service.agentIdentity, name: 'Quill', character: 'A haiku poet', avatar: '🪶' };
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
    expect(openProfile().querySelector('.agent-profile-character')).toHaveTextContent(/^A haiku poet$/);
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
    const trigger = screen.getByRole('button', { name: 'Model GPT Plan, reasoning Medium' });
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

  it('omits the unavailable microphone control', async () => {
    await renderPage();
    expect(screen.queryByRole('button', { name: /Microphone/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('offers the models the Chat Service lists for the account', async () => {
    service.models = [{ key: 'gpt-plan', label: 'GPT Plan', provider: 'openai' }];
    await renderPage();

    expect(pill()).toHaveTextContent(/^GPT PlanMedium$/);
    expect(kit().properties).toEqual({ model: 'gpt-plan', effort: 'medium', sandbox: true });
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
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      await renderPage();
      expect(copilot.openingTurn).not.toHaveBeenCalled();

      await userEvent.click(pill());
      expect(names()).toEqual(['Deep', 'Fast', 'Plan', 'Effort']);
    });

    it("never hands another provider's model to a replayed Session", async () => {
      service.sideChats = [sideChat('on-plan', 'On the plan')];
      service.replies.set('on-plan', [{ id: 'm1', role: 'user', content: 'On the plan' }]);
      service.providers.set('on-plan', 'openai');
      await renderPage();
      expect(pill()).toHaveTextContent(/^DeepMedium$/);

      await userEvent.click(sidebar().getByText('On the plan'));
      await settle();

      const replays = copilot.kits.filter((entry) => entry.selfManagedAgents['research-agent']?.threadId === 'on-plan');
      expect(replays.length).toBeGreaterThan(0);
      for (const entry of replays) expect(entry.properties).toEqual({ model: 'plan', effort: 'medium', sandbox: true });
    });

    it("moving a replayed Session off another provider's model", async () => {
      service.sideChats = [sideChat('on-plan', 'On the plan')];
      service.replies.set('on-plan', [{ id: 'm1', role: 'user', content: 'On the plan' }]);
      service.providers.set('on-plan', 'openai');
      await renderPage();

      await userEvent.click(sidebar().getByText('On the plan'));

      expect(pill()).toHaveTextContent(/^PlanMedium$/);
      expect(kit().properties).toEqual({ model: 'plan', effort: 'medium', sandbox: true });
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
      expect(kit().properties).toEqual({ model: 'fast', effort: 'medium', sandbox: true });
    });

    it('again offering every model in a new chat', async () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
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

    expect(pill()).toHaveTextContent(/^Models could not load: Failed to load the models: 503Medium$/);
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

    expect(kit().properties).toEqual({ model: 'fast', effort: 'medium', sandbox: true });
    expect(pill()).toHaveTextContent(/^FastMedium$/);
    expect(checked()).toEqual(['Fast']);
  });

  it('picks an effort level', async () => {
    await renderPage();

    await userEvent.click(pill());
    await userEvent.click(within(openDropdown()).getByText('Effort'));
    expect([...openDropdown().querySelectorAll('.mep-option-name')].map((name) => name.textContent)).toEqual([
      'Effort',
      'Low',
      'Medium',
      'High',
      'Max',
    ]);
    expect(checked()).toEqual(['Medium']);
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
      expect(pill()).toHaveTextContent(`${picked}Medium`);

      service.models = [plan, ...service.models];
      await switchAccount(view, 'acct-linked');

      expect(kit().properties).toEqual({ model: expected, effort: 'medium', sandbox: true });
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

      expect(kit().properties).toEqual({ model: 'plan', effort: 'medium', sandbox: true });
      expect(pill()).toHaveTextContent(/^PlanMedium$/);
    });

    it('uses a later account default after the chosen model was replaced by an implicit fallback', async () => {
      const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
      await userEvent.click(pill());
      await userEvent.click(within(openDropdown()).getByText('Fast'));
      await userEvent.keyboard('{Escape}');
      service.models = [plan];
      await switchAccount(view, 'acct-linked');
      expect(kit().properties).toEqual({ model: 'plan', effort: 'medium', sandbox: true });
      service.models = [{ key: 'astra', label: 'Astra', provider: 'openai' }, plan];
      await switchAccount(view, 'acct-another');
      expect(kit().properties).toEqual({ model: 'astra', effort: 'medium', sandbox: true });
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
      expect(kit().properties).toEqual({ model: 'plan', effort: 'medium', sandbox: true });
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

      expect(pill()).toHaveTextContent(/^Loading models…Medium$/);
      const sideChatsBefore = sideChatLoads();
      await sendMessage('What is 2+2? One word.');
      expect(copilot.runAgent).not.toHaveBeenCalled();
      expect(sideChatLoads()).toBe(sideChatsBefore);
      expect(screen.getByRole('alert')).toHaveTextContent(/^Your models are still loading\. Send it again once they have\.$/);

      releaseModels();
      await settle();
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(kit().properties).toEqual({ model: 'plan', effort: 'medium', sandbox: true });
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
    ['no pick, then a link', 'acct-anonymous', 'acct-linked', false, { model: 'plan', effort: 'medium' }],
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

    expect(kit().properties).toEqual({ model: 'deep', effort: 'medium', sandbox: true });
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
  const proposal = { title: 'Morning brief', prompt: 'Brief me on rates', frequency: 'weekdays', time: '08:00' };
  const task = { title: 'Morning brief', prompt: 'Brief me on rates', schedule: 'cron(0 8 ? * MON-FRI *)' };
  const renderProposal = (result: unknown = 'Proposed. Nothing is scheduled until the user confirms it in the chat.') =>
    render(
      present(copilot.renderTool, 'the tool renderer')({
        name: 'propose_scheduled_task',
        toolCallId: 'call-1',
        status: 'complete',
        parameters: proposal,
        result,
      })
    );
  /** The Confirm button, once the card has checked the account's tasks for its proposal. */
  const confirmButton = async (container: HTMLElement) => {
    const button = within(container).getByRole('button', { name: 'Confirm' });
    await waitFor(() => expect(button).toBeEnabled());
    return button;
  };
  /** The card's one line saying how its task would run. */
  const words = (container: HTMLElement) => container.querySelector('.scheduled-task-schedule')?.textContent;

  // 5:00 AM UTC on Tuesday 6 October, so the card's first runs are known.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-10-06T05:00:00Z');
  });

  it("inherits the proposing thread's model instead of the account default", async () => {
    localStorage.setItem('botcube.picker-choice', JSON.stringify({ model: 'fast', account: 'acct-first' }));
    await renderPage(auth({ accountId: 'acct-first' }));
    expect(kit().properties).toMatchObject({ model: 'fast' });
    const { container } = renderProposal(JSON.stringify({ model: 'fast' }));

    await userEvent.click(await confirmButton(container));

    const [, init] = present(
      fetchMock.mock.calls.find(([url, sent]) => url === 'http://chat.test/scheduled-tasks' && sent?.method === 'POST'),
      'the confirmation'
    );
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ model: 'fast' });
  });

  it('keeps the recorded proposal model after the picker changes and the card is restored', async () => {
    localStorage.setItem('botcube.picker-choice', JSON.stringify({ model: 'fast', account: 'acct-first' }));
    await renderPage(auth({ accountId: 'acct-first' }));
    expect(kit().properties).toMatchObject({ model: 'fast' });
    const recorded = JSON.stringify({ model: 'fast' });
    const original = renderProposal(recorded);
    original.unmount();
    await userEvent.click(present(document.querySelector<HTMLElement>('.mep-pill'), 'the model picker'));
    await userEvent.click(within(present(document.querySelector<HTMLElement>('.mep-dropdown'), 'the dropdown')).getByText('Deep'));
    expect(kit().properties).toMatchObject({ model: 'deep' });
    const { container } = renderProposal(recorded);
    await userEvent.click(await confirmButton(container));
    const [, init] = present(fetchMock.mock.calls.find(([url, sent]) => url === 'http://chat.test/scheduled-tasks' && sent?.method === 'POST'), 'the confirmation');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ model: 'fast' });
  });

  it.each(['Error invoking tool', '{}', '{"model":null}', '{"model":""}', undefined])('refuses confirmation with invalid model provenance %s', async (result) => {
    await renderPage();
    const { container } = render(present(copilot.renderTool, 'the tool renderer')({ name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete', parameters: proposal, result }));
    expect(container).toHaveTextContent('This proposal has no schedule:');
    expect(within(container).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url, sent]) => url === 'http://chat.test/scheduled-tasks' && sent?.method === 'POST')).toBe(false);
  });

  it('shows a missing-timezone tool refusal without offering Confirm', async () => {
    await renderPage();
    const refusal = "Error invoking tool 'propose_scheduled_task' with error:\n timezone: Field required";
    const { container } = render(present(copilot.renderTool, 'the tool renderer')({
      name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete',
      parameters: proposal, result: refusal,
    }));

    expect(within(container).queryByRole('button', { name: 'Confirm' })).toBeNull();
    await userEvent.click(within(container).getByRole('button', { name: /Proposed a schedule/ }));
    expect(container).toHaveTextContent("Error invoking tool 'propose_scheduled_task'");
    expect(container).toHaveTextContent('timezone: Field required');
  });

  it('stays scheduled after a reload once the account holds the task its proposal made', async () => {
    service.scheduled = [{ id: 'task-1', ...task, timezone: 'America/New_York', paused: false, proposalId: 'call-1' }];
    await renderPage();
    const { container } = renderProposal();

    expect(await within(container).findByText('Scheduled. Manage it in the Scheduled tab.')).toBeInTheDocument();
    expect(within(container).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('http://chat.test/scheduled-tasks', { credentials: 'include', cache: 'no-store' });
  });

  it("offers Confirm when the account's tasks came from other proposals", async () => {
    service.scheduled = [{ id: 'task-1', ...task, timezone: 'America/New_York', paused: false, proposalId: 'call-0' }];
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
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await renderPage();
    const { container } = renderProposal();
    expect(container).toHaveTextContent('Morning brief');
    expect(container).toHaveTextContent('Brief me on rates');
    // The words its task's Edit form will show.
    expect(words(container)).toBe('Weekdays at 8:00 AM UTC');

    await userEvent.click(await confirmButton(container));

    const [url, init] = present(
      fetchMock.mock.calls.find(
        ([called, sent]) => called === 'http://chat.test/scheduled-tasks' && sent?.method === 'POST'
      ),
      'the confirmation'
    );
    expect(url).toBe('http://chat.test/scheduled-tasks');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ ...task, timezone: zone, proposalId: 'call-1' });
    expect(container).toHaveTextContent('Scheduled. Manage it in the Scheduled tab.');
    expect(within(container).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(container.querySelector('.agent-profile-error')).toBeNull();
  });

  it.each([
    ['UTC', 'UTC', '2026-10-14T12:08:00.000Z', '2026-10-14T12:24:00.000Z'],
    ['America/New_York', 'ET', '2026-10-14T16:08:00.000Z', '2026-10-14T16:24:00.000Z'],
    ['Asia/Tokyo', 'GMT+9', '2026-10-14T03:08:00.000Z', '2026-10-14T03:24:00.000Z'],
  ])('preserves explicit %s on the card and confirmed schedule', async (timezone, zone, startDate, endDate) => {
    await renderPage();
    const { container } = render(present(copilot.renderTool, 'the tool renderer')({
      name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete',
      parameters: { title: 'Hello', prompt: 'Say hello.', frequency: 'minutes', every: 5, timezone, starts: '2026-10-14T12:08', ends: '2026-10-14T12:24' },
      result: JSON.stringify({ model: 'fast' }),
    }));
    expect(words(container)).toBe(`Every 5 minutes, starts Oct 14, 12:08 PM, ends Oct 14, 12:24 PM ${zone}`);

    await userEvent.click(await confirmButton(container));

    const [, init] = present(fetchMock.mock.calls.find(([url, sent]) => url === 'http://chat.test/scheduled-tasks' && sent?.method === 'POST'), 'the confirmation');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      title: 'Hello', prompt: 'Say hello.', schedule: 'rate(5 minutes)', timezone, model: 'fast', startDate, endDate, proposalId: 'call-1',
    });
    expect(container).toHaveTextContent('Scheduled. Manage it in the Scheduled tab.');
  });

  it('refuses an explicit invalid timezone even without start or end fields', async () => {
    await renderPage();
    const { container } = render(present(copilot.renderTool, 'the tool renderer')({
      name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete',
      parameters: { ...proposal, timezone: 'Mars/Olympus' }, result: 'Proposed.',
    }));

    expect(container).toHaveTextContent('This proposal has no schedule:');
    expect(within(container).queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it.each([
    // A rate first runs a period after it is confirmed.
    [{ frequency: 'minutes', every: 1 }, 'rate(1 minute)', 'Every minute from 5:01 AM UTC'],
    [{ frequency: 'hours', every: 2 }, 'rate(2 hours)', 'Every 2 hours from 7:00 AM UTC'],
    [{ frequency: 'daily', time: '18:30' }, 'cron(30 18 * * ? *)', 'Daily at 6:30 PM UTC'],
    // The Harness takes an unused field sent as null.
    [{ frequency: 'weekdays', time: '08:00', every: null, days: null }, 'cron(0 8 ? * MON-FRI *)', 'Weekdays at 8:00 AM UTC'],
    [{ frequency: 'weekly', time: '07:05', days: ['THU', 'MON'] }, 'cron(5 7 ? * MON,THU *)', 'Weekly on Monday and Thursday at 7:05 AM UTC'],
    [{ frequency: 'once', date: '2026-11-06', time: '08:30' }, 'at(2026-11-06T08:30:00)', 'Once on Nov 6, 8:30 AM UTC'],
    [{ frequency: 'daily', time: '18:30', date: null, ends: null }, 'cron(30 18 * * ? *)', 'Daily at 6:30 PM UTC'],
    // A proposal made before proposals carried the Edit form's fields.
    [{ schedule: 'cron(0 8 ? * MON-FRI *)' }, 'cron(0 8 ? * MON-FRI *)', 'Weekdays at 8:00 AM UTC'],
  ])('schedules a proposal of %j as %s', async (fields, schedule, summary) => {
    await renderPage();
    const { container } = render(
      present(copilot.renderTool, 'the tool renderer')({
        name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete', parameters: { title: 'Brief', prompt: 'Brief me', ...fields }, result: 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
      })
    );
    expect(words(container)).toBe(summary);

    await userEvent.click(await confirmButton(container));

    expect(JSON.parse(present(fetchMock.mock.calls.find(([url, sent]) => url === 'http://chat.test/scheduled-tasks' && sent?.method === 'POST'), 'the confirmation')[1]?.body as string)).toMatchObject({ schedule });
  });

  it.each([
    [{ frequency: 'weekly', time: '08:00' }, 'a weekly task needs its days'],
    [{ frequency: 'weekly', time: '08:00', days: ['MONDAY'] }, 'a weekly task needs its days'],
    [{ frequency: 'daily', time: '8am' }, 'a daily task needs a time as HH:MM'],
    [{ frequency: 'once', time: '08:00' }, 'a once task needs a date as YYYY-MM-DD'],
    [{ frequency: 'daily', time: '08:00', ends: 'Friday' }, 'a stop time needs a date and time as YYYY-MM-DDTHH:MM'],
    // The Harness refuses a field its frequency doesn't take, so the card does too.
    [{ frequency: 'weekdays', time: '08:00', days: ['MON'] }, 'days is not allowed for weekdays'],
    [{ frequency: 'hours', every: 2, time: '08:00' }, 'time is not allowed for hours'],
    [{ frequency: 'daily', time: '08:00', every: 1 }, 'every is not allowed for daily'],
    [{ frequency: 'daily', time: '08:00', date: '2026-11-06' }, 'date is not allowed for daily'],
    [{ frequency: 'once', date: '2026-11-06', time: '08:00', ends: '2026-12-31T17:00' }, 'ends is not allowed for once'],
    [{ frequency: 'once', date: '2026-11-06', time: '08:00', starts: '2026-12-31T17:00' }, 'starts is not allowed for once'],
  ])('says why a proposal of %j makes no schedule, and offers no Confirm', async (fields, why) => {
    await renderPage();
    const { container } = render(
      present(copilot.renderTool, 'the tool renderer')({
        name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete', parameters: { title: 'Brief', prompt: 'Brief me', ...fields }, result: 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
      })
    );

    expect(await within(container).findByText(`This proposal has no schedule: ${why}`)).toBeInTheDocument();
    expect(within(container).queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  // The agent can propose a stop time; the card says it in plain words and sends it as an instant.
  it('says when a proposed task stops, and schedules it to stop then in the browser timezone', async () => {
    await renderPage();
    const { container } = render(
      present(copilot.renderTool, 'the tool renderer')({
        name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete', parameters: { ...proposal, ends: '2026-12-31T17:00' }, result: 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
      })
    );

    expect(words(container)).toBe('Weekdays at 8:00 AM, ends Dec 31, 5:00 PM UTC');
    await userEvent.click(await confirmButton(container));

    expect(JSON.parse(present(fetchMock.mock.calls.find(([url, sent]) => url === 'http://chat.test/scheduled-tasks' && sent?.method === 'POST'), 'the confirmation')[1]?.body as string))
      .toEqual({ ...task, timezone: 'UTC', endDate: '2026-12-31T17:00:00.000Z', proposalId: 'call-1' });
  });

  it('carries a proposed future start through confirmation in the browser timezone', async () => {
    await renderPage();
    const { container } = render(present(copilot.renderTool, 'the tool renderer')({
      name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete',
      parameters: { ...proposal, starts: '2099-12-01T09:30', ends: '2099-12-31T17:00' }, result: 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
    }));
    expect(words(container)).toBe('Weekdays at 8:00 AM, starts Dec 1, 2099, 9:30 AM, ends Dec 31, 2099, 5:00 PM UTC');
    await userEvent.click(await confirmButton(container));
    expect(JSON.parse(present(fetchMock.mock.calls.find(([url, sent]) => url === 'http://chat.test/scheduled-tasks' && sent?.method === 'POST'), 'the confirmation')[1]?.body as string))
      .toEqual({ ...task, timezone: 'UTC', startDate: '2099-12-01T09:30:00.000Z', endDate: '2099-12-31T17:00:00.000Z', proposalId: 'call-1' });
  });

  it('refuses confirmation of an obsolete counted proposal without sending a request', async () => {
    await renderPage();
    const { container } = render(
      present(copilot.renderTool, 'the tool renderer')({
        name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete', parameters: { ...proposal, count: 3 }, result: 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
      })
    );

    // Tuesday's, Wednesday's and Thursday's runs.
    expect(words(container)).toBe('Weekdays at 8:00 AM, ends Oct 8, 8:00 AM UTC');
    await userEvent.click(await confirmButton(container));

    expect(container).toHaveTextContent('This proposal uses a run count. Ask the agent for start and end times.');
    expect(fetchMock.mock.calls.some(([url, sent]) => url === 'http://chat.test/scheduled-tasks' && sent?.method === 'POST')).toBe(false);
  });

  it.each([
    [{ frequency: 'daily', time: '08:00' }, 'Daily at 8:00 AM, 1000000000 runs UTC'],
    [{ schedule: 'rate(1 day)', ends: '2026-10-07T12:00' }, 'Every 24 hours, ends Oct 7, 12:00 PM UTC, up to 1000000000 runs'],
  ])('renders a large counted proposal with fields %j', async (fields, expected) => {
    await renderPage();
    const { container } = render(
      present(copilot.renderTool, 'the tool renderer')({
        name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete', parameters: { title: 'Brief', prompt: 'Brief me', ...fields, count: 1_000_000_000 }, result: JSON.stringify({ model: 'fast' }),
      })
    );
    expect(words(container)).toBe(expected);
    expect(await confirmButton(container)).toBeEnabled();
  });

  it.each([
    ['2026-10-06T07:00', 'Weekdays at 8:00 AM, ends 7:00 AM UTC'],
    ['2026-10-07T12:00', 'Weekdays at 8:00 AM, ends Oct 7, 12:00 PM UTC'],
    ['2026-10-09T12:00', 'Weekdays at 8:00 AM, ends Oct 8, 8:00 AM UTC'],
  ])('shows the earlier ending when a proposal has a count and stop time %s', async (ends, expected) => {
    await renderPage();
    const { container } = render(
      present(copilot.renderTool, 'the tool renderer')({
        name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete', parameters: { ...proposal, count: 3, ends }, result: JSON.stringify({ model: 'fast' }),
      })
    );
    expect(words(container)).toBe(expected);
    await userEvent.click(await confirmButton(container));
    expect(container).toHaveTextContent('This proposal uses a run count. Ask the agent for start and end times.');
    expect(fetchMock.mock.calls.some(([url, sent]) => url === 'http://chat.test/scheduled-tasks' && sent?.method === 'POST')).toBe(false);
  });

  // A one-off task leaves the account once it has run, so its card must not offer to schedule it again.
  it('offers no Confirm for a one-off proposal whose time has passed', async () => {
    await renderPage();
    const { container } = render(
      present(copilot.renderTool, 'the tool renderer')({
        name: 'propose_scheduled_task', toolCallId: 'call-1', status: 'complete', parameters: { title: 'Brief', prompt: 'Brief me', frequency: 'once', date: '2020-01-02', time: '08:30' }, result: 'Proposed. Nothing is scheduled until the user confirms it in the chat.',
      })
    );

    expect(await within(container).findByText('Its time has passed.')).toBeInTheDocument();
    expect(words(container)).toBe('Once on Jan 2, 2020, 8:30 AM UTC');
    expect(within(container).queryByRole('button', { name: 'Confirm' })).toBeNull();
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
    expect(row.container).toHaveTextContent(/^Running$/);

    await act(async () => {
      current.abortRun();
      await turn;
    });
    expect(fetchMock).toHaveBeenCalledWith(`http://chat.test/threads/${current.threadId}/stop`, expect.objectContaining({ method: 'POST' }));
    expect(current.isRunning).toBe(false);
    row.rerender(present(copilot.renderTool, 'the tool renderer')({ name: 'execute', toolCallId: 'inner-execute', status: 'inProgress', parameters: {} }));
    expect(row.container).toHaveTextContent(/^Stopped · Ran$/);
    expect(current.messages).toContainEqual({ id: 'completed-result', role: 'tool', toolCallId: 'completed', content: 'Logged in.' });

    await act(async () => {
      current.addMessage({ id: 'followup-question', role: 'user', content: 'Reply with just OK.' });
      await current.runAgent({ runId: 'followup-run' });
    });
    row.rerender(present(copilot.renderTool, 'the tool renderer')({ name: 'execute', toolCallId: 'inner-execute', status: 'inProgress', parameters: {} }));
    expect(row.container).toHaveTextContent(/^Stopped · Ran$/);
    row.rerender(present(copilot.renderTool, 'the tool renderer')({ name: 'execute', toolCallId: 'inner-execute', status: 'complete', parameters: {}, result: 'Late actual output.' }));
    expect(row.container).not.toHaveTextContent('Stopped');
    expect(row.getByRole('button', { name: 'Ran' })).toBeInTheDocument();
    expect(current.messages.at(-1)).toMatchObject({ id: 'followup', role: 'assistant', content: 'OK' });
  });

  it.each(['inProgress', 'executing'])('shows an %s tool call as running', async (status) => {
    await renderPage();

    const { container } = renderToolCall({ status });

    expect(container).toHaveTextContent(/^Running$/);
  });

  it('summarizes a tool call by its command', async () => {
    await renderPage();

    const { container } = renderToolCall({ status: 'executing', parameters: { limit: 5, command: 'ls -la', cwd: '/tmp' } });

    expect(container).toHaveTextContent(/^Runningls -la$/);
  });

  it.each([
    ['no parameters', undefined],
    ['empty parameters', {}],
    ['no text argument', { limit: 5 }],
  ])('shows no summary for %s', async (_case, parameters) => {
    await renderPage();

    const { container } = renderToolCall({ status: 'executing', parameters });

    expect(container).toHaveTextContent(/^Running$/);
  });

  it('shows a finished tool call result when expanded', async () => {
    await renderPage();

    const { container } = renderToolCall({ status: 'complete', result: '{"ok": true}' });
    expect(container).toHaveTextContent(/^Ran$/);
    await userEvent.click(within(container).getByRole('button'));

    expect(container.querySelector('pre')).toHaveTextContent('{"ok": true}');
  });

  it.each([
    ['failed', 'Command failed: open. Exit code: 1\n[Command failed with exit code 1]', 'lucide-circle-x', 'lucide-square-terminal'],
    ['failed and was truncated', 'partial\n[Command failed with exit code 126]\n[Output was truncated due to size limits]', 'lucide-circle-x', 'lucide-square-terminal'],
    ['succeeded', 'ok\n[Command succeeded with exit code 0]', 'lucide-square-terminal', 'lucide-circle-x'],
    ['succeeded after quoting a failure', 'log\n[Command failed with exit code 1]\n[Command succeeded with exit code 0]', 'lucide-square-terminal', 'lucide-circle-x'],
  ])('marks a command that %s by its exit code trailer', async (_case, result, shown, hidden) => {
    await renderPage();

    const { container } = renderToolCall({ status: 'complete', result });

    expect(container.querySelector(`.${shown}`)).not.toBeNull();
    expect(container.querySelector(`.${hidden}`)).toBeNull();
    expect(container).toHaveTextContent(/^Ran$/);
  });

  it.each([
    ['a running tool call', 'executing', '{"ok": true}'],
    ['a finished tool call without a result', 'complete', undefined],
  ])('shows no result for %s, its row nothing to open', async (_case, status, result) => {
    await renderPage();

    const { container } = renderToolCall({ status, result });

    expect(within(container).queryByRole('button')).toBeNull();
    expect(container.querySelector('.worklog-step-detail')).toBeNull();
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
    await userEvent.click(within(present(sidebar().getByText('Old chat').parentElement, 'old item')).getByLabelText('Delete side chat'));
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
    await userEvent.click(sidebar().getByLabelText('Delete side chat'));
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
    await userEvent.click(within(present(sidebar().getByText('Old chat').parentElement, 'old item')).getByLabelText('Delete side chat'));
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
    await userEvent.click(within(present(sidebar().getByText('Old chat').parentElement, 'old item')).getByLabelText('Delete side chat'));
    await userEvent.click(sidebar().getByText('Next chat'));
    await act(async () => { present(deletes[0], 'delete response')(answer(204)); });
    await act(async () => { present(replays[0], 'replay response')(answer(status, { messages: [] })); });
    await settle();
    expect(copilot.chat?.threadId).toBe(status === 200 ? 'next' : 'new-1');
    await openSidebar();
    if (status === 503) expect(sidebar().getByRole('alert')).toHaveTextContent('Next chat could not be opened');
    else expect(sidebar().queryByRole('alert')).toBeNull();
  });
});

describe('an Agent Profile draft across account changes', () => {
  async function editSoul() {
    await userEvent.click(screen.getByRole('button', { name: 'Agent profile' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Personalization' }));
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
    await userEvent.click(screen.getByRole('tab', { name: 'Personalization' }));
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
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
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
    expect(copilot.openingTurn).not.toHaveBeenCalled();
  });

  it('locks the provider after an online first Turn', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
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
    expect(copilot.openingTurn).not.toHaveBeenCalled();
  });

  it('submits Retry with the newly selected Astra provider', async () => {
    await renderPage();
    const submittedProperties: Record<string, unknown>[] = [];
    copilot.runAgent.mockImplementation(() => submittedProperties.push({ ...kit().properties }));
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await sendMessage('Create one reminder');
    await openModels();
    await userEvent.click(screen.getByText('Astra'));
    expect(kit().properties).toEqual({ model: 'astra', effort: 'medium', sandbox: true });
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(submittedProperties).toEqual([{ model: 'astra', effort: 'medium', sandbox: true }]);
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
    expect(kit().properties).toEqual({ model: 'fast', effort: 'medium', sandbox: true });
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
    await userEvent.click(sidebar().getByLabelText('Delete side chat'));
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

// Last in the file: it reloads the page module with the chat surface's chunk held, so the module registry it leaves
// behind reaches no page another test rendered.
it('shows a kept markdown reply formatted, not as raw markdown, while the chat surface loads', async () => {
  vi.resetModules();
  vi.doMock('./chat-surface', () => new Promise(() => {}));
  try {
    const { default: LoadingPage } = await import('./page');
    const reply = '## Rates recap\n\nThe **10y** closed at **4.12%**.\n\n| Tenor | Close |\n| --- | --- |\n| 10y | 4.12% |';
    localStorage.setItem(KEY, JSON.stringify({
      accountId: 'acct-first',
      id: 'main-1',
      provider: 'openai',
      messages: [{ id: 'm1', role: 'user', content: 'Where did rates close?' }, { id: 'm2', role: 'assistant', content: reply }],
    }));
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === 'http://chat.test/main-chat' ? new Promise<Response>(() => {}) : chatService(url, init),
    );
    cartridge.auth = auth({ accountId: 'acct-first' });
    render(<LoadingPage />);
    await settle();
    const loading = screen.getByRole('status', { name: 'Loading chat controls' });
    expect(loading).toHaveTextContent('Rates recap');
    expect(loading.textContent).not.toMatch(/\*\*|##|\|/);
  } finally {
    vi.doUnmock('./chat-surface');
  }
});

// A + attaches files to the agent's Files, and the message names them for the agent.
describe('attaching files', () => {
  const uploads: { name: string; resolve: (path: string) => void; reject: (error: Error) => void }[] = [];
  beforeEach(async () => {
    uploads.length = 0;
    vi.spyOn(agentFiles, 'upload').mockImplementation((file) => new Promise((resolve, reject) => {
      uploads.push({ name: file.name, resolve, reject });
    }));
  });
  const chips = () => [...document.querySelectorAll('.copilotKitInput .composer-file')].map((chip) => chip.textContent);
  const attach = async (...names: string[]) => {
    const picker = present(document.querySelector<HTMLInputElement>('input[type="file"]'), 'the file picker');
    await userEvent.upload(picker, names.map((name) => new File(['data'], name)));
    expect(picker.value).toBe('');
  };

  it.each(['click', 'Enter'])('sends an uploaded image without filler text using %s', async (method) => {
    await renderPage();
    await attach('screenshot.png');
    await act(async () => uploads[0]?.resolve('/screenshot.png'));
    const input = screen.getByRole('textbox', { name: 'Message' });
    expect(input).toHaveValue('');
    if (method === 'click') await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    else await userEvent.type(input, '{Enter}');
    expect(agent().messages.at(-1)?.content).toBe('\n\nAttached files:\n- /screenshot.png');
    expect(chips()).toEqual([]);
  });

  it.each([
    { name: 'Add photos', icon: 'svg.lucide-paperclip', accept: 'image/*' },
    { name: 'Add files', icon: 'svg.lucide-file-plus-corner', accept: '' },
  ])('shows the + whose menu has Add photos and Add files; $name opens a multi-file picker for $accept', async ({ name, icon, accept }) => {
    await renderPage();
    const add = screen.getByRole('button', { name: 'Add photos & files' });
    const picker = present(document.querySelector<HTMLInputElement>('input[type="file"]'), 'the file picker');
    picker.accept = 'stale';
    let opensFor: string | undefined;
    const opened = vi.spyOn(picker, 'click').mockImplementation(() => {
      opensFor = picker.accept;
    });

    await userEvent.click(add);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Add photos', 'Add files']);
    const item = within(menu).getByRole('menuitem', { name });
    expect(item.querySelector(icon)).not.toBeNull();
    await userEvent.click(item);

    expect(add).toHaveAttribute('data-testid', 'copilot-add-menu-button');
    // CopilotKit's slash menu names its add command by this label.
    expect(copilot.chat?.labels).toMatchObject({ chatInputToolbarAddButtonLabel: 'Add photos & files' });
    expect(picker.multiple).toBe(true);
    expect(opened).toHaveBeenCalledOnce();
    expect(opensFor).toBe(accept);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('closes the + menu on Escape, back on the +', async () => {
    await renderPage();
    const add = screen.getByRole('button', { name: 'Add photos & files' });

    await userEvent.click(add);
    await screen.findByRole('menu');
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(add).toHaveFocus();
  });

  it('holds the message while a file uploads or has failed, then sends it naming the files by their paths', async () => {
    copilot.rows = true;
    await renderPage();
    await attach('report.csv', 'notes.md');
    expect(chips()).toEqual(['report.csvUploading… 0%', 'notes.mdUploading… 0%']);

    await sendMessage('Summarise these');
    expect(agent().messages).toEqual([]);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await act(async () => {
      uploads[0]?.resolve('/report.csv');
      uploads[1]?.reject(new Error('Upload failed: 403'));
    });
    expect(chips()).toEqual(['report.csvCSV', 'notes.mdUpload failed: 403Retry']);
    await sendMessage('Summarise these');
    expect(agent().messages).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => uploads[2]?.resolve('/notes (1).md'));
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
    await sendMessage('Summarise these');

    expect(agent().messages).toEqual([
      { id: 'submitted', role: 'user', content: 'Summarise these\n\nAttached files:\n- /report.csv\n- /notes (1).md' },
    ]);
    expect(chips()).toEqual([]);
    const sent = present(document.querySelector('.copilotKitUserMessage'), 'the sent message');
    expect([...sent.querySelectorAll('.sent-file')].map((card) => card.textContent)).toEqual(['report.csvCSV', 'notes (1).mdMD']);
    expect(sent.querySelector('[class*="cpk:prose"]')).toHaveTextContent(/^Summarise these$/);
  });

  it("shows a reloaded message's files as cards, and the bubble only what the user typed", async () => {
    copilot.rows = true;
    service.mainChat = { id: 'main-1', messages: [{ id: 'u1', role: 'user', content: 'check this\n\nAttached files:\n- /AI_Trends_2026.pdf' }] };
    await renderPage();

    const sent = present(document.querySelector<HTMLElement>('.copilotKitUserMessage'), 'the reloaded message');
    expect(within(sent).getByRole('list', { name: 'Attached files' })).toHaveTextContent(/^AI_Trends_2026\.pdfPDF$/);
    expect(sent.querySelector('[class*="cpk:prose"]')).toHaveTextContent(/^check this$/);
    expect(sent).not.toHaveTextContent('Attached files:');
  });

  it('clears uploaded chips when a follow-up queues, keeping their paths in that queued message only', async () => {
    service.mainChat = { id: 'main-1', messages: [], running: true, runId: 'server-run' };
    await renderPage(auth({ accountId: 'acct-first' }));
    await attach('report.csv');
    await act(async () => uploads[0]?.resolve('/report.csv'));
    await sendMessage('Summarise this');

    const queuedMessage = () => screen.getByRole('status', { name: 'Queued message' });
    expect(within(queuedMessage()).getByRole('list', { name: 'Attached files' })).toHaveTextContent(/^report\.csvCSV$/);
    expect(queuedMessage().querySelector('.chat-queued-bubble')).toHaveTextContent(/^Summarise this$/);
    expect(chips()).toEqual([]);
    await sendMessage('Then explain');
    // A follow-up joins the held one's text; its files stay one block at the end, still shown as cards.
    expect(queuedMessage().querySelector('.chat-queued-bubble')?.textContent).toBe('Summarise this\n\nThen explain');
    expect(within(queuedMessage()).getByRole('list', { name: 'Attached files' })).toHaveTextContent(/^report\.csvCSV$/);
    const stored = localStorage.getItem('botcube.queued-follow-ups:acct-first');
    expect(stored && JSON.parse(stored)['main-1']).toBe('Summarise this\n\nThen explain\n\nAttached files:\n- /report.csv');
  });

  it('keeps uploaded chips for an offline send, then clears them when Retry sends their paths', async () => {
    await renderPage();
    await attach('report.csv');
    await act(async () => uploads[0]?.resolve('/report.csv'));
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await sendMessage('Summarise this');
    expect(chips()).toEqual(['report.csvCSV']);
    online.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(agent().messages.at(-1)?.content).toBe('Summarise this\n\nAttached files:\n- /report.csv');
    expect(chips()).toEqual([]);
  });

  it('leaves a removed upload out when an offline message is retried', async () => {
    await renderPage();
    await attach('report.csv');
    await act(async () => uploads[0]?.resolve('/report.csv'));
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await sendMessage('Summarise this');
    await userEvent.click(screen.getByRole('button', { name: 'Remove report.csv' }));
    online.mockReturnValue(true);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(agent().messages.at(-1)?.content).toBe('Summarise this');
    expect(chips()).toEqual([]);
  });

  it('clears uploads when sign-in changes the account while the running chat remains mounted', async () => {
    const view = await renderPage(auth({ accountId: 'acct-anonymous' }));
    await attach('report.csv');
    await act(async () => uploads[0]?.resolve('/report.csv'));
    const current = agent();
    copilot.running = true;
    current.isRunning = true;
    cartridge.auth = auth({ accountId: 'acct-linked' });
    view.rerender(<Page />);
    await settle();

    expect(agent()).toBe(current);
    expect(chips()).toEqual([]);
  });

  it('drops a removed file from the message', async () => {
    await renderPage();
    await attach('report.csv');
    await userEvent.click(screen.getByRole('button', { name: 'Remove report.csv' }));

    expect(chips()).toEqual([]);
    await sendMessage('Hello');
    expect(agent().messages).toEqual([{ id: 'submitted', role: 'user', content: 'Hello' }]);
  });
});


describe('agent opening Turn', () => {
  it('passes the first name shown by the welcome screen without needing a provider profile', async () => {
    await renderPage(auth({ user: { name: 'Ada Lovelace' } }));
    expect(copilot.openingTurn).toHaveBeenCalledExactlyOnceWith({
      agent: agent(), forwardedProps: { opening: true, openingFirstName: 'Ada' },
    });
  });

  it('runs once on an empty authoritative replay with the selected model and no user message', async () => {
    await renderPage();
    expect(copilot.openingTurn).toHaveBeenCalledExactlyOnceWith({ agent: agent(), forwardedProps: { opening: true } });
    expect(agent().messages).toEqual([]);
    expect(copilot.kits.at(-1)?.properties).toMatchObject({ model: 'deep' });
    await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
    await settle();
    expect(copilot.openingTurn).toHaveBeenCalledTimes(1);
  });

  it('does not greet a populated replay', async () => {
    service.mainChat.messages = [{ id: 'old', role: 'assistant', content: 'Already here' }];
    await renderPage();
    expect(copilot.openingTurn).not.toHaveBeenCalled();
  });

  it('surfaces a failed opening without automatically dispatching it again', async () => {
    copilot.openingTurn.mockImplementation(() => Promise.reject(new Error('Opening dispatch failed')));
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('The agent could not answer: Opening dispatch failed');
    await settle();
    expect(copilot.openingTurn).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'failed', 'models unavailable'] as const)('does not open when %s', async (state) => {
    if (state === 'running') service.mainChat = { id: 'main-1', messages: [], running: true, runId: 'server-1' };
    if (state === 'failed') service.mainChat = { id: 'main-1', messages: [], failure: { code: 'TURN_FAILED', message: 'Previous failed', runId: 'failed-1' } };
    if (state === 'models unavailable') service.models = [];
    await renderPage();
    expect(copilot.openingTurn).not.toHaveBeenCalled();
  });

  it('starts while the opening warmup is still pending', async () => {
    let finish: (() => void) | undefined;
    fetchMock.mockImplementation((url, init) => url === 'http://chat.test/warmup'
      ? new Promise<Response>((resolve) => { finish = () => resolve(answer(204)); })
      : chatService(url, init));
    await renderPage();
    expect(copilot.openingTurn).toHaveBeenCalledExactlyOnceWith({ agent: agent(), forwardedProps: { opening: true } });
    await act(async () => { finish?.(); });
    expect(copilot.openingTurn).toHaveBeenCalledTimes(1);
  });

  it('surfaces a synchronous dispatch failure and allows a normal user message afterward', async () => {
    copilot.openingTurn.mockImplementation(() => { throw new Error('Not registered'); });
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('The agent could not answer: Not registered');
    await sendMessage('Hello');
    expect(copilot.runAgent).toHaveBeenCalledExactlyOnceWith({ agent: agent() });
  });


  it('waits for authoritative replay before replacing an empty browser copy', async () => {
    localStorage.setItem(KEY, JSON.stringify({ accountId: 'acct-first', id: 'main-1', messages: [] }));
    let replay: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation((url, init) => url === 'http://chat.test/main-chat'
      ? new Promise<Response>((resolve) => { replay = resolve; }) : chatService(url, init));
    await renderPage(auth({ accountId: 'acct-first' }));
    expect(copilot.openingTurn).not.toHaveBeenCalled();
    await act(async () => { present(replay, 'the authoritative replay')(answer(200, { id: 'main-1', messages: [], running: true, runId: 'accepted-opening' })); });
    await settle();
    expect(copilot.openingTurn).not.toHaveBeenCalled();
  });

  it('waits for the new account catalog and never uses its previous model', async () => {
    const view = await renderPage(auth({ accountId: 'acct-first' }));
    expect(copilot.openingTurn).toHaveBeenCalledTimes(1);
    let release: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation((url, init) => url === 'http://chat.test/agent/models'
      ? new Promise<Response>((resolve) => { release = resolve; }) : chatService(url, init));
    service.mainChat = { id: 'main-second', messages: [] };
    cartridge.auth = auth({ accountId: 'acct-second' });
    view.rerender(<Page />);
    await settle();
    expect(copilot.openingTurn).toHaveBeenCalledTimes(1);
    await act(async () => { present(release, 'the account models')(answer(200, { models: [{ key: 'astra', label: 'Astra', provider: 'openai' }] })); });
    await settle();
    expect(copilot.openingTurn).toHaveBeenCalledTimes(2);
    expect(copilot.openingTurn).toHaveBeenLastCalledWith({ agent: agent(), forwardedProps: { opening: true } });
    expect(kit().properties).toMatchObject({ model: 'astra' });
  });

});


describe('opening admission navigation regressions', () => {
  it.each(['running', 'failed'] as const)('reloads the Side Chat URL with no message while its opening is %s', async (state) => {
    let rejectOpening: ((error: Error) => void) | undefined;
    copilot.openingTurn.mockImplementation(({ agent: openingAgent }) => openingAgent?.threadId === 'new-1'
      ? new Promise<void>((_resolve, reject) => { rejectOpening = reject; }) : undefined);
    const view = await renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'New side chat' }));
    await settle();
    expect(agent().threadId).toBe('new-1');
    expect(agent().messages).toEqual([]);
    expect(window.location.search).toBe('?chat=new-1');
    if (state === 'failed') {
      await act(async () => { present(rejectOpening, 'the pending opening')(new Error('Model service unavailable')); });
      expect(screen.getByRole('alert')).toHaveTextContent('Model service unavailable');
    }
    expect(window.location.search).toBe('?chat=new-1');
    view.unmount();
    fetchMock.mockImplementation((url, init) => url === 'http://chat.test/threads/new-1'
      ? Promise.resolve(answer(200, { provider: 'anthropic', messages: [], running: state === 'running',
        ...(state === 'failed' ? { failure: { runId: 'opening-side', code: 'UPSTREAM_FAILURE', message: 'Model service unavailable' } } : {}) }))
      : chatService(url, init));
    await renderPage();
    expect(agent().threadId).toBe('new-1');
    expect(window.location.search).toBe('?chat=new-1');
    if (state === 'failed') expect(screen.getByRole('alert')).toHaveTextContent('Model service unavailable');
    else expect(screen.queryByRole('alert')).toBeNull();
    expect(copilot.openingTurn).toHaveBeenCalledTimes(2);
  });

  it('retains the opening provider while a different provider is chosen before the first reply', async () => {
    service.models.push({ key: 'astra', label: 'Astra', provider: 'openai' });
    let finishOpening: (() => void) | undefined;
    copilot.openingTurn.mockImplementation(() => new Promise<void>((resolve) => { finishOpening = resolve; }));
    await renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Model Deep/ }));
    const otherProvider = screen.queryByRole('button', { name: 'Astra' });
    if (otherProvider !== null) await userEvent.click(otherProvider);
    expect(kit().properties.model).toBe('deep');
    expect(screen.queryByRole('button', { name: 'Astra' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await act(async () => {
      agent().addMessage({ id: 'opening-reply', role: 'assistant', content: 'Hi Ada' });
      present(finishOpening, 'the opening Turn')();
    });
    await sendMessage('What do you remember?');
    expect(kit().properties.model).toBe('deep');
    expect(copilot.runAgent).toHaveBeenCalledExactlyOnceWith({ agent: agent() });
    await userEvent.click(screen.getByRole('button', { name: /Model Deep/ }));
    expect(screen.queryByRole('button', { name: 'Astra' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Fast' })).toBeVisible();
  });
});
