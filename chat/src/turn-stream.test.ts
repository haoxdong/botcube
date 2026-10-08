import { ActivityDeltaEventSchema, RunStartedEventSchema, ToolCallArgsEventSchema } from '@ag-ui/core/schemas';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { persistedTurnError, relayTurn, stopTurn, turnCredentialGuard, turnCredentials } from './turn-stream.js';
import { recordTurnSummary } from './turn-summaries.js';
import type { Upstream } from './upstream.js';
import { defined } from '../test/defined.js';

const encoder = new TextEncoder();

describe('persisted Turn refusal reasons', () => {
  it('preserves the exact UTF-8 limit without truncation', () => {
    const message = '😀'.repeat(4096);
    expect(persistedTurnError(message)).toBe(message);
    expect(encoder.encode(persistedTurnError(message)).byteLength).toBe(16384);
  });

  it('retains complete Unicode characters and a truncation marker within the limit', () => {
    const message = '😀'.repeat(4097);
    expect(persistedTurnError(message)).toBe(`${'😀'.repeat(4095)}…`);
    expect(encoder.encode(persistedTurnError(message)).byteLength).toBe(16383);
  });
});

const incomplete = 'data: {"type":"RUN_ERROR","message":"Test upstream stream ended before the Turn finished","code":"AGENTCORE_UPSTREAM_STREAM_ERROR"}\n\n';

type Step = string | Uint8Array | { error: unknown };

/** An upstream body that yields each step on its own read: a chunk, or a failure. */
function streamOf(steps: Step[]): ReadableStream<Uint8Array> {
  const queue = [...steps];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const step = queue.shift();
      if (step === undefined) controller.close();
      else if (typeof step === 'string') controller.enqueue(encoder.encode(step));
      else if (step instanceof Uint8Array) controller.enqueue(step);
      else controller.error(step.error);
    },
  });
}

function fakeUpstream(respond: () => Response) {
  const calls: Parameters<Upstream['invoke']>[] = [];
  const upstream: Upstream = {
    label: 'Test upstream',
    async invoke(...args) {
      calls.push(args);
      return respond();
    },
  };
  return { upstream, calls };
}

/** Once every pending callback has run. */
const settled = () => new Promise<void>((resolve) => { setImmediate(resolve); });

const sse = (body: ReadableStream<Uint8Array>) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

const turn = {
  body: '{"messages":[]}',
  sessionId: 'session-1',
  accept: 'text/event-stream',
  browserEventName: 'test:live',
  saveAgentDocumentEdit: async () => undefined,
  credentials: [],
  finished: () => undefined,
  ended: async () => undefined,
  failed: () => undefined,
};

const relay = (steps: Step[]) => relayTurn(fakeUpstream(() => sse(streamOf(steps))).upstream, turn);

describe('RUN_STARTED metadata failure', () => {
  it.each([false, true])('preserves its classified frame and original cause when end cleanup failure is %s', async (cleanupFails) => {
    const original = new Error('start metadata unavailable');
    const cleanup = new Error('end metadata unavailable');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ended = vi.fn(async () => { if (cleanupFails) throw cleanup; });
    const failed = vi.fn();
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(['data: {"type":"RUN_STARTED"}\n\n']))).upstream, {
      ...turn, started: async () => { throw original; }, ended, failed,
    });
    const reader = defined(response.body, 'the classified error stream').getReader();
    try {
      const first = await reader.read();
      const frame = new TextDecoder().decode(first.value);
      expect(frame).toContain('"code":"TURN_START_FAILED"');
      expect(frame).toContain('start metadata unavailable');
      expect(frame).not.toContain('RUN_FINISHED');
      if (cleanupFails) {
        const rejection = await reader.read().catch((error: unknown) => error);
        expect(rejection).toBeInstanceOf(AggregateError);
        expect((rejection as AggregateError).errors).toEqual([original, cleanup]);
      } else {
        expect((await reader.read()).done).toBe(true);
      }
      expect(failed).toHaveBeenCalledWith("The Turn's start could not be recorded: Error: start metadata unavailable");
      expect(ended).toHaveBeenCalledOnce();
      expect(logged).toHaveBeenCalledWith("The Turn's start could not be recorded session_id=session-1", original);
      if (cleanupFails) expect(logged).toHaveBeenCalledWith("The Turn's end could not be recorded session_id=session-1", cleanup);
    } finally { reader.releaseLock(); logged.mockRestore(); }
  });
});

describe('complete SSE fields and credential URLs', () => {
  it('preserves a safe multiline SSE data field', async () => {
    const frame = 'data: {"type":"TEXT_MESSAGE_CONTENT",\ndata: "messageId":"m1","delta":"safe answer"}\n\n';
    expect(await (await relay([frame])).text()).toBe(frame + incomplete);
  });

  it('checks an escaped credential in a multiline SSE data field', async () => {
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([
      'data: {"type":"STATE_SNAPSHOT","snapshot":{"token":\ndata: "\\u0070rivate-token"}}\n\n',
    ]))).upstream, { ...turn, credentials: ['private-token'] });
    expect(await response.text()).toContain('TURN_CREDENTIALS_IN_STREAM');
  });

  it.each([
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'open ws://chat.internal:8123/agent-computer/cdp?token=%70rivate-cdp-token' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"command":"open ws://chat.internal:8123/agent-computer/cdp?token=%70rivate-cdp-token"}' },
  ])('withholds a usable percent-encoded CDP URL in $type', async (event) => {
    const credentials = turnCredentials({ agentComputerCdpUrl: 'ws://chat.internal:8123/agent-computer/cdp?token=private-cdp-token' }, ['agentComputerCdpUrl']);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([`data: ${JSON.stringify(event)}\n\n`]))).upstream, { ...turn, credentials });
    const body = await response.text();
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain('%70rivate-cdp-token');
  });

  it.each([
    ['TEXT_MESSAGE_CONTENT', 'open ', '%70rivate-', 'cdp-token'],
    ['TOOL_CALL_ARGS', '{"command":"open ', '%70rivate-', 'cdp-token"}'],
    ['TEXT_MESSAGE_CONTENT', 'open ', '%7', '0rivate-cdp-token'],
  ])('withholds a percent-encoded CDP URL split across %s deltas', async (type, before, first, last) => {
    const url = 'ws://chat.internal:8123/agent-computer/cdp?token=';
    const credentials = turnCredentials({ agentComputerCdpUrl: `${url}private-cdp-token` }, ['agentComputerCdpUrl']);
    const identity = type === 'TOOL_CALL_ARGS' ? { toolCallId: 't1' } : { messageId: 'm1' };
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([
      `data: ${JSON.stringify({ type, ...identity, delta: before + url + first })}\n\n`,
      `data: ${JSON.stringify({ type, ...identity, delta: last })}\n\n`,
    ]))).upstream, { ...turn, credentials });
    const body = await response.text();
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain(first);
  });

  it('withholds an embedded encoded CDP URL in a plain-text HTTP refusal', async () => {
    const credentials = turnCredentials({ agentComputerCdpUrl: 'ws://chat.internal:8123/agent-computer/cdp?token=private-cdp-token' }, ['agentComputerCdpUrl']);
    const response = await relayTurn(fakeUpstream(() => new Response('failed to open ws://chat.internal:8123/agent-computer/cdp?token=%70rivate-cdp-token', { status: 503 })).upstream, { ...turn, credentials });
    expect((await response.json()).details).toBe("The error body carried the Turn's credentials, so it was withheld");
    expect(consoleWarn.mock.calls.flat().join('\n')).not.toContain('%70rivate-cdp-token');
  });
});

describe('multipart message text', () => {
  it.each(['RUN_STARTED', 'MESSAGES_SNAPSHOT', 'TOOL_CALL_RESULT'])('withholds adjacent text parts in %s', async (type) => {
    const messages = [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'private-' }, { type: 'text', text: 'token' }] }];
    const event = type === 'TOOL_CALL_RESULT' ? { type, toolCallId: 'tool', messageId: 'result', content: messages[0]?.content } : type === 'MESSAGES_SNAPSHOT' ? { type, messages } : { type, threadId: 't', runId: 'r', input: { threadId: 't', runId: 'r', messages, tools: [], context: [], state: {}, forwardedProps: {} } };
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([`data: ${JSON.stringify(event)}\n\n`]))).upstream, { ...turn, credentials: ['private-token'] });
    expect(await response.text()).toContain('TURN_CREDENTIALS_IN_STREAM');
  });
  it('withholds multipart CDP text whose rendered newline URL retains a usable token', async () => {
    const parts = ['ws://computer.internal/cdp?token=private-', 'token'];
    expect(new URL(parts.join('\n')).searchParams.get('token')).toBe('private-token');
    const event = { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u', role: 'user', content: parts.map((text) => ({ type: 'text', text })) }] };
    const credentials = turnCredentials({ cdpUrl: 'ws://computer.internal/cdp?token=private-token' }, ['cdpUrl']);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([`data: ${JSON.stringify(event)}\n\n`]))).upstream, { ...turn, credentials });
    expect(await response.text()).toContain('TURN_CREDENTIALS_IN_STREAM');
  });
  it('preserves a valid binary part between text fragments', async () => {
    const event = { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'private-' }, { type: 'binary', mimeType: 'image/png', data: 'AA==' }, { type: 'text', text: 'token' }] }] };
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    expect(await (await relayTurn(fakeUpstream(() => sse(streamOf([frame]))).upstream, { ...turn, credentials: ['private-token'] })).text()).toBe(frame + incomplete);
  });
  it('allows safe adjacent multipart text', async () => {
    const event = { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'safe-' }, { type: 'text', text: 'token' }] }] };
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    expect(await (await relayTurn(fakeUpstream(() => sse(streamOf([frame]))).upstream, { ...turn, credentials: ['private-token'] })).text()).toBe(frame + incomplete);
  });
});

