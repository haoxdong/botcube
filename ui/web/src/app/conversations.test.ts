// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayTurn } from '../../../../chat/src/turn-stream.js';

import {
  buildDirectAgent,
  ChatServiceError,
  credentialsIncludingFetch,
  deleteConversation,
  fetchMainChat,
  fetchAgentModels,
  ModelCatalogError,
  fetchSideChats,
  openConversation,
  toolCancellationStore,
  stoppedHere,
} from './conversations';

/** No test here expects a Stop to fail. */
const unexpectedStopFailure = (error: Error) => {
  throw error;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const SERVICE = 'http://localhost:8123';

/** A fetch that answers every request with `response` and records what was asked. */
function recordingFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number) => () => new Response(null, { status: code });

describe('credentialsIncludingFetch', () => {
  it('forces cross-origin agent requests to include account cookies', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = async (_url: string, requestInit: RequestInit) => {
      calls.push(requestInit);
      return new Response(null, { status: 204 });
    };

    await credentialsIncludingFetch(fetchImpl)('http://localhost:8123/', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    });
  });
});

describe('Chat Service requests', () => {
  it('lists the Side Chats with account cookies, uncached', async () => {
    const { calls, fetchImpl } = recordingFetch(json({ threads: [] }));

    await fetchSideChats({ chatServiceUrl: SERVICE, fetchImpl });

    expect(calls).toEqual([
      { url: `${SERVICE}/threads`, init: { cache: 'no-store', credentials: 'include' } },
    ]);
  });

  it('opens the Main Chat with its messages', async () => {
    const mainChat = { id: 'main-1', messages: [{ id: 'm1', role: 'user', content: 'Hello' }] };
    const { calls, fetchImpl } = recordingFetch(json(mainChat));

    expect(await fetchMainChat({ chatServiceUrl: SERVICE, fetchImpl })).toEqual(mainChat);
    expect(calls).toEqual([
      { url: `${SERVICE}/main-chat`, init: { cache: 'no-store', credentials: 'include' } },
    ]);
  });

  it('replays a conversation with account cookies', async () => {
    const replayed = [
      { id: 'message-1', role: 'user', content: 'Hello' },
      { id: 'message-2', role: 'assistant', content: 'Hi' },
    ];
    const { calls, fetchImpl } = recordingFetch(json({ id: 'thread-42', provider: 'openai', messages: replayed }));

    expect(await openConversation({ id: 'thread-42', chatServiceUrl: SERVICE, fetchImpl })).toMatchObject({
      provider: 'openai',
      messages: replayed,
    });
    expect(calls).toEqual([
      { url: `${SERVICE}/threads/thread-42`, init: { cache: 'no-store', credentials: 'include' } },
    ]);
  });

  it('deletes a conversation', async () => {
    const { calls, fetchImpl } = recordingFetch(status(204));

    await deleteConversation({ id: 'thread-42', chatServiceUrl: SERVICE, fetchImpl });

    expect(calls).toEqual([
      {
        url: `${SERVICE}/threads/thread-42`,
        init: { cache: 'no-store', credentials: 'include', method: 'DELETE' },
      },
    ]);
  });

  it.each([
    ['listing threads', () => fetchSideChats({ chatServiceUrl: SERVICE, fetchImpl: recordingFetch(status(503)).fetchImpl }), 'Failed to fetch threads: 503'],
    ['opening the Main Chat', () => fetchMainChat({ chatServiceUrl: SERVICE, fetchImpl: recordingFetch(status(503)).fetchImpl }), 'Failed to open the Main Chat: 503'],
    ['replaying a thread', () => openConversation({ id: 't', chatServiceUrl: SERVICE, fetchImpl: recordingFetch(status(502)).fetchImpl }), 'Failed to replay thread: 502'],
    ['deleting a thread', () => deleteConversation({ id: 't', chatServiceUrl: SERVICE, fetchImpl: recordingFetch(status(409)).fetchImpl }), 'Failed to delete thread: 409'],
  ])('fails loudly when %s fails', async (_case, request, message) => {
    await expect(request()).rejects.toThrow(message);
  });
});

