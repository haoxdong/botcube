// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayTurn } from '../../../../chat/src/turn-stream.js';

import {
  buildDirectAgent,
  ChatServiceError,
  credentialsIncludingFetch,
  createSideChat,
  deleteConversation,
  fetchMainChat,
  fetchAgentModels,
  ModelCatalogError,
  fetchChatList,
  openConversation,
  toolCancellationStore,
  stoppedHere,
} from './conversations';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SERVICE = 'http://localhost:8123';

const directAgent = (options: Partial<Parameters<typeof buildDirectAgent>[0]>) =>
  buildDirectAgent({ onStopFailed: (error) => { throw error; }, chatServiceUrl: SERVICE, threadId: 't1', messages: [], ...options });

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
  it('allocates a Side Chat with account cookies and no client-chosen ID', async () => {
    const { calls, fetchImpl } = recordingFetch(json({ id: 'server-issued' }));
    expect(await createSideChat({ chatServiceUrl: SERVICE, fetchImpl })).toEqual({ id: 'server-issued' });
    expect(calls).toEqual([
      { url: `${SERVICE}/threads`, init: { method: 'POST', cache: 'no-store', credentials: 'include' } },
    ]);
  });

  it('lists the Side Chats with account cookies, uncached', async () => {
    const { calls, fetchImpl } = recordingFetch(json({ threads: [] }));

    await fetchChatList({ chatServiceUrl: SERVICE, fetchImpl });

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

  describe('a call the running Turn still makes', () => {
    // The thread read of a Turn mid-tool, as production answered it: the checkpoint saver answers every call without a
    // result on load, the running one included.
    const call = { id: 'call-1', type: 'function', function: { name: 'execute', arguments: '{"command":"sleep 45"}' } };
    const placeholder = { id: 'None', role: 'tool', content: "Tool call 'execute' with id 'call-1' was interrupted before completion.", toolCallId: 'call-1', error: 'error' };
    const earlier = [
      { id: 'u0', role: 'user', content: 'Before' },
      { id: 'a0', role: 'assistant', content: '', toolCalls: [{ ...call, id: 'call-0' }] },
      { id: 't0', role: 'tool', content: "Tool call 'execute' with id 'call-0' was interrupted before completion.", toolCallId: 'call-0', error: 'error' },
    ];
    const turn = [...earlier, { id: 'u1', role: 'user', content: 'Run sleep 45' }, { id: 'a1', role: 'assistant', content: '', toolCalls: [call] }];

    it.each([
      ['the Main Chat', (fetchImpl: typeof fetch) => fetchMainChat({ chatServiceUrl: SERVICE, fetchImpl })],
      ['a Side Chat', (fetchImpl: typeof fetch) => openConversation({ id: 'thread-42', chatServiceUrl: SERVICE, fetchImpl })],
    ])('%s replays it unanswered while the Turn runs, so its step still runs', async (_chat, open) => {
      const { fetchImpl } = recordingFetch(json({ id: 'thread-42', running: true, runId: 'run-1', messages: [...turn, placeholder] }));

      expect((await open(fetchImpl)).messages).toEqual(turn);
    });

    it('keeps the answer of a call an earlier Turn cut when no question is on record, as after a scheduled run', async () => {
      const messages = [earlier[1], earlier[2], { id: 'a2', role: 'assistant', content: 'Next', toolCalls: [call] }];
      const { fetchImpl } = recordingFetch(json({ id: 'thread-42', running: true, messages: [...messages, placeholder] }));

      expect((await openConversation({ id: 'thread-42', chatServiceUrl: SERVICE, fetchImpl })).messages).toEqual(messages);
    });

    it('keeps the answer of a call a stopped Turn cut', async () => {
      const messages = [...turn, placeholder];
      const { fetchImpl } = recordingFetch(json({ id: 'thread-42', messages }));

      expect((await openConversation({ id: 'thread-42', chatServiceUrl: SERVICE, fetchImpl })).messages).toEqual(messages);
    });
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
    ['listing threads', () => fetchChatList({ chatServiceUrl: SERVICE, fetchImpl: recordingFetch(status(503)).fetchImpl }), 'Failed to fetch threads: 503'],
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

    expect((await fetchChatList({ chatServiceUrl: SERVICE, fetchImpl })).threads).toEqual([
      { id: 'no-update', title: 'Never updated', created_at: null, updated_at: null },
      { id: 'blank-title', title: 'Untitled conversation', created_at: null, updated_at: '2026-07-10T10:01:00.000Z' },
      { id: 'numeric-title', title: 'Untitled conversation', created_at: '2026-07-10T10:00:00.000Z', updated_at: '2026-07-10T10:02:00.000Z' },
    ]);
  });

  it("keeps a scheduled task's Side Chat marked as scheduled", async () => {
    const { fetchImpl } = recordingFetch(json({
      threads: [
        { id: 'task-1', title: 'Morning brief', scheduled: true },
        { id: 'topic', title: 'My topic' },
      ],
    }));

    expect((await fetchChatList({ chatServiceUrl: SERVICE, fetchImpl })).threads).toEqual([
      { id: 'task-1', title: 'Morning brief', created_at: null, updated_at: null, scheduled: true },
      { id: 'topic', title: 'My topic', created_at: null, updated_at: null },
    ]);
  });
});