describe('the credential guard follows client message buffers', () => {
  it('continues the first tool buffer when run input repeats a tool ID', () => {
    const event = RunStartedEventSchema.parse({
      type: 'RUN_STARTED', threadId: 'thread', runId: 'run',
      input: {
        threadId: 'thread', runId: 'run', state: {}, tools: [], context: [], forwardedProps: {},
        messages: [
          { id: 'first', role: 'assistant', content: '', toolCalls: [{ id: 'shared', type: 'function', function: { name: 'execute', arguments: 'private-' } }] },
          { id: 'second', role: 'assistant', content: '', toolCalls: [{ id: 'shared', type: 'function', function: { name: 'execute', arguments: 'token' } }] },
        ],
      },
    });
    // The installed client appends TOOL_CALL_ARGS to the first matching tool.
    const safe = turnCredentialGuard(['private-token']);
    expect(safe.leaks('', [structuredClone(event)])).toBe(false);
    expect(safe.hasPendingPrefix()).toBe(true);
    expect(safe.leaks('', [ToolCallArgsEventSchema.parse({ type: 'TOOL_CALL_ARGS', toolCallId: 'shared', delta: 'ordinary' })])).toBe(false);
    expect(safe.hasPendingPrefix()).toBe(false);

    const leaking = turnCredentialGuard(['private-token']);
    expect(leaking.leaks('', [structuredClone(event)])).toBe(false);
    expect(leaking.leaks('', [ToolCallArgsEventSchema.parse({ type: 'TOOL_CALL_ARGS', toolCallId: 'shared', delta: 'token' })])).toBe(true);
  });

  it('ignores an activity delta when the client has no matching message', () => {
    const event = ActivityDeltaEventSchema.parse({
      type: 'ACTIVITY_DELTA', messageId: 'absent', activityType: 'test',
      patch: [{ op: 'add', path: '/safe', value: 'ordinary' }],
    });
    const guard = turnCredentialGuard(['private-token']);

    expect(guard.leaks('', [event])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
  });
});

describe('client message-buffer seed events', () => {
  const input = (messages: unknown[]) => ({ threadId: 't', runId: 'r', state: {}, messages, tools: [], context: [], forwardedProps: {} });
  const start = { type: 'TEXT_MESSAGE_START', messageId: 'x', role: 'assistant' };
  const finish = { type: 'TEXT_MESSAGE_CONTENT', messageId: 'x', delta: 'token' };
  it.each([
    ['run input text', [{ type: 'RUN_STARTED', threadId: 't', runId: 'r', input: input([{ id: 'x', role: 'assistant', content: 'private-' }]) }, start, finish]],
    ['encoded query token in run input', [{ type: 'RUN_STARTED', threadId: 't', runId: 'r', input: input([{ id: 'x', role: 'assistant', content: 'private%2D' }]) }, start, finish]],
    ['run input tool arguments', [{ type: 'RUN_STARTED', threadId: 't', runId: 'r', input: input([{ id: 'x', role: 'assistant', content: '', toolCalls: [{ id: 'tool', type: 'function', function: { name: 'execute', arguments: 'private-' } }] }]) }, { type: 'TOOL_CALL_START', toolCallId: 'tool', toolCallName: 'execute', parentMessageId: 'x' }, { type: 'TOOL_CALL_ARGS', toolCallId: 'tool', delta: 'token' }]],
    ['tool result inserted before an existing ID', [{ type: 'TOOL_CALL_START', toolCallId: 'tool', toolCallName: 'execute', parentMessageId: 'p' }, { type: 'TOOL_CALL_END', toolCallId: 'tool' }, start, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'x', delta: 'safe-' }, { type: 'TEXT_MESSAGE_END', messageId: 'x' }, { type: 'TOOL_CALL_RESULT', messageId: 'x', toolCallId: 'tool', content: 'private-' }, start, finish]],
    ['first new duplicate message ID in snapshot', [{ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'x', role: 'assistant', content: 'private-' }, { id: 'x', role: 'assistant', content: 'safe-' }] }, start, finish]],
    ['message snapshot preserves existing order for result insertion', [{ type: 'TOOL_CALL_START', toolCallId: 'tool', toolCallName: 'execute', parentMessageId: 'p' }, { type: 'TOOL_CALL_END', toolCallId: 'tool' }, start, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'x', delta: 'safe-' }, { type: 'TEXT_MESSAGE_END', messageId: 'x' }, { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'x', role: 'assistant', content: 'safe-' }, { id: 'p', role: 'assistant', content: '', toolCalls: [{ id: 'tool', type: 'function', function: { name: 'execute', arguments: '' } }] }] }, { type: 'TOOL_CALL_RESULT', messageId: 'x', toolCallId: 'tool', content: 'private-' }, start, finish]],
    ['tool buffer in a second same-ID message', [{ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'x', role: 'assistant', content: 'safe' }, { id: 'x', role: 'assistant', toolCalls: [{ id: 'tool', type: 'function', function: { name: 'execute', arguments: 'private-' } }] }] }, { type: 'TOOL_CALL_START', toolCallId: 'tool', toolCallName: 'execute', parentMessageId: 'x' }, { type: 'TOOL_CALL_ARGS', toolCallId: 'tool', delta: 'token' }]],
    ['preserved activity in a second same-ID message', [{ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'x', role: 'assistant', content: 'safe' }, { id: 'x', role: 'activity', activityType: 'test', content: { part: 'private-' } }] }, { type: 'MESSAGES_SNAPSHOT', messages: [] }, { type: 'ACTIVITY_DELTA', messageId: 'x', activityType: 'test', patch: [{ op: 'copy', from: '/part', path: '' }] }, start, finish]],
    ['tool result content', [{ type: 'TOOL_CALL_RESULT', messageId: 'x', toolCallId: 'tool', content: 'private-' }, start, finish]],
    ['activity root add', [{ type: 'ACTIVITY_SNAPSHOT', messageId: 'x', activityType: 'test', content: { part: 'private-' } }, { type: 'ACTIVITY_DELTA', messageId: 'x', activityType: 'test', patch: [{ op: 'add', path: '', value: 'private-' }] }, start, finish]],
    ['activity root copy', [{ type: 'ACTIVITY_SNAPSHOT', messageId: 'x', activityType: 'test', content: { part: 'private-' } }, { type: 'ACTIVITY_DELTA', messageId: 'x', activityType: 'test', patch: [{ op: 'copy', from: '/part', path: '' }] }, start, finish]],
    ['activity root move', [{ type: 'ACTIVITY_SNAPSHOT', messageId: 'x', activityType: 'test', content: { part: 'private-' } }, { type: 'ACTIVITY_DELTA', messageId: 'x', activityType: 'test', patch: [{ op: 'move', from: '/part', path: '' }] }, start, finish]],
    ['activity object from RUN_STARTED', [{ type: 'RUN_STARTED', threadId: 't', runId: 'r', input: input([{ id: 'x', role: 'activity', activityType: 'test', content: { part: 'private-' } }]) }, { type: 'ACTIVITY_DELTA', messageId: 'x', activityType: 'test', patch: [{ op: 'copy', from: '/part', path: '' }] }, start, finish]],
    ['activity object from MESSAGES_SNAPSHOT', [{ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'x', role: 'activity', activityType: 'test', content: { part: 'private-' } }] }, { type: 'ACTIVITY_DELTA', messageId: 'x', activityType: 'test', patch: [{ op: 'copy', from: '/part', path: '' }] }, start, finish]],
    ['first matching tool buffer in message snapshot', [{ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'm1', role: 'assistant', content: '', toolCalls: [{ id: 'tool', type: 'function', function: { name: 'execute', arguments: 'private-' } }] }, { id: 'm2', role: 'assistant', content: '', toolCalls: [{ id: 'tool', type: 'function', function: { name: 'execute', arguments: 'safe-' } }] }] }, { type: 'TOOL_CALL_START', toolCallId: 'tool', toolCallName: 'execute', parentMessageId: 'm1' }, { type: 'TOOL_CALL_ARGS', toolCallId: 'tool', delta: 'token' }]],
    ['activity root replacement', [{ type: 'ACTIVITY_SNAPSHOT', messageId: 'x', activityType: 'test', content: {} }, { type: 'ACTIVITY_DELTA', messageId: 'x', activityType: 'test', patch: [{ op: 'replace', path: '', value: 'private-' }] }, start, finish]],
    ['activity refuses replacement when replace is false', [{ type: 'ACTIVITY_SNAPSHOT', messageId: 'x', activityType: 'test', content: {} }, { type: 'ACTIVITY_DELTA', messageId: 'x', activityType: 'test', patch: [{ op: 'replace', path: '', value: 'private-' }] }, { type: 'ACTIVITY_SNAPSHOT', messageId: 'x', activityType: 'test', content: {}, replace: false }, start, finish]],
    ['activity preserved across message snapshot', [{ type: 'ACTIVITY_SNAPSHOT', messageId: 'x', activityType: 'test', content: {} }, { type: 'ACTIVITY_DELTA', messageId: 'x', activityType: 'test', patch: [{ op: 'replace', path: '', value: 'private-' }] }, { type: 'MESSAGES_SNAPSHOT', messages: [] }, start, finish]],
  ])('withholds a prefix seeded by %s', async (_, events) => {
    const credentials = turnCredentials({ cdpUrl: 'ws://computer.internal/cdp?token=private-token' }, ['cdpUrl']);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)))).upstream, { ...turn, credentials });
    expect(await response.text()).toContain('TURN_CREDENTIALS_IN_STREAM');
  });
  it.each([
    ['run input preserves an existing message', [start, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'x', delta: 'safe-' }, { type: 'TEXT_MESSAGE_END', messageId: 'x' }, { type: 'RUN_STARTED', threadId: 't', runId: 'r', input: input([{ id: 'x', role: 'assistant', content: 'private-' }]) }, start, finish]],
    ['rejected activity patch leaves object content', [{ type: 'ACTIVITY_SNAPSHOT', messageId: 'x', activityType: 'test', content: { safe: true } }, { type: 'ACTIVITY_DELTA', messageId: 'x', activityType: 'test', patch: [{ op: 'test', path: '/safe', value: false }, { op: 'replace', path: '', value: 'private-' }] }, start, finish]],
    ['activity replaces old text content', [start, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'x', delta: 'private-' }, { type: 'TEXT_MESSAGE_END', messageId: 'x' }, { type: 'ACTIVITY_SNAPSHOT', messageId: 'x', activityType: 'test', content: { safe: true } }, start, finish]],
  ])('preserves safe frames when %s', async (_, events) => {
    const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(frames))).upstream, { ...turn, credentials: ['private-token'] });
    expect(await response.text()).toBe(frames.join('') + incomplete);
  });
});