describe('Side Chat listing', () => {
  it('keeps only threads with an id and titles untitled ones, in the order listed', async () => {
    const { fetchImpl } = recordingFetch(json({
      threads: [
        { id: 'no-update', title: 'Never updated', updated_at: null },
        { title: 'No id', updated_at: '2026-07-10T10:09:00.000Z' },
        { id: '', title: 'Empty id', updated_at: '2026-07-10T10:09:00.000Z' },
        { id: 7, title: 'Numeric id', updated_at: '2026-07-10T10:09:00.000Z' },
        { id: 'blank-title', title: '', created_at: 5, updated_at: '2026-07-10T10:01:00.000Z' },
        { id: 'numeric-title', title: 42, created_at: '2026-07-10T10:00:00.000Z', updated_at: '2026-07-10T10:02:00.000Z' },
      ],
    }));

    expect(await fetchSideChats({ chatServiceUrl: SERVICE, fetchImpl })).toEqual([
      { id: 'no-update', title: 'Never updated', created_at: null, updated_at: null },
      { id: 'blank-title', title: 'Untitled conversation', created_at: null, updated_at: '2026-07-10T10:01:00.000Z' },
      { id: 'numeric-title', title: 'Untitled conversation', created_at: '2026-07-10T10:00:00.000Z', updated_at: '2026-07-10T10:02:00.000Z' },
    ]);
  });
});

describe('direct agent saved messages', () => {
  it('keeps messages that arrived before CopilotChat connects', async () => {
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure,
      chatServiceUrl: 'http://localhost:8123',
      threadId: 'saved-thread',
      messages: [{ id: 'm1', role: 'user', content: 'Saved question' }],
    });
    agent.addMessage({ id: 'm2', role: 'user', content: 'New question' });

    await agent.connectAgent();

    expect(agent.messages).toEqual([
      { id: 'm1', role: 'user', content: 'Saved question' },
      { id: 'm2', role: 'user', content: 'New question' },
    ]);
  });

  it('reports no message change when connecting a new conversation', async () => {
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: 'http://localhost:8123', threadId: 'new-thread', messages: [] });
    const onMessagesChanged = vi.fn();
    agent.subscribe({ onMessagesChanged });

    await agent.connectAgent();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onMessagesChanged).not.toHaveBeenCalled();
  });
});