it('sends a temporary chat its full browser context and capability without account cookies', async () => {
  const messages = [
    { id: 'q1', role: 'user' as const, content: 'First question' },
    { id: 'a1', role: 'assistant' as const, content: 'First answer' },
    { id: 'q2', role: 'user' as const, content: 'Follow up' },
  ];
  const { calls, fetchImpl } = recordingFetch(() => new Response([
    'data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}',
    'data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}',
  ].join('\n\n') + '\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const agent = directAgent({ messages, fetchImpl, temporaryChat: { sessionId: 't1', token: 'temporary-only' } });
  await agent.runAgent({ runId: 'r1' });
  expect(JSON.parse(calls[0]?.init?.body as string).messages).toEqual(messages);
  expect(new Headers(calls[0]?.init?.headers).get('x-botcube-temporary-chat')).toBe('temporary-only');
  expect(calls[0]?.init).toMatchObject({ credentials: 'omit', redirect: 'error' });
  expect(() => directAgent({ temporaryChat: { sessionId: 'another-chat', token: 'temporary-only' } })).toThrow('Temporary chat capability does not match the chat');
});

describe('direct agent saved messages', () => {
  it('keeps messages that arrived before CopilotChat connects', async () => {
    const agent = directAgent({
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

  it('keeps when each replayed step started and ended', async () => {
    const timed = { id: 'm2', role: 'assistant' as const, content: 'An answer', metadata: { started_at: 1791772208634, ended_at: 1791772209051 } };
    const agent = directAgent({
      threadId: 'timed-thread',
      messages: [{ id: 'm1', role: 'user', content: 'Saved question' }, timed],
    });

    await agent.connectAgent();

    expect(agent.messages[1]).toEqual(timed);
  });

  it('reports no message change when connecting a new conversation', async () => {
    const agent = directAgent({ threadId: 'new-thread' });
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
    body: '{}', sessionId: 't1', accept: 'text/event-stream', credentials: [], saveAgentDocumentEdit: async () => undefined, finished: () => undefined, ended: async () => undefined, failed: () => undefined,
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
    const agent = directAgent({ fetchImpl });
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
    const agent = directAgent({ fetchImpl: async () => {
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
    const agent = directAgent({ fetchImpl });
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
    const agent = directAgent({ fetchImpl });
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
    return { stops, started, fetchImpl, finish, admit, emit, fail, close: () => controller.close(), wasAborted: () => aborted, runCount: () => runs };
  }

  it('uses the temporary capability for Stop as well as the Turn', async () => {
    const service = stoppableTurn([204]);
    const requests: RequestInit[] = [];
    const agent = directAgent({ temporaryChat: { sessionId: 't1', token: 'temporary-only' }, fetchImpl: async (url, init) => {
      requests.push(init);
      return service.fetchImpl(url, init);
    } });
    const run = agent.runAgent({ runId: 'r1' });
    await service.started;
    agent.abortRun();
    await run;
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(new Headers(request.headers).get('x-botcube-temporary-chat')).toBe('temporary-only');
      expect(request).toMatchObject({ credentials: 'omit', redirect: 'error' });
    }
  });

  it.each([
    [false, '{"command":"partial'],
    [true, '{"command":"partial'],
    [true, '{"command":"complete but stopped"}'],
  ])('replays temporary context after an interrupted tool call, local Stop %s, arguments %s', async (localStop, args) => {
    const service = stoppableTurn([204]);
    const requests: RequestInit[] = [];
    const agent = directAgent({
      messages: [{ id: 'q1', role: 'user', content: 'Run the command' }],
      temporaryChat: { sessionId: 't1', token: 'temporary-only' },
      fetchImpl: async (url, init) => {
        if (!url.endsWith('/stop')) requests.push(init);
        return service.fetchImpl(url, init);
      },
    });
    const run = agent.runAgent({ runId: 'r1' });
    await service.started;
    service.emit({ type: 'TEXT_MESSAGE_START', messageId: 'answer', role: 'assistant' });
    service.emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'answer', delta: 'I will run it.' });
    service.emit({ type: 'TEXT_MESSAGE_END', messageId: 'answer' });
    service.emit({ type: 'TOOL_CALL_START', toolCallId: 'done', toolCallName: 'execute', parentMessageId: 'answer' });
    service.emit({ type: 'TOOL_CALL_ARGS', toolCallId: 'done', delta: '{"command":"finished"}' });
    service.emit({ type: 'TOOL_CALL_END', toolCallId: 'done' });
    service.emit({ type: 'TOOL_CALL_RESULT', toolCallId: 'done', messageId: 'result', role: 'tool', content: 'Actual output.' });
    service.emit({ type: 'TOOL_CALL_START', toolCallId: 'pending', toolCallName: 'execute', parentMessageId: 'answer' });
    service.emit({ type: 'TOOL_CALL_ARGS', toolCallId: 'pending', delta: args });
    service.emit({ type: 'TOOL_CALL_START', toolCallId: 'empty', toolCallName: 'execute', parentMessageId: 'empty-answer' });
    service.emit({ type: 'TOOL_CALL_ARGS', toolCallId: 'empty', delta: '{' });
    await vi.waitFor(() => expect(agent.messages).toContainEqual(expect.objectContaining({
      toolCalls: expect.arrayContaining([expect.objectContaining({ id: 'empty' })]),
    })));
    if (localStop) agent.abortRun();
    else service.fail('TURN_STOPPED');
    await run;
    const displayed = structuredClone(agent.messages);
    agent.addMessage({ id: 'q2', role: 'user', content: 'Continue' });
    const next = agent.runAgent({ runId: 'r2' });
    await vi.waitFor(() => expect(service.runCount()).toBe(2));
    service.finish();
    await next;
    const replay = JSON.parse(requests[1]?.body as string).messages;
    expect(replay).toEqual([
      { id: 'q1', role: 'user', content: 'Run the command' },
      { id: 'answer', role: 'assistant', content: 'I will run it.', toolCalls: [
        { id: 'done', type: 'function', function: { name: 'execute', arguments: '{"command":"finished"}' } },
      ] },
      { id: 'result', role: 'tool', toolCallId: 'done', content: 'Actual output.' },
      { id: 'q2', role: 'user', content: 'Continue' },
    ]);
    expect(agent.messages.slice(0, displayed.length)).toEqual(displayed);
  });

  it.each([false, true])('marks only unfinished current calls when TURN_STOPPED arrives, local Stop %s', async (localStop) => {
    let acknowledge!: (status: number) => void;
    const acknowledgement = new Promise<number>((resolve) => { acknowledge = resolve; });
    const service = stoppableTurn([acknowledgement]);
    const prior = { id: 'prior', role: 'assistant' as const, toolCalls: [{ id: 'prior-call', type: 'function' as const, function: { name: 'task', arguments: '{}' } }] };
    const agent = directAgent({ messages: [prior], fetchImpl: service.fetchImpl });
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

  it('ends cleanly when TURN_STOPPED streams in before the Stop is acknowledged', async () => {
    let acknowledge!: (status: number) => void;
    const service = stoppableTurn([new Promise<number>((resolve) => { acknowledge = resolve; })]);
    const agent = directAgent({ fetchImpl: service.fetchImpl });
    const onRunFailed = vi.fn();
    const run = agent.runAgent({ runId: 'r1' }, { onRunFailed });
    await service.started;
    agent.abortRun();
    await vi.waitFor(() => expect(service.stops).toHaveLength(1));

    service.emit({ type: 'RUN_ERROR', code: 'TURN_STOPPED', message: 'The Turn was stopped.' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    acknowledge(204);

    await expect(run).resolves.toBeDefined();
    expect(onRunFailed).not.toHaveBeenCalled();
    expect(service.wasAborted()).toBe(false);
  });

  // A subscriber still awaiting an earlier event holds the RUN_ERROR's subscribers back past the acknowledgement.
  it('ends cleanly when TURN_STOPPED streams in while a subscriber still handles an earlier event', async () => {
    let acknowledge!: (status: number) => void;
    const service = stoppableTurn([new Promise<number>((resolve) => { acknowledge = resolve; })]);
    const agent = directAgent({ fetchImpl: service.fetchImpl });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const onRunFailed = vi.fn();
    const run = agent.runAgent({ runId: 'r1' }, { onTextMessageStartEvent: () => held, onRunFailed });
    await service.started;
    agent.abortRun();
    await vi.waitFor(() => expect(service.stops).toHaveLength(1));

    service.emit({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' });
    service.emit({ type: 'RUN_ERROR', code: 'TURN_STOPPED', message: 'The Turn was stopped.' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    acknowledge(204);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();

    await expect(run).resolves.toBeDefined();
    expect(onRunFailed).not.toHaveBeenCalled();
    expect(service.wasAborted()).toBe(false);
  });

  it('publishes no stopped calls for a refused Stop or ordinary run failure', async () => {
    const service = stoppableTurn([502]);
    const onStopFailed = vi.fn();
    const agent = directAgent({ onStopFailed, fetchImpl: service.fetchImpl });
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
    const agent = directAgent({ fetchImpl });
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
    const agent = directAgent({ fetchImpl });
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
    const agent = directAgent({ onStopFailed, fetchImpl });
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
    const agent = directAgent({ fetchImpl });
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
    const agent = directAgent({ fetchImpl });
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
    const agent = directAgent({ onStopFailed, fetchImpl });
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
    const agent = directAgent({ fetchImpl });
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
    const agent = directAgent({ fetchImpl });

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


it('normalizes the Main Chat through the same list boundary as Side Chats', async () => {
  const { fetchImpl } = recordingFetch(json({ threads: [], mainChat: { id: 'main-1', title: '', created_at: 5, turn_completed_at: '2026-10-24T09:30:00.000Z' } }));
  expect(await fetchChatList({ chatServiceUrl: SERVICE, fetchImpl })).toEqual({
    threads: [], mainChat: { id: 'main-1', title: 'Untitled conversation', created_at: null, updated_at: null, turn_completed_at: '2026-10-24T09:30:00.000Z' },
  });
});