describe('credential prefixes across client ID reuse', () => {
  it.each(['TEXT_MESSAGE', 'REASONING_MESSAGE', 'TOOL_CALL'].flatMap((kind) => [
    [kind, 'cdp.signed.', 'token'], [kind, 'cdp%2', 'Esigned.token'],
  ]))('withholds reused %s ID completion: %s', async (kind, first, last) => {
    const identity = kind === 'TOOL_CALL' ? { toolCallId: 'x', toolCallName: 'execute' } : { messageId: 'x', role: 'assistant' };
    const content = kind === 'TOOL_CALL' ? 'TOOL_CALL_ARGS' : `${kind}_CONTENT`;
    const events = [
      { type: `${kind}_START`, ...identity }, { type: content, ...identity, delta: first },
      { type: `${kind}_END`, ...identity }, { type: `${kind}_START`, ...identity },
      { type: content, ...identity, delta: last }, { type: `${kind}_END`, ...identity },
    ];
    const credentials = turnCredentials({ cdpUrl: 'ws://computer.internal/cdp?token=cdp.signed.token' }, ['cdpUrl']);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)))).upstream, { ...turn, credentials });
    const body = await response.text();
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain(`"delta":"${last}"`);
  });
  it('replaces a retained candidate when a message snapshot replaces client content', async () => {
    const events = [
      { type: 'TEXT_MESSAGE_START', messageId: 'x' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'x', delta: 'private-' },
      { type: 'TEXT_MESSAGE_END', messageId: 'x' },
      { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'x', role: 'assistant', content: 'safe-' }] },
      { type: 'TEXT_MESSAGE_START', messageId: 'x' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'x', delta: 'token' },
      { type: 'TEXT_MESSAGE_END', messageId: 'x' },
    ];
    const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(frames))).upstream, { ...turn, credentials: ['private-token'] });
    expect(await response.text()).toBe(frames.join('') + incomplete);
  });
  it('retains reasoning content when the client preserves it across a snapshot', async () => {
    const events = [
      { type: 'REASONING_MESSAGE_START', messageId: 'x' }, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'x', delta: 'private-' },
      { type: 'REASONING_MESSAGE_END', messageId: 'x' }, { type: 'MESSAGES_SNAPSHOT', messages: [] },
      { type: 'REASONING_MESSAGE_START', messageId: 'x' }, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'x', delta: 'token' },
    ];
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)))).upstream, { ...turn, credentials: ['private-token'] });
    expect(await response.text()).toContain('TURN_CREDENTIALS_IN_STREAM');
  });
  it('replaces reasoning content when the snapshot supplies reasoning messages', async () => {
    const events = [
      { type: 'REASONING_MESSAGE_START', messageId: 'x' }, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'x', delta: 'private-' },
      { type: 'REASONING_MESSAGE_END', messageId: 'x' },
      { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'x', role: 'reasoning', content: 'safe-' }] },
      { type: 'REASONING_MESSAGE_START', messageId: 'x' }, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'x', delta: 'token' },
      { type: 'REASONING_MESSAGE_END', messageId: 'x' },
    ];
    const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(frames))).upstream, { ...turn, credentials: ['private-token'] });
    expect(await response.text()).toBe(frames.join('') + incomplete);
  });
  it('checks a message snapshot prefix completed by a later delta', async () => {
    const events = [
      { type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'x', role: 'assistant', content: 'private-' }] },
      { type: 'TEXT_MESSAGE_START', messageId: 'x' }, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'x', delta: 'token' },
    ];
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)))).upstream, { ...turn, credentials: ['private-token'] });
    expect(await response.text()).toContain('TURN_CREDENTIALS_IN_STREAM');
  });
  it.each(['TEXT_MESSAGE_CHUNK', 'REASONING_MESSAGE_CHUNK', 'TOOL_CALL_CHUNK'])('withholds %s returning to an earlier ID', async (type) => {
    const identity = (id: string) => type === 'TOOL_CALL_CHUNK' ? { toolCallId: id, toolCallName: 'execute' } : { messageId: id };
    const events = [{ type, ...identity('x'), delta: 'private-' }, { type, ...identity('y'), delta: 'safe' }, { type, ...identity('x'), delta: 'token' }];
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)))).upstream, { ...turn, credentials: ['private-token'] });
    expect(await response.text()).toContain('TURN_CREDENTIALS_IN_STREAM');
  });
});

describe('credential deltas in client-normalized chunk events', () => {
  it.each(['TEXT_MESSAGE_CHUNK', 'TOOL_CALL_CHUNK', 'REASONING_MESSAGE_CHUNK'].flatMap((type) => [
    [type, 'cdp.signed.', 'token'], [type, 'cdp%2', 'Esigned.token'],
  ]))('withholds %s with inherited IDs: %s', async (type, first, last) => {
    const identity = type === 'TOOL_CALL_CHUNK' ? { toolCallId: 't1', toolCallName: 'execute' } : { messageId: 'm1' };
    const credentials = turnCredentials({ cdpUrl: 'ws://computer.internal/cdp?token=cdp.signed.token' }, ['cdpUrl']);
    const events = [{ type, ...identity, delta: first }, { type: 'RAW', event: {} }, { type, delta: last }];
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)))).upstream, { ...turn, credentials });
    const body = await response.text();
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain(first);
  });
  it('preserves safe chunk transitions and closes prefixes at the client boundary', async () => {
    const events = [
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'private-' },
      { type: 'STATE_SNAPSHOT', snapshot: {} },
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm2', delta: 'token' },
      { type: 'TOOL_CALL_CHUNK', toolCallId: 't1', toolCallName: 'execute', delta: 'safe' },
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'm3', delta: 'thought' },
      { type: 'REASONING_MESSAGE_CHUNK', messageId: 'm4', delta: 'done' },
    ];
    const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(frames))).upstream, { ...turn, credentials: ['private-token'] });
    expect(await response.text()).toBe(frames.join('') + incomplete);
  });
});