describe('a view that subscribes during a Turn', () => {
  const responseFor = (events: object[]) => relayTurn({ label: 'Test upstream', invoke: async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  }) }, {
    body: '{}', sessionId: 't1', accept: 'text/event-stream', browserEventName: 'test:live', credentials: [], saveAgentDocumentEdit: async () => undefined, finished: () => undefined, ended: async () => undefined, failed: () => undefined,
  });
  it.each([
    ['unfinished message', [], true],
    ['ended message without finished Turn', [{ type: 'TEXT_MESSAGE_END', messageId: 'a1' }], true],
    ['finished Turn', [{ type: 'TEXT_MESSAGE_END', messageId: 'a1' }, { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }], false],
    ['explicit failed Turn', [{ type: 'RUN_ERROR', message: 'The provider failed', code: 'PROVIDER_ERROR' }], true],
  ])('reports the interactive outcome for %s', async (_case, terminal, fails) => {
    const events = [
      { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'Only half the answer' },
      ...terminal,
    ];
    const fetchImpl = async () => responseFor(events);
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl });
    const onRunFailed = vi.fn();
    const onRunErrorEvent = vi.fn();
    agent.subscribe({ onRunFailed, onRunErrorEvent });

    await agent.runAgent().catch(() => undefined);

    expect(agent.messages).toMatchObject([{ id: 'a1', content: 'Only half the answer' }]);
    expect(onRunFailed.mock.calls.length + onRunErrorEvent.mock.calls.length > 0).toBe(fails);
    expect(onRunErrorEvent).toHaveBeenCalledTimes(fails ? 1 : 0);
  });

  it('can finish the next explicit Turn on the same client after an incomplete response', async () => {
    let requests = 0;
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl: async () => {
      ++requests;
      return responseFor([
        { type: 'RUN_STARTED', threadId: 't1', runId: `r${requests}` },
        { type: 'TEXT_MESSAGE_START', messageId: `a${requests}`, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: `a${requests}`, delta: requests === 1 ? 'Partial answer' : 'Complete next answer' },
        ...(requests === 2 ? [{ type: 'TEXT_MESSAGE_END', messageId: 'a2' }, { type: 'RUN_FINISHED', threadId: 't1', runId: 'r2' }] : []),
      ]);
    } });
    const onRunErrorEvent = vi.fn();
    const onRunFinishedEvent = vi.fn();
    agent.subscribe({ onRunErrorEvent, onRunFinishedEvent });

    await agent.runAgent().catch(() => undefined);
    expect(onRunErrorEvent).toHaveBeenCalledOnce();
    expect(onRunFinishedEvent).not.toHaveBeenCalled();
    expect(requests).toBe(1);
    expect(agent.isRunning).toBe(false);
    await agent.runAgent();

    expect(onRunFinishedEvent).toHaveBeenCalledOnce();
    expect(onRunErrorEvent).toHaveBeenCalledOnce();
    expect(requests).toBe(2);
    expect(agent.messages).toMatchObject([{ id: 'a1', content: 'Partial answer' }, { id: 'a2', content: 'Complete next answer' }]);
  });

  /** A Chat Service whose Turn has started and streams nothing more until the client aborts it, as a browser fetch does. */
  function openTurn() {
    let streaming!: () => void;
    const started = new Promise<void>((resolve) => (streaming = resolve));
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (_url.endsWith('/stop')) return new Response(null, { status: 204 });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const { runId } = JSON.parse(init?.body as string) as { runId: string };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 't1', runId })}\n\n`));
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('The user aborted a request.', 'AbortError')),
          );
        },
      });
      streaming();
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    return { started, fetchImpl };
  }

  it('hears the Turn end when Stop aborts it', async () => {
    const { started, fetchImpl } = openTurn();
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl });
    const turn = agent.runAgent();
    await started;
    const onRunFinalized = vi.fn();
    agent.subscribe({ onRunFinalized });

    agent.abortRun();
    await turn;

    await vi.waitFor(() => expect(onRunFinalized).toHaveBeenCalledOnce());
  });

  it('hears no more of the Turn once it unsubscribes', async () => {
    const { started, fetchImpl } = openTurn();
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl });
    const turn = agent.runAgent();
    await started;
    const onRunFinalized = vi.fn();
    agent.subscribe({ onRunFinalized }).unsubscribe();
    const witness = vi.fn();
    agent.subscribe({ onRunFinalized: witness });

    agent.abortRun();
    await turn;

    await vi.waitFor(() => expect(witness).toHaveBeenCalledOnce());
    expect(onRunFinalized).not.toHaveBeenCalled();
  });
});

describe('a Stop', () => {
  /** A Chat Service whose Turn streams until the client aborts it, answering a stop with `stopStatus`. */
  function stoppableTurn(stopReplies: readonly (number | Error | Promise<number>)[], admitted = true) {
    const stops: { url: string; body: unknown }[] = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let aborted = false;
    let currentRunId = 'r1';
    let runs = 0;
    let streaming!: () => void;
    const started = new Promise<void>((resolve) => (streaming = resolve));
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/stop')) {
        stops.push({ url, body: JSON.parse(init?.body as string) });
        const reply = stopReplies[Math.min(stops.length - 1, stopReplies.length - 1)];
        if (reply instanceof Error) throw reply;
        const stopStatus = await reply;
        if (stopStatus === undefined) throw new Error('The test Chat Service has no stop reply');
        return new Response(null, { status: stopStatus });
      }
      currentRunId = (JSON.parse(init?.body as string) as { runId: string }).runId;
      runs += 1;
      aborted = false;
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
          if (admitted) admit();
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            controller.error(new DOMException('The user aborted a request.', 'AbortError'));
          });
        },
      });
      streaming();
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const admit = (runId = currentRunId) => {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 't1', runId })}\n\n`));
    };
    const finish = () => {
      if (aborted) return;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: 't1', runId: currentRunId })}\n\n`));
      controller.close();
    };
    const emit = (event: object) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    const fail = (code: string) => { emit({ type: 'RUN_ERROR', code, message: 'The Turn ended.' }); controller.close(); };
    return { stops, started, fetchImpl, finish, admit, emit, fail, wasAborted: () => aborted, runCount: () => runs };
  }

  it.each([false, true])('marks only unfinished current calls when TURN_STOPPED arrives, local Stop %s', async (localStop) => {
    let acknowledge!: (status: number) => void;
    const acknowledgement = new Promise<number>((resolve) => { acknowledge = resolve; });
    const service = stoppableTurn([acknowledgement]);
    const prior = { id: 'prior', role: 'assistant' as const, toolCalls: [{ id: 'prior-call', type: 'function' as const, function: { name: 'task', arguments: '{}' } }] };
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: SERVICE, threadId: 't1', messages: [prior], fetchImpl: service.fetchImpl });
    const store = toolCancellationStore(agent);
    const changed = vi.fn();
    const unsubscribe = store.subscribe(changed);
    const run = agent.runAgent({ runId: 'r1' });
    await service.started;
    service.emit({ type: 'TOOL_CALL_START', toolCallId: 'done', toolCallName: 'execute', parentMessageId: 'done-message' });
    service.emit({ type: 'TOOL_CALL_END', toolCallId: 'done' });
    service.emit({ type: 'TOOL_CALL_RESULT', toolCallId: 'done', messageId: 'done-result', role: 'tool', content: 'Actual output.' });
    service.emit({ type: 'TOOL_CALL_START', toolCallId: 'pending', toolCallName: 'execute', parentMessageId: 'pending-message' });
    service.emit({ type: 'TOOL_CALL_ARGS', toolCallId: 'pending', delta: '{"command":"partial' });
    await vi.waitFor(() => expect(agent.messages).toContainEqual(expect.objectContaining({ id: 'pending-message' })));
    const messages = structuredClone(agent.messages);
    if (localStop) {
      agent.abortRun();
      await vi.waitFor(() => expect(service.stops).toHaveLength(1));
    }
    expect(stoppedHere(agent)).toBe(localStop);
    service.fail('TURN_STOPPED');
    await run;
    expect([...store.getSnapshot()]).toEqual(['pending']);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(agent.messages).toEqual(messages);
    const snapshot = store.getSnapshot();
    const next = agent.runAgent({ runId: 'r2' });
    await vi.waitFor(() => expect(service.runCount()).toBe(2));
    acknowledge(204);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.wasAborted()).toBe(false);
    expect(store.getSnapshot()).toBe(snapshot);
    service.finish();
    await next;
    expect([...store.getSnapshot()]).toEqual(['pending']);
    unsubscribe();
  });

  it('publishes no stopped calls for a refused Stop or ordinary run failure', async () => {
    const service = stoppableTurn([502]);
    const onStopFailed = vi.fn();
    const agent = buildDirectAgent({ onStopFailed, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl: service.fetchImpl });
    const run = agent.runAgent({ runId: 'r1' });
    await service.started;
    service.emit({ type: 'TOOL_CALL_START', toolCallId: 'pending', toolCallName: 'task', parentMessageId: 'pending-message' });
    await vi.waitFor(() => expect(agent.messages).toContainEqual(expect.objectContaining({ id: 'pending-message' })));
    agent.abortRun();
    await vi.waitFor(() => expect(onStopFailed).toHaveBeenCalledOnce());
    expect([...toolCancellationStore(agent).getSnapshot()]).toEqual([]);
    expect(agent.isRunning).toBe(true);
    service.fail('UPSTREAM_ERROR');
    await run;
    expect([...toolCancellationStore(agent).getSnapshot()]).toEqual([]);
  });

  it('retains an early Stop until the Turn is admitted', async () => {
    const { stops, started, fetchImpl, admit, finish, wasAborted } = stoppableTurn([204], false);
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl });
    const turn = agent.runAgent({ runId: 'r1' });
    await started;
    try {
      agent.abortRun();
      await new Promise((resolve) => setImmediate(resolve));
      expect(stops).toEqual([]);
      expect(wasAborted()).toBe(false);
      admit();
      await turn;
      expect(stops).toEqual([{ url: `${SERVICE}/threads/t1/stop`, body: { runId: 'r1' } }]);
    } finally {
      finish();
      await turn;
    }
  });

  // A closed stream no longer stops a Turn, so a Stop sends the Chat Service the Turn's run ID.
  it('asks the Chat Service to stop the running Turn', async () => {
    const { stops, started, fetchImpl } = stoppableTurn([204]);
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl });
    const turn = agent.runAgent({ runId: 'r1' });
    await started;

    agent.abortRun();
    await turn;

    await vi.waitFor(() => expect(stops).toEqual([{ url: `${SERVICE}/threads/t1/stop`, body: { runId: 'r1' } }]));
  });

  it.each([
    ['a server refusal', 502, new ChatServiceError('stop the Turn', 502)],
    ['a network failure', new TypeError('network error'), new TypeError('network error')],
  ])('keeps the Turn running and lets Stop retry after %s', async (_label, refusal, failure) => {
    const { stops, started, fetchImpl, finish } = stoppableTurn([refusal, 204]);
    const onStopFailed = vi.fn();
    const agent = buildDirectAgent({ onStopFailed, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl });
    const turn = agent.runAgent({ runId: 'r1' });
    await started;

    try {
      agent.abortRun();
      await vi.waitFor(() => expect(onStopFailed).toHaveBeenCalledWith(failure));
      expect(agent.isRunning).toBe(true);
      agent.abortRun();
      await turn;
      expect(stops).toEqual([
        { url: `${SERVICE}/threads/t1/stop`, body: { runId: 'r1' } },
        { url: `${SERVICE}/threads/t1/stop`, body: { runId: 'r1' } },
      ]);
      expect(agent.isRunning).toBe(false);
    } finally {
      finish();
      await turn;
    }
  });

  it('keeps the stream and Stop control until the server accepts Stop', async () => {
    let accept!: (status: number) => void;
    const acknowledgement = new Promise<number>((resolve) => { accept = resolve; });
    const { stops, started, fetchImpl, finish, wasAborted } = stoppableTurn([acknowledgement]);
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl });
    const turn = agent.runAgent({ runId: 'r1' });
    await started;
    try {
      agent.abortRun();
      await vi.waitFor(() => expect(stops).toHaveLength(1));
      expect(wasAborted()).toBe(false);
      expect(agent.isRunning).toBe(true);
      accept(204);
      await turn;
      expect(agent.isRunning).toBe(false);
    } finally {
      accept(204);
      finish();
      await turn;
    }
  });

  it('sends one Stop while its acknowledgement is pending', async () => {
    let accept!: (status: number) => void;
    const acknowledgement = new Promise<number>((resolve) => { accept = resolve; });
    const { stops, started, fetchImpl, finish } = stoppableTurn([acknowledgement]);
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl });
    const turn = agent.runAgent({ runId: 'r1' });
    await started;
    try {
      agent.abortRun();
      await vi.waitFor(() => expect(stops).toHaveLength(1));
      agent.abortRun();
      await new Promise((resolve) => setImmediate(resolve));
      expect(stops).toHaveLength(1);
      accept(204);
      await turn;
    } finally {
      accept(204);
      finish();
      await turn;
    }
  });

  it('ignores an older Stop failure after a newer Turn starts', async () => {
    let refuse!: (status: number) => void;
    const acknowledgement = new Promise<number>((resolve) => { refuse = resolve; });
    const { stops, started, fetchImpl, finish, runCount } = stoppableTurn([acknowledgement]);
    const onStopFailed = vi.fn();
    const agent = buildDirectAgent({ onStopFailed, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl });
    const first = agent.runAgent({ runId: 'r1' });
    await started;
    agent.abortRun();
    await vi.waitFor(() => expect(stops).toHaveLength(1));
    finish();
    await first;
    const second = agent.runAgent({ runId: 'r2' });
    try {
      await vi.waitFor(() => expect(runCount()).toBe(2));
      refuse(502);
      await new Promise((resolve) => setImmediate(resolve));
      expect(onStopFailed).not.toHaveBeenCalled();
      expect(agent.isRunning).toBe(true);
    } finally {
      refuse(502);
      finish();
      await second;
    }
  });

  it('does not abort a newer Turn when an older Stop acknowledgement arrives', async () => {
    let accept!: (status: number) => void;
    const acknowledgement = new Promise<number>((resolve) => { accept = resolve; });
    const { stops, started, fetchImpl, finish, wasAborted, runCount } = stoppableTurn([acknowledgement]);
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl });
    const first = agent.runAgent({ runId: 'r1' });
    await started;
    agent.abortRun();
    await vi.waitFor(() => expect(stops).toHaveLength(1));
    finish();
    await first;
    const second = agent.runAgent({ runId: 'r2' });
    try {
      await vi.waitFor(() => expect(runCount()).toBe(2));
      accept(204);
      await new Promise((resolve) => setImmediate(resolve));
      expect(wasAborted()).toBe(false);
      expect(agent.isRunning).toBe(true);
    } finally {
      accept(204);
      finish();
      await second;
    }
  });

  it('asks nothing when no Turn runs', async () => {
    const { stops, fetchImpl } = stoppableTurn([204]);
    const agent = buildDirectAgent({ onStopFailed: unexpectedStopFailure, chatServiceUrl: SERVICE, threadId: 't1', messages: [], fetchImpl });

    agent.abortRun();
    await Promise.resolve();

    expect(stops).toEqual([]);
  });
});


describe('model catalog refusals', () => {
  it.each([502, 503])('retains HTTP %s and its cause with explicit Cartridge choices', async (status) => {
    const choices = [{ key: 'quick', label: 'Quick', provider: 'anthropic' }];
    const failure = await fetchAgentModels({ chatServiceUrl: SERVICE, fetchImpl: async () =>
      Response.json({ detail: 'Plan Usage was revoked', cartridgeModels: choices }, { status }),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelCatalogError);
    expect((failure as ModelCatalogError).message).toBe(`Failed to load the models: ${status}: Plan Usage was revoked`);
    expect((failure as ModelCatalogError).cartridgeModels).toEqual([{ key: 'quick', label: 'Quick', provider: 'anthropic' }]);
  });

  it('keeps an unauthenticated refusal separate from catalog choices', async () => {
    await expect(fetchAgentModels({ chatServiceUrl: SERVICE, fetchImpl: async () =>
      Response.json({ detail: 'Sign in first' }, { status: 401 }),
    })).rejects.toThrow('Failed to load the models: 401');
  });

  it('classifies an unreadable catalog refusal instead of turning it into a model list', async () => {
    await expect(fetchAgentModels({ chatServiceUrl: SERVICE, fetchImpl: async () =>
      new Response('invalid JSON', { status: 503 }),
    })).rejects.toThrow('Failed to load the models: 503: invalid catalog error response');
  });
});