describe('reasoning message credential deltas', () => {
  it.each([
    [['private-token'], 'private-', 'token'],
    [turnCredentials({ cdpUrl: 'ws://computer.internal/cdp?token=cdp.signed.token' }, ['cdpUrl']), 'cdp%2', 'Esigned.token'],
  ])('withholds a credential split across reasoning deltas: %j', async (credentials, first, last) => {
    const events = [
      { type: 'REASONING_MESSAGE_START', messageId: 'm1' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm1', delta: first },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm1', delta: last },
      { type: 'REASONING_MESSAGE_END', messageId: 'm1' },
    ];
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(events.map((event) => `data: ${JSON.stringify(event)}\n\n`)))).upstream, { ...turn, credentials });
    const body = await response.text();
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain(first);
  });
  it('shares the installed client message namespace between text and reasoning deltas', async () => {
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([
      'data: {"type":"REASONING_MESSAGE_START","messageId":"m1"}\n\n',
      'data: {"type":"REASONING_MESSAGE_CONTENT","messageId":"m1","delta":"private-"}\n\n',
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"token"}\n\n',
    ]))).upstream, { ...turn, credentials: ['private-token'] });
    expect(await response.text()).toContain('TURN_CREDENTIALS_IN_STREAM');
  });
  it("relays safe reasoning after the candidate's message ends", async () => {
    const frame = 'data: {"type":"REASONING_MESSAGE_START","messageId":"m1"}\n\ndata: {"type":"REASONING_MESSAGE_CONTENT","messageId":"m1","delta":"private-"}\n\ndata: {"type":"REASONING_MESSAGE_END","messageId":"m1"}\n\ndata: {"type":"REASONING_MESSAGE_CONTENT","messageId":"m2","delta":"token"}\n\n';
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([frame]))).upstream, { ...turn, credentials: ['private-token'] });
    expect(await response.text()).toBe(frame + incomplete);
  });
});

describe('encoded standalone CDP query tokens', () => {
  const credentials = turnCredentials({ cdpUrl: 'ws://computer.internal/cdp?token=cdp.signed.token' }, ['cdpUrl']);
  it.each([
    ['TEXT_MESSAGE_CONTENT', { messageId: 'm1' }, ['cdp%2Esigned.token']],
    ['TOOL_CALL_ARGS', { toolCallId: 't1' }, ['{"token":"cdp%2Esigned.token"}']],
    ['TEXT_MESSAGE_CONTENT', { messageId: 'm1' }, ['cdp%2Esigned.', 'token']],
    ['TOOL_CALL_ARGS', { toolCallId: 't1' }, ['{"token":"cdp%2', 'Esigned.token"}']],
  ])('withholds an encoded standalone query token across %s deltas: %j', async (type, identity, deltas) => {
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(deltas.map((delta) =>
      `data: ${JSON.stringify({ type, ...identity, delta })}\n\n`,
    )))).upstream, { ...turn, credentials });
    const body = await response.text();
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain('cdp%2');
  });
  it('preserves percent-encoded text unrelated to this known CDP bearer', async () => {
    const frame = 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"other%2Esigned.token"}\n\n';
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([frame]))).upstream, { ...turn, credentials });
    expect(await response.text()).toBe(frame + incomplete);
  });
  it('does not query-decode a credential that is not from a credential URL', async () => {
    const frame = 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"cdp%2Esigned.token"}\n\n';
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([frame]))).upstream, { ...turn, credentials: ['cdp.signed.token'] });
    expect(await response.text()).toBe(frame + incomplete);
  });
  it('withholds a bare encoded query token in an HTTP refusal', async () => {
    const response = await relayTurn(fakeUpstream(() => new Response('failed token cdp%2Esigned.token', { status: 503 })).upstream, { ...turn, credentials });
    expect((await response.json()).details).toBe("The error body carried the Turn's credentials, so it was withheld");
    expect(consoleWarn.mock.calls.flat().join('\n')).not.toContain('cdp%2Esigned.token');
  });
});

describe('decoded credential property names', () => {
  it('withholds a credential used as an escaped state property name', async () => {
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([
      'data: {"type":"STATE_SNAPSHOT","snapshot":{"\\u0070rivate-token":true}}\n\n',
    ]))).upstream, { ...turn, credentials: ['private-token'] });

    const body = await response.text();
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain('\\u0070rivate-token');
  });

  it('withholds a credential used as an escaped HTTP refusal property name', async () => {
    const response = await relayTurn(fakeUpstream(() => new Response('{"\\u0070rivate-token":"diagnostic"}', { status: 503 })).upstream, { ...turn, credentials: ['private-token'] });

    expect(await response.json()).toEqual({ error: 'Test upstream returned HTTP 503', details: "The error body carried the Turn's credentials, so it was withheld" });
    expect(consoleWarn.mock.calls.flat().join('\n')).not.toContain('\\u0070rivate-token');
  });
});

/** The relayed body's chunks as text, failing (not hanging) if the stream does not end within a second or 20 chunks. */
async function chunksOf(response: Response): Promise<string[]> {
  const reader = defined(response.body, 'a response body').getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the relayed stream did not end')), 1_000);
    });
    // eslint-disable-next-line no-await-in-loop -- reads the stream one chunk at a time
    const chunk = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
    if (chunk.done) return chunks;
    chunks.push(decoder.decode(chunk.value));
    if (chunks.length > 20) throw new Error('the relayed stream did not end');
  }
}

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a relayed Turn's outcome", () => {
  const data = (event: object) => `data: ${JSON.stringify(event)}\n\n`;
  const text = (messageId: string, delta: string) => data({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta });
  const outcome = async (steps: Step[]) => {
    const finished = vi.fn();
    await (await relayTurn(fakeUpstream(() => sse(streamOf(steps))).upstream, { ...turn, finished })).text();
    return finished.mock.calls;
  };

  it.each([
    [[]],
    [['data: {"type":"RUN_STARTED"}\n\n']],
    [['data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Half"}\n\n']],
  ])('fails a clean EOF without a terminal Turn event (%j)', async (frames) => {
    const finished = vi.fn();
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(frames))).upstream, { ...turn, finished });

    expect(await response.text()).toBe(frames.join('') + incomplete);
    expect(finished).not.toHaveBeenCalled();
  });

  it("hands over the agent's last message once a finished run's stream ends", async () => {
    expect(
      await outcome([
        data({ type: 'RUN_STARTED' }),
        text('m1', 'Let me look. '),
        text('m2', ' Apple beat '),
        text('m2', 'on revenue. '),
        data({ type: 'RUN_FINISHED' }),
      ]),
    ).toEqual([['Apple beat on revenue.']]);
  });

  it('hands over an empty answer for a finished run that said nothing', async () => {
    expect(await outcome([data({ type: 'RUN_STARTED' }), data({ type: 'RUN_FINISHED' })])).toEqual([['']]);
  });

  it('hands over nothing for a run that failed or never finished', async () => {
    expect(await outcome([data({ type: 'RUN_STARTED' }), text('m1', 'Half'), data({ type: 'RUN_ERROR', message: 'boom' })])).toEqual([]);
    expect(await outcome([data({ type: 'RUN_STARTED' }), text('m1', 'Half'), { error: new Error('reset') }])).toEqual([]);
  });

  /** The messages a relay of these steps recorded the Turn as failed with. */
  const failures = async (steps: Step[], overrides: Partial<Parameters<typeof relayTurn>[1]> = {}) => {
    const failed = vi.fn();
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(steps))).upstream, { ...turn, ...overrides, failed });
    await response.text();
    return failed.mock.calls;
  };

  it.each([
    ["the agent's run error", [data({ type: 'RUN_STARTED' }), data({ type: 'RUN_ERROR', message: 'Model overloaded' })], 'Model overloaded'],
    ['a failed upstream stream', [data({ type: 'RUN_STARTED' }), { error: new Error('reset') }], 'Test upstream stream failed: Error: reset'],
    ['a stream that ends early', [data({ type: 'RUN_STARTED' })], 'Test upstream stream ended before the Turn finished'],
  ] as const)('records the Turn as failed with %s before relaying it', async (_label, steps, message) => {
    expect(await failures([...steps])).toEqual([[message]]);
  });

  it('records the Turn as failed when its answer carries a credential', async () => {
    expect(
      await failures([data({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'private-token' })], { credentials: ['private-token'] }),
    ).toEqual([["The agent's answer carried the Turn's credentials, so it was withheld"]]);
  });

  it('records the Turn as failed when an agent document edit cannot be saved', async () => {
    const edit = data({ type: 'CUSTOM', name: 'botcube:agent-document-edited', value: 'bad' });
    const saveAgentDocumentEdit = async () => {
      throw new Error('Soul content must be a string');
    };

    expect(await failures([edit], { saveAgentDocumentEdit })).toEqual([["The agent's edit could not be saved: Soul content must be a string"]]);
  });

  it('records nothing as failed for a finished run', async () => {
    expect(await failures([data({ type: 'RUN_STARTED' }), data({ type: 'RUN_FINISHED' })])).toEqual([]);
  });

  it('relays why a failed Turn could not be recorded, in place of its run error', async () => {
    const failed = async () => {
      throw new Error('DynamoDB is unavailable');
    };
    const response = await relayTurn(
      fakeUpstream(() => sse(streamOf([data({ type: 'RUN_ERROR', message: 'Model overloaded', code: 'INTERNAL_ERROR' })]))).upstream,
      { ...turn, failed },
    );

    expect(await response.text()).toBe(
      data({
        type: 'RUN_ERROR',
        message: 'Model overloaded; its Activity entry could not be saved: Error: DynamoDB is unavailable',
        code: 'TURN_ACTIVITY_FAILED',
      }),
    );
  });
});

describe('a relayed Turn', () => {
  it('sends the Turn body, Session and accepted type upstream', async () => {
    const { upstream, calls } = fakeUpstream(() => sse(streamOf([])));

    await chunksOf(await relayTurn(upstream, turn));

    expect(calls).toEqual([['{"messages":[]}', 'session-1', { accept: 'text/event-stream' }]]);
  });

  it('relays each SSE frame verbatim, whole, with the upstream content type', async () => {
    const response = await relay([
      'data: {"type":"RUN_STARTED"}\n',
      '\nevent: message\ndata: {"type":"RUN_',
      'FINISHED"}\n\n',
    ]);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await chunksOf(response)).toEqual([
      'data: {"type":"RUN_STARTED"}\n\n',
      'event: message\ndata: {"type":"RUN_FINISHED"}\n\n',
    ]);
  });

  it.each([false, true])('delivers unrelated live-view output before EOF with inactive history (input echo: %s)', async (echo) => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const frame = 'data: {"type":"TOOL_CALL_RESULT","messageId":"new","toolCallId":"t","content":"Session: browser-1"}\n\n';
    const runStart = echo ? `data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: 't', runId: 'r', input: { threadId: 't', runId: 'r', messages: [{ id: 'old', role: 'assistant', content: 'private-' }], tools: [], context: [], state: {}, forwardedProps: {} } })}\n\n` : '';
    const response = await relayTurn(fakeUpstream(() => sse(new ReadableStream<Uint8Array>({ start(controller) { source = controller; controller.enqueue(encoder.encode(runStart + frame)); } }))).upstream, {
      ...turn, credentials: ['private-token'], initialMessages: [{ id: 'old', role: 'assistant', content: 'private-' }],
    });
    const reader = defined(response.body, 'streaming response body').getReader();
    let first: ReadableStreamReadResult<Uint8Array> | undefined;
    const reading = reader.read().then((chunk) => { first = chunk; });
    try {
      await vi.waitFor(() => expect(first).toBeDefined(), { timeout: 200 });
      expect(new TextDecoder().decode(first?.value)).toContain('"name":"test:live"');
      expect(new TextDecoder().decode(first?.value)).toContain('Session: browser-1');
    } finally {
      source?.close();
      await reading;
      await reader.cancel();
    }
  });

  it('streams safe frames before withholding a credential prefix across separate reads', async () => {
    const secret = 'private-token';
    const safe = 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"safe answer "}\n\n';
    const first = 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"private-"}\n\n';
    const last = 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"token"}\n\n';
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([safe, first, last]))).upstream, {
      ...turn, credentials: [secret],
    });

    const chunks = await chunksOf(response);

    expect(chunks[0]).toBe(safe);
    expect(chunks.join('')).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(chunks.join('')).not.toContain('private-');
  });

  it('checks decoded deltas when a credential character is JSON-escaped', async () => {
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"\\u0070rivate-"}\n\n',
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"token"}\n\n',
    ]))).upstream, { ...turn, credentials: ['private-token'] });

    const body = (await chunksOf(response)).join('');

    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain('TEXT_MESSAGE_CONTENT');
  });

  it('checks decoded events on a data line without the optional space', async () => {
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([
      'data:{"type":"STATE_SNAPSHOT","snapshot":{"note":"\\u0070rivate-token"}}\n\n',
    ]))).upstream, { ...turn, credentials: ['private-token'] });

    const body = (await chunksOf(response)).join('');

    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain('STATE_SNAPSHOT');
  });

  it.each([
    ['a later delta disproves the prefix', [
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'private-' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'garden' },
    ]],
    ['the message ends with a harmless partial prefix', [
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'private-' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'token' },
    ]],
    ['another message contains the rest', [
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'private-' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'token' },
    ]],
    ['the stream ends before the prefix can complete', [
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'private-' },
    ]],
  ])('preserves the frames when %s', async (_, events) => {
    const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(frames))).upstream, {
      ...turn, credentials: ['private-token'],
    });

    expect((await chunksOf(response)).join('')).toBe(frames.join('') + incomplete);
  });

  it.each([
    ['separate tool calls', [
      { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: 'private-' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't2', delta: 'token' },
    ]],
    ['a message and tool call with the same ID', [
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'same', delta: 'private-' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'same', delta: 'token' },
    ]],
    ['a different tool call follows an ended call', [
      { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: 'private-' },
      { type: 'TOOL_CALL_END', toolCallId: 't1' },
      { type: 'TOOL_CALL_START', toolCallId: 't2', toolCallName: 'execute' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't2', delta: 'token' },
    ]],
  ])('preserves safe argument frames across %s', async (_, events) => {
    const frames = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(frames))).upstream, {
      ...turn, credentials: ['private-token'],
    });

    expect((await chunksOf(response)).join('')).toBe(frames.join('') + incomplete);
  });

  it('checks decoded document edits before saving or relaying them', async () => {
    const save = vi.fn(async (_edit: unknown) => undefined);
    const safe = 'data: {"type":"CUSTOM","name":"botcube:agent-document-edited","value":{"document":"soul","content":"safe"}}\n\n';
    const unsafe = 'data: {"type":"CUSTOM","name":"botcube:agent-document-edited","value":{"document":"soul","content":"\\u0070rivate-token"}}\n\n';
    const response = await relayTurn(fakeUpstream(() => sse(streamOf([safe + unsafe]))).upstream, {
      ...turn, credentials: ['private-token'], saveAgentDocumentEdit: save,
    });

    const body = (await chunksOf(response)).join('');

    expect(save.mock.calls).toEqual([[{ document: 'soul', content: 'safe' }]]);
    expect(body).toContain(safe);
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain('\\u0070rivate-token');
  });

  it('is an event stream when the upstream names no content type', async () => {
    const response = await relayTurn(fakeUpstream(() => new Response(streamOf([]))).upstream, turn);

    expect(response.headers.get('content-type')).toBe('text/event-stream');
  });

  it.each([
    ['CRLF', ['data: a\r\n\r\ndata: b\r\n\r\n'], ['data: a\n\ndata: b\n\n']],
    ['CR', ['data: a\r\rdata: b\r\r'], ['data: a\n\n', 'data: b\n\n']],
    ['CRLF split across chunks', ['data: a\r', '\ndata: b\r\n\r\n'], ['data: a\ndata: b\n\n']],
    ['runs of blank lines', ['data: a\n\n\n\ndata: b\n\n'], ['data: a\n\ndata: b\n\n']],
  ])('ends lines with LF when the upstream uses %s', async (_, steps, chunks) => {
    expect((await chunksOf(await relay(steps))).join('')).toBe(chunks.join('') + incomplete);
  });

  it.each([
    ['LF', ['data: a\ndata: b']],
    ['CR', ['data: a\ndata: b\r']],
  ])('ends a last frame that has no blank line, even after a %s', async (_, steps) => {
    expect((await chunksOf(await relay(steps))).join('')).toBe('data: a\ndata: b\n\n' + incomplete);
  });

  // A large frame arrived in reads that completed no frame, and the relay stopped pulling.
  it('relays a frame that spans several reads, none completing a frame until the last', async () => {
    expect(await chunksOf(await relay(['data: {"type":', '"RUN_', 'FINISHED"}\n', '\n']))).toEqual([
      'data: {"type":"RUN_FINISHED"}\n\n',
    ]);
  });

  it('keeps a character split across chunks whole', async () => {
    const euro = encoder.encode('data: €\n\n');

    expect(await chunksOf(await relay([euro.slice(0, 7), euro.slice(7)]))).toEqual(['data: €\n\n', incomplete]);
  });

  it('follows a frame that opens the browser live view with the live-view event', async () => {
    const frame = 'data: {"type":"TOOL_CALL_RESULT","content":"Session: browser-1"}\n\n';

    expect(await chunksOf(await relay([frame]))).toEqual([
      `${frame}data: {"type":"CUSTOM","name":"test:live","value":{"open":true,"sessionId":"browser-1"}}\n\n`,
      incomplete,
    ]);
  });

  it('follows a frame with the live-view event of each data line that opens or closes the live view', async () => {
    const frame = 'data: {"type":"TOOL_CALL_RESULT","content":"Session: browser-1"}\ndata: {"type":"TOOL_CALL_RESULT","content":"browser closed"}\n\n';

    expect(await chunksOf(await relay([frame]))).toEqual([
      `${frame}data: {"type":"CUSTOM","name":"test:live","value":{"open":true,"sessionId":"browser-1"}}\n\n` +
        'data: {"type":"CUSTOM","name":"test:live","value":{"open":false}}\n\n',
      incomplete,
    ]);
  });

  it('ends with a run error after the frame in flight when the upstream stream fails', async () => {
    const failure = new Error('socket hang up', { cause: 'ECONNRESET' });

    const chunks = await chunksOf(await relay(['data: a\n\ndata: b\n', { error: failure }]));

    expect(chunks).toEqual([
      'data: a\n\n',
      'data: b\n\ndata: {"type":"RUN_ERROR","message":"Test upstream stream failed: socket hang up: ECONNRESET","code":"AGENTCORE_UPSTREAM_STREAM_ERROR"}\n\n',
    ]);
    expect(consoleError.mock.calls).toEqual([['Test upstream stream failed session_id=session-1 code=AGENTCORE_UPSTREAM_STREAM_ERROR', failure]]);
  });

  it('names a failure that is not an Error by its string form', async () => {
    const chunks = await chunksOf(await relay([{ error: { message: 'reset', cause: 'ECONNRESET' } }]));

    expect(chunks).toEqual([
      'data: {"type":"RUN_ERROR","message":"Test upstream stream failed: [object Object]","code":"AGENTCORE_UPSTREAM_STREAM_ERROR"}\n\n',
    ]);
  });

  it("logs the agent's run error with its Session, and relays it", async () => {
    const frame =
      'data: {"type":"RUN_ERROR","message":"The number of toolResult blocks exceeds the number of toolUse blocks","code":"INTERNAL_ERROR"}\n\n';

    expect(await chunksOf(await relay(['data: {"type":"RUN_STARTED"}\n\n', frame]))).toEqual([
      'data: {"type":"RUN_STARTED"}\n\n',
      frame,
    ]);
    expect(consoleError.mock.calls).toEqual([
      [
        'Test upstream run failed session_id=session-1 code=INTERNAL_ERROR message=The number of toolResult blocks exceeds the number of toolUse blocks',
      ],
    ]);
  });

  // The client sends its next Turn only once this stream closes, so the summary must not hold it open.
  it('closes the stream once RUN_FINISHED is relayed, while the Turn summary still runs', async () => {
    let summarized: (() => void) | undefined;
    const finished = vi.fn(() => new Promise<void>((resolve) => { summarized = resolve; }));
    const ended = vi.fn(async () => undefined);
    const frames = ['data: {"type":"RUN_STARTED"}\n\n', 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Done."}\n\n', 'data: {"type":"RUN_FINISHED"}\n\n'];
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(frames))).upstream, { ...turn, finished, ended });

    expect(await response.text()).toBe(frames.join(''));
    expect(finished).toHaveBeenCalledExactlyOnceWith('Done.');
    expect(ended.mock.calls).toEqual([[undefined]]);
    summarized?.();
  });

  it('relays RUN_FINISHED when the Turn summary fails, and logs the failure', async () => {
    const failure = new Error('The Turn summary could not be saved: summary refused');
    const ended = vi.fn(async () => undefined);
    const frames = ['data: {"type":"RUN_STARTED"}\n\n', 'data: {"type":"RUN_FINISHED"}\n\n'];
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(frames))).upstream, { ...turn, finished: async () => { throw failure; }, ended });

    expect(await response.text()).toBe(frames.join(''));
    expect(ended.mock.calls).toEqual([[undefined]]);
    await vi.waitFor(() => expect(consoleError.mock.calls).toEqual([["The Turn's completion failed after its answer was relayed session_id=session-1", failure]]));
  });

  it('raises the Turn-summary alarm when the Activity row cannot be saved after the stream closed, rejecting nothing unhandled', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const failure = new Error('DynamoDB rejected the write');
      const frames = ['data: {"type":"RUN_STARTED"}\n\n', 'data: {"type":"RUN_FINISHED"}\n\n'];
      const response = await relayTurn(fakeUpstream(() => sse(streamOf(frames))).upstream, {
        ...turn,
        finished: (answer) => recordTurnSummary(
          async () => ({ title: 'Brief on rates', summary: 'Compared the yields' }),
          async () => { throw failure; },
          'session-1',
          { request: 'Compare rates', answer },
        ),
      });

      expect(await response.text()).toBe(frames.join(''));
      await vi.waitFor(() => expect(consoleError.mock.calls).toEqual([
        ['Turn summary failed session_id=session-1', failure],
        ["The Turn's completion failed after its answer was relayed session_id=session-1", new Error('The Turn summary could not be saved: DynamoDB rejected the write')],
      ]));
      await settled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  // A reload or a closed tab stopped the Turn, leaving its reply cut off; only an explicit Stop stops one.
  it('reads the upstream to its end after the client goes away, asking it nothing else', async () => {
    const finished = vi.fn();
    const ended = vi.fn(async () => undefined);
    const { upstream, calls } = fakeUpstream(() => sse(streamOf([
      'data: {"type":"RUN_STARTED"}\n\n',
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"the whole answer"}\n\n',
      'data: {"type":"RUN_FINISHED"}\n\n',
    ])));
    const response = await relayTurn(upstream, { ...turn, finished, ended });
    const reader = defined(response.body, 'a response body').getReader();
    await reader.read();

    await reader.cancel('client closed');

    expect(calls).toHaveLength(1);
    expect(finished).toHaveBeenCalledWith('the whole answer');
    expect(ended.mock.calls).toEqual([[undefined]]);
  });

  // The Turn's failure is recorded for the page that opens the Session later.
  it.each([
    [
      'a run error the agent sends',
      ['data: {"type":"RUN_ERROR","code":"INTERNAL_ERROR","message":"model refused"}\n\n'],
      'Test upstream run failed session_id=session-1 code=INTERNAL_ERROR message=model refused',
      { code: 'INTERNAL_ERROR', message: 'model refused' },
    ],
    [
      'a stream that ends before the Turn finishes',
      [],
      'Test upstream stream ended before the Turn finished session_id=session-1 code=AGENTCORE_UPSTREAM_STREAM_ERROR',
      { code: 'AGENTCORE_UPSTREAM_STREAM_ERROR', message: 'Test upstream stream ended before the Turn finished' },
    ],
  ])('logs %s after the client went away, and tells the end with it', async (_label, rest, logged, failure) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ended = vi.fn(async () => undefined);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(['data: {"type":"RUN_STARTED"}\n\n', ...rest]))).upstream, { ...turn, ended });

    await defined(response.body, 'a response body').cancel();

    expect(error.mock.calls).toEqual([[logged]]);
    expect(ended.mock.calls).toEqual([[failure]]);
  });

  it('tells no failure for a Turn the user stopped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ended = vi.fn(async () => undefined);
    const stopped = 'data: {"type":"RUN_ERROR","code":"TURN_STOPPED","message":"The Turn was stopped, or a newer Turn on this Session replaced it"}\n\n';
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(['data: {"type":"RUN_STARTED"}\n\n', stopped]))).upstream, { ...turn, ended });

    await response.text();

    expect(ended.mock.calls).toEqual([[undefined]]);
  });

  it('tells a failure with no code when the run error has none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ended = vi.fn(async () => undefined);
    const response = await relayTurn(
      fakeUpstream(() => sse(streamOf(['data: {"type":"RUN_STARTED"}\n\n', 'data: {"type":"RUN_ERROR","message":"model refused"}\n\n']))).upstream,
      { ...turn, ended },
    );

    await response.text();

    expect(ended.mock.calls).toEqual([[{ message: 'model refused' }]]);
  });

  describe("the Turn's end", () => {
    const readAt = Date.UTC(2026, 9, 5, 9, 10, 21, 300);
    let settleSummary: (failure?: Error) => void = () => undefined;
    /** A finished Turn whose end write takes 0.3 s, and whose summary settles 1.8 s in, after its stream closed. */
    const timed = (overrides: Partial<Parameters<typeof relayTurn>[1]> = {}) =>
      relayTurn(fakeUpstream(() => sse(streamOf(['data: {"type":"RUN_STARTED"}\n\n', 'data: {"type":"RUN_FINISHED"}\n\n']))).upstream, {
        ...turn,
        finished: () => new Promise<void>((resolve, reject) => {
          settleSummary = (failure) => {
            vi.setSystemTime(readAt + 1_800);
            if (failure === undefined) resolve();
            else reject(failure);
          };
        }),
        ended: async () => {
          vi.setSystemTime(readAt + 300);
        },
        ...overrides,
      });
    const logged = (summaryFailed: boolean, client: string, endedFailed = false) =>
      `Test upstream relayed the Turn's end session_id=session-1 run_finished_read_at=2026-10-05T09:10:21.300Z summary_ms=1800 summary_failed=${summaryFailed} ended_ms=300 ended_failed=${endedFailed} done_ms=300 client=${client}`;
    let info: MockInstance<typeof console.info>;
    beforeEach(() => {
      info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(readAt);
    });
    afterEach(() => {
      vi.useRealTimers();
    });


    it('keeps upstream receipt before preceding edit persistence from the same chunk', async () => {
      const edit = 'data: {"type":"CUSTOM","name":"botcube:agent-document-edited","value":{"document":"soul","content":"safe"}}\n\n';
      const response = await relayTurn(fakeUpstream(() => sse(streamOf([edit + 'data: {"type":"RUN_FINISHED"}\n\n']))).upstream, {
        ...turn,
        saveAgentDocumentEdit: async () => { vi.setSystemTime(readAt + 500); },
        finished: () => { vi.setSystemTime(readAt + 2_300); },
        ended: async () => { vi.setSystemTime(readAt + 2_600); },
      });
      await response.text();

      await settled();
      expect(info.mock.calls).toEqual([[`Test upstream relayed the Turn's end session_id=session-1 run_finished_read_at=2026-10-05T09:10:21.300Z summary_ms=1800 summary_failed=false ended_ms=300 ended_failed=false done_ms=2600 client=attached`]]);
    });

    it('reports an attached client without claiming that prefetched bytes were consumed', async () => {
      let signal: (() => void) | undefined;
      const finished = new Promise<void>((resolve) => { signal = resolve; });
      const response = await relayTurn(fakeUpstream(() => sse(streamOf(['data: {"type":"RUN_FINISHED"}\n\n']))).upstream, {
        ...turn,
        finished: () => { signal?.(); },
        ended: async () => undefined,
      });
      // Response construction permits a pull before text() or a reader consumes the queued frame.
      await finished;
      await settled();
      expect(info).not.toHaveBeenCalled();
      vi.setSystemTime(readAt + 9_000);
      await response.text();

      await settled();
      expect(info.mock.calls).toEqual([[`Test upstream relayed the Turn's end session_id=session-1 run_finished_read_at=2026-10-05T09:10:21.300Z summary_ms=0 summary_failed=false ended_ms=0 ended_failed=false done_ms=9000 client=attached`]]);
    });

    it('logs a failed end write while retaining the stream failure', async () => {
      const failure = new Error('table unavailable');
      const response = await timed({ ended: async () => {
        vi.setSystemTime(readAt + 300);
        throw failure;
      } });
      await expect(response.text()).rejects.toBe(failure);
      settleSummary();

      await settled();
      expect(info.mock.calls).toEqual([[logged(false, 'attached', true)]]);
    });

    // The summary runs on after the stream closed, so done_ms leaves it out.
    it('logs when the relay read RUN_FINISHED, how long the end write took, and the summary once it settles', async () => {
      await (await timed()).text();
      expect(info).not.toHaveBeenCalled();

      settleSummary();

      await settled();
      expect(info.mock.calls).toEqual([[logged(false, 'attached')]]);
    });

    it('logs a summary that failed', async () => {
      await (await timed()).text();

      settleSummary(new Error('summary refused'));

      await settled();
      expect(info.mock.calls).toEqual([[logged(true, 'attached')]]);
    });

    it('logs the end of a Turn whose client went away', async () => {
      await defined((await timed()).body, 'streaming response body').cancel();

      settleSummary();

      await settled();
      expect(info.mock.calls).toEqual([[logged(false, 'gone')]]);
    });

    it('logs no end for a Turn that never finished', async () => {
      await (await relay(['data: {"type":"RUN_STARTED"}\n\n', 'data: {"type":"RUN_ERROR","message":"boom"}\n\n'])).text();

      expect(info).not.toHaveBeenCalled();
    });
  });

  it('tells the end once when the client reads the stream to its end', async () => {
    const ended = vi.fn(async () => undefined);
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(['data: {"type":"RUN_FINISHED"}\n\n']))).upstream, { ...turn, ended });

    expect(await response.text()).toBe('data: {"type":"RUN_FINISHED"}\n\n');
    expect(ended.mock.calls).toEqual([[undefined]]);
  });

  it.each([
    ['fails to start', async () => { throw new Error('connection refused'); }, { code: 'AGENTCORE_UPSTREAM_REQUEST_ERROR', message: 'Test upstream request failed: Error: connection refused' }],
    ['refuses', async () => new Response('busy', { status: 503 }), { code: 'AGENTCORE_UPSTREAM_HTTP_ERROR', message: 'Test upstream returned HTTP 503: busy' }],
  ])('tells the end of a Turn the upstream %s', async (_label, respond, failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ended = vi.fn(async () => undefined);

    await relayTurn({ label: 'Test upstream', invoke: respond }, { ...turn, ended });

    expect(ended.mock.calls).toEqual([[failure]]);
  });

  it("fails the client's stream with an end it cannot record, and logs it", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('table unavailable');
    const response = await relayTurn(fakeUpstream(() => sse(streamOf(['data: {"type":"RUN_FINISHED"}\n\n']))).upstream, { ...turn, ended: async () => { throw failure; } });

    await expect(response.text()).rejects.toBe(failure);
    expect(error.mock.calls).toEqual([["The Turn's end could not be recorded session_id=session-1", failure]]);
  });

  it("still answers the upstream's refusal when it cannot record the Turn's end", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = new Error('table unavailable');

    const response = await relayTurn(
      { label: 'Test upstream', invoke: async () => new Response('busy', { status: 503 }) },
      { ...turn, ended: async () => { throw failure; } },
    );

    expect(response.status).toBe(503);
    expect(error.mock.calls).toEqual([["The Turn's end could not be recorded session_id=session-1", failure]]);
  });
});

describe('a quiet Turn', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a keepalive comment at least every 15 s, so an idle-cutting proxy keeps the stream until its end', async () => {
    vi.useFakeTimers();
    // Longer than Cloudflare's 125 s proxy read timeout, which cuts a stream that sends nothing.
    const quietMs = 130_000;
    const started = 'data: {"type":"RUN_STARTED"}\n\n';
    const ended = 'data: {"type":"RUN_ERROR","message":"OpenAI did not respond","code":"MODEL_PROVIDER_TIMEOUT"}\n\n';
    const steps = [started, ended];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const step = steps.shift();
        if (step === undefined) return controller.close();
        if (step === ended) await new Promise((resolve) => setTimeout(resolve, quietMs));
        controller.enqueue(encoder.encode(step));
      },
    });
    const reader = defined((await relayTurn(fakeUpstream(() => sse(body)).upstream, turn)).body, 'a response body').getReader();
    const decoder = new TextDecoder();
    const received: { at: number; text: string }[] = [];
    const reading = (async () => {
      // eslint-disable-next-line no-await-in-loop -- reads the stream one chunk at a time
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        received.push({ at: Date.now(), text: decoder.decode(chunk.value) });
      }
    })();
    const start = Date.now();

    await vi.advanceTimersByTimeAsync(quietMs);
    await reading;

    expect(received.map(({ text }) => text)).toEqual([started, ...Array<string>(8).fill(': keepalive\n\n'), ended]);
    const gaps = received.map(({ at }, index) => at - (index === 0 ? start : defined(received[index - 1], 'a chunk').at));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(15_000);
  });

  it("relays the Harness's own keepalive comment as it came", async () => {
    const frames = [': keepalive\n\n', 'data: {"type":"RUN_FINISHED"}\n\n'];

    expect(await chunksOf(await relay(frames))).toEqual(frames);
  });
});

describe('a Turn the upstream refuses', () => {
  it.each([
    [500, 500],
    [400, 400],
    [302, 502],
  ])('answers an upstream HTTP %i as %i with its error body', async (upstreamStatus, status) => {
    const response = await relayTurn(
      fakeUpstream(() => new Response(' runtime unavailable \n', { status: upstreamStatus })).upstream,
      turn,
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: `Test upstream returned HTTP ${upstreamStatus}`,
      details: 'runtime unavailable',
    });
    expect(consoleWarn.mock.calls).toEqual([
      [`Test upstream error status=${upstreamStatus} details=runtime unavailable`],
    ]);
  });

  it.each([
    ['verbatim', 'echo: private-token'],
    ['JSON-escaped', '{"message":"echo: \\u0070rivate-token"}'],
  ])('withholds a %s Turn credential in the error body from the log and the client', async (_, body) => {
    const response = await relayTurn(
      fakeUpstream(() => new Response(body, { status: 500 })).upstream,
      { ...turn, credentials: ['private-token'] },
    );

    const answer = await response.text();
    const logged = JSON.stringify([...consoleWarn.mock.calls, ...consoleError.mock.calls]);

    expect(response.status).toBe(500);
    expect(answer).toContain('Test upstream returned HTTP 500');
    expect(answer).not.toContain('rivate-token');
    expect(logged).not.toContain('rivate-token');
  });

  it('answers an upstream success without a body as 502', async () => {
    const response = await relayTurn(fakeUpstream(() => new Response(null, { status: 204 })).upstream, turn);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Test upstream returned HTTP 204', details: '' });
    expect(consoleWarn.mock.calls).toEqual([['Test upstream error status=204 details=']]);
  });

  it('answers 502 when the error body cannot be read', async () => {
    const failure = new Error('body reset');
    const ended = vi.fn(async () => undefined);
    const response = await relayTurn(
      fakeUpstream(() => new Response(streamOf([{ error: failure }]), { status: 503 })).upstream,
      { ...turn, ended },
    );

    expect(ended).toHaveBeenCalledWith({ code: 'AGENTCORE_UPSTREAM_HTTP_ERROR', message: 'Test upstream returned HTTP 503 but its error body could not be read: Error: body reset' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Test upstream returned HTTP 503 but its error body could not be read',
      details: 'Error: body reset',
    });
    expect(consoleError.mock.calls).toEqual([['Failed to read the Test upstream error body', failure]]);
  });
});

describe('pre-stream credential failures', () => {
  it.each(['request', 'body-read', 'http'])('withholds credentials from the %s response and persisted failure', async (mode) => {
    const ended = vi.fn(async () => undefined);
    const upstream: Upstream = { label: 'Test upstream', invoke: async () => {
      if (mode === 'request') throw new Error('echo: private-token');
      if (mode === 'body-read') return new Response(streamOf([{ error: new Error('echo: private-token') }]), { status: 503 });
      return new Response('echo: private-token', { status: 503 });
    } };
    const response = await relayTurn(upstream, { ...turn, credentials: ['private-token'], ended });
    expect(await response.json()).toMatchObject({ details: "The error body carried the Turn's credentials, so it was withheld" });
    expect(ended).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledWith({
      code: mode === 'request' ? 'AGENTCORE_UPSTREAM_REQUEST_ERROR' : 'AGENTCORE_UPSTREAM_HTTP_ERROR',
      message: `${mode === 'request' ? 'Test upstream request failed' : mode === 'body-read' ? 'Test upstream returned HTTP 503 but its error body could not be read' : 'Test upstream returned HTTP 503'}: The error body carried the Turn's credentials, so it was withheld`,
    });
  });
});

describe('a Turn whose upstream request fails', () => {
  it.each([
    ['with a cause', new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }), 'fetch failed: Error: connect ECONNREFUSED'],
    ['without a cause', new Error('aborted'), 'Error: aborted'],
  ])('answers the classified 502 %s', async (_, failure, details) => {
    const upstream: Upstream = {
      label: 'Test upstream',
      invoke: () => Promise.reject(failure),
    };

    const response = await relayTurn(upstream, turn);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Test upstream request failed', details });
    expect(consoleError.mock.calls).toEqual([['Test upstream request failed before the stream opened', failure]]);
  });
});

describe("the agent's document edits in a relayed Turn", () => {
  const edit = (value: unknown) =>
    `data: ${JSON.stringify({ type: 'CUSTOM', name: 'botcube:agent-document-edited', value })}\n\n`;

  /** Relay these steps, recording each edit handed to `save` and whether the upstream was cancelled. */
  function relayRecording(steps: Step[], save: (edit: unknown) => Promise<void> = async () => undefined) {
    const saved: unknown[] = [];
    let cancelled = false;
    const queue = [...steps];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const step = queue.shift();
        if (step === undefined) controller.close();
        else if (typeof step === 'string') controller.enqueue(encoder.encode(step));
        else if (!(step instanceof Uint8Array)) controller.error(step.error);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = relayTurn(fakeUpstream(() => sse(body)).upstream, {
      ...turn,
      saveAgentDocumentEdit: async (value) => {
        saved.push(value);
        await save(value);
      },
    });
    return { response, saved, cancelled: () => cancelled };
  }

  it('saves only agent-document-edited events, in order, and relays every frame', async () => {
    const frames = [
      'data: not json\n\n',
      'retry: 1000\n\n',
      'data: null\n\n',
      'data: {"type":"CUSTOM","name":"test:other","value":{"open":false}}\n\n',
      'data: {"type":"STATE_DELTA","name":"botcube:agent-document-edited","value":"not an edit"}\n\n',
      edit({ document: 'soul', content: 'first' }),
      edit({ document: 'soul', content: 'second' }),
    ];
    const { response, saved } = relayRecording([frames.join('')]);

    expect((await chunksOf(await response)).join('')).toBe(frames.join('') + incomplete);
    expect(saved).toEqual([
      { document: 'soul', content: 'first' },
      { document: 'soul', content: 'second' },
    ]);
  });

  it('ends the stream at an edit it cannot save, relaying nothing from there and cancelling the upstream', async () => {
    const { response, saved, cancelled } = relayRecording(
      [`data: {"type":"RUN_STARTED"}\n\n${edit('bad')}data: {"type":"TEXT"}\n\n`, 'data: {"type":"RUN_FINISHED"}\n\n'],
      async () => {
        throw new Error('Soul content must be a string');
      },
    );

    expect(await chunksOf(await response)).toEqual([
      'data: {"type":"RUN_STARTED"}\n\n' +
        'data: {"type":"RUN_ERROR","message":"The agent\'s edit could not be saved: Soul content must be a string","code":"AGENT_DOCUMENT_SAVE_FAILED"}\n\n',
    ]);
    expect(saved).toEqual(['bad']);
    expect(cancelled()).toBe(true);
    expect(consoleError).toHaveBeenCalledWith('Saving an agent document edit failed', new Error('Soul content must be a string'));
  });

  it('names a failed save that is not an Error by its string form', async () => {
    const { response } = relayRecording([edit('bad')], () => Promise.reject('refused'));

    expect((await chunksOf(await response)).join('')).toContain('"message":"The agent\'s edit could not be saved: refused"');
  });

  it('saves nothing for the error that ends a failed stream', async () => {
    const { response, saved } = relayRecording(['data: {"type":"RUN_STARTED"}\n\n', { error: new Error('reset') }]);

    await chunksOf(await response);

    expect(saved).toEqual([]);
  });
});


describe('the answer passed to Turn completion', () => {
  it.each([
    [{ type: 'TEXT_MESSAGE_CHUNK', messageId: 'a1', role: 'assistant', delta: 'The current answer.' }],
    [{ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'a1', role: 'assistant', content: 'The current answer.' }] }],
  ])('uses the current answer from a supported message event %j', async (message) => {
    const finished = vi.fn();
    const frames = [message, { type: 'RUN_FINISHED' }].map((event) => `data: ${JSON.stringify(event)}\n\n`);
    const { upstream } = fakeUpstream(() => sse(streamOf(frames)));
    await (await relayTurn(upstream, { ...turn, finished })).text();
    expect(finished).toHaveBeenCalledExactlyOnceWith('The current answer.');
  });
});


it('passes the full answer when subsequent text chunks omit their active message ID', async () => {
  const finished = vi.fn();
  const frames = [
    { type: 'TEXT_MESSAGE_CHUNK', messageId: 'a1', role: 'assistant', delta: 'The current ' },
    { type: 'TEXT_MESSAGE_CHUNK', delta: 'answer.' },
    { type: 'RUN_FINISHED' },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
  const { upstream } = fakeUpstream(() => sse(streamOf(frames)));
  await (await relayTurn(upstream, { ...turn, finished })).text();
  expect(finished).toHaveBeenCalledExactlyOnceWith('The current answer.');
});

describe('an explicit Stop', () => {
  it("asks the upstream to stop the Session's Turn, closing its answer", async () => {
    let answerClosed = false;
    const { upstream, calls } = fakeUpstream(() => new Response(new ReadableStream<Uint8Array>({ cancel: () => void (answerClosed = true) })));

    await stopTurn(upstream, '{"forwardedProps":{"stop":true}}', 'session-1');

    expect(calls).toEqual([['{"forwardedProps":{"stop":true}}', 'session-1']]);
    expect(answerClosed).toBe(true);
  });

  it('fails when the upstream refuses it', async () => {
    const { upstream } = fakeUpstream(() => new Response('busy', { status: 409 }));

    await expect(stopTurn(upstream, '{}', 'session-1')).rejects.toThrow('Test upstream refused to stop the Turn: HTTP 409');
  });
});
