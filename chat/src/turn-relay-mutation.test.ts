import { describe, expect, it, vi } from 'vitest';
import { relayTurn, turnCredentialGuard } from './turn-stream.js';
import type { Upstream } from './upstream.js';

const credentials = ['private-token'];
const start = (messageId = 'message', role = 'assistant') => ({ type: 'TEXT_MESSAGE_START', messageId, role });
const text = (delta: string, messageId = 'message') => ({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta });
const end = (messageId = 'message') => ({ type: 'TEXT_MESSAGE_END', messageId });
const toolStart = (parentMessageId: string, toolCallId = 'tool') => ({ type: 'TOOL_CALL_START', parentMessageId, toolCallId, toolCallName: 'execute' });
const toolArgs = (delta: string, toolCallId = 'tool') => ({ type: 'TOOL_CALL_ARGS', toolCallId, delta });
const activity = (content: Record<string, unknown>, extra = {}) => ({ type: 'ACTIVITY_SNAPSHOT', messageId: 'message', activityType: 'test', content, ...extra });
const patch = (operations: unknown[]) => ({ type: 'ACTIVITY_DELTA', messageId: 'message', activityType: 'test', patch: operations });
// Snapshot content is an object; a validated root copy can produce a string.
const activityText = (content: string) => [activity({ part: content }), patch([{ op: 'copy', from: '/part', path: '' }])];
const runStarted = (messages: unknown[]) => ({
  type: 'RUN_STARTED', threadId: 'thread', runId: 'run',
  input: { threadId: 'thread', runId: 'run', state: {}, messages, tools: [], context: [], forwardedProps: {} },
});

describe('Turn credential guard follows the client buffers', () => {
  it('releases a disproved prefix and does not carry it into a later delta', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [start(), text('private-')])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [text('safe')])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [text('token')])).toBe(false);
  });

  it('a snapshot with no credential suffix creates no pending message', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [{ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'message', role: 'assistant', content: 'ordinary answer' }] }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
  });

  it('RUN_STARTED seeds a newly introduced prefix without replacing an existing buffer', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [start(), text('safe-'), end()])).toBe(false);
    expect(guard.leaks('', [runStarted([
      { id: 'message', role: 'assistant', content: 'private-' },
      { id: 'new', role: 'assistant', content: 'private-' },
    ])])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [start(), text('token')])).toBe(false);
    expect(guard.leaks('', [text('token', 'new')])).toBe(true);
  });

  it.each(['user', 'reasoning', 'activity'])('a tool result does not belong to a %s message', (role) => {
    const message = role === 'activity'
      ? { id: 'message', role, activityType: 'test', content: { part: 'safe-' } }
      : { id: 'message', role, content: 'safe-' };
    const guard = turnCredentialGuard(credentials, [message]);
    if (role === 'activity') expect(guard.leaks('', [patch([{ op: 'copy', from: '/part', path: '' }])])).toBe(false);
    // A parent ID collision creates a separate assistant; the original keeps its role.
    expect(guard.leaks('', [toolStart('message')])).toBe(false);
    expect(guard.leaks('', [{ type: 'TOOL_CALL_RESULT', messageId: 'message', toolCallId: 'tool', content: 'private-' }])).toBe(false);
    // The existing first message remains the client's append target.
    expect(guard.leaks('', [start(), text('token')])).toBe(false);
  });

  it('inserts a result after its owner and contiguous results, preserving an earlier duplicate ID', () => {
    const guard = turnCredentialGuard(credentials, [
      { id: 'owner', role: 'assistant', content: '', toolCalls: [{ id: 'tool', type: 'function', function: { name: 'execute', arguments: '' } }] },
      { id: 'message', role: 'tool', toolCallId: 'tool', content: 'safe-' },
    ]);
    expect(guard.leaks('', [{ type: 'TOOL_CALL_RESULT', messageId: 'message', toolCallId: 'tool', content: 'private-' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [start(), text('token')])).toBe(false);
  });

  it('an inserted earlier result replaces the append target and clears its previous pending prefix', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [start('owner'), toolStart('owner'), start(), text('private-')])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [{ type: 'TOOL_CALL_RESULT', messageId: 'message', toolCallId: 'tool', content: 'safe-' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [text('token')])).toBe(false);
  });

  it('activity replacement clears a prior text prefix', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [start(), text('private-')])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [activity({ safe: true })])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [text('token')])).toBe(false);
  });

  it('a rejected activity patch preserves the original string buffer', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [...activityText('private-')])).toBe(false);
    expect(guard.leaks('', [patch([{ op: 'test', path: '', value: 'other' }, { op: 'replace', path: '', value: 'safe-' }])])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [text('token')])).toBe(true);
  });

  it('activity text deltas are retained for a later validated JSON patch', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [...activityText('private'), text('-')])).toBe(false);
    expect(guard.leaks('', [patch([{ op: 'test', path: '', value: 'private-' }, { op: 'replace', path: '', value: 'safe-' }])])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [text('token')])).toBe(false);
  });

  it('tool arguments with a passthrough messageId do not append to an activity buffer', () => {
    // The installed @ag-ui/core ToolCallArgsEventSchema is passthrough: an extra
    // messageId is accepted, but the client addresses tool arguments by toolCallId.
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [...activityText('private-'), toolStart('assistant')])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [{ ...toolArgs('safe-'), messageId: 'message' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [patch([
      { op: 'test', path: '', value: 'private-' },
      { op: 'replace', path: '', value: 'safe-' },
    ])])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [text('token')])).toBe(false);
  });

  it('activity append starts from empty text after object content', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [activity({ safe: true }), text('private-')])).toBe(false);
    expect(guard.leaks('', [patch([{ op: 'test', path: '', value: 'private-' }, { op: 'replace', path: '', value: 'safe-' }])])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [text('token')])).toBe(false);
  });

  it('replace:false ignores a snapshot for an existing activity', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [...activityText('private-'), activity({ part: 'safe-' }, { replace: false })])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [text('token')])).toBe(true);
  });

  it('repeated tool starts retain arguments already accumulated by the client', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [start(), toolStart('message'), toolArgs('private-'), { type: 'TOOL_CALL_END', toolCallId: 'tool' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [toolStart('message')])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [{ type: 'MESSAGES_SNAPSHOT', messages: [] }, toolArgs('token')])).toBe(false);
  });

  it('preserves an unrelated tool prefix when a result replaces a same-ID text message', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [start('owner'), toolStart('owner', 'message'), toolArgs('private-', 'message')])).toBe(false);
    expect(guard.leaks('', [{ type: 'TOOL_CALL_RESULT', messageId: 'message', toolCallId: 'message', content: 'safe-' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [toolArgs('token', 'message')])).toBe(true);
  });
});

describe('client chunk boundaries control pending credential prefixes', () => {
  it.each(['TEXT_MESSAGE_CHUNK', 'TOOL_CALL_CHUNK', 'REASONING_MESSAGE_CHUNK'])('an explicit boundary closes an active %s prefix', (type) => {
    const guard = turnCredentialGuard(credentials);
    const identity = type === 'TOOL_CALL_CHUNK' ? { toolCallId: 'tool', toolCallName: 'execute' } : { messageId: 'message' };
    expect(guard.leaks('', [{ type, ...identity, delta: 'private-' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [{ type: 'RUN_FINISHED', threadId: 't', runId: 'r' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
  });

  it('reasoning inherits an empty ID while text treats it as a distinct ID', () => {
    const reasoning = turnCredentialGuard(credentials);
    expect(reasoning.leaks('', [{ type: 'REASONING_MESSAGE_CHUNK', messageId: 'message', delta: 'private-' }])).toBe(false);
    expect(reasoning.leaks('', [{ type: 'REASONING_MESSAGE_CHUNK', messageId: '', delta: 'token' }])).toBe(true);
    const ordinary = turnCredentialGuard(credentials);
    expect(ordinary.leaks('', [{ type: 'TEXT_MESSAGE_CHUNK', messageId: 'message', delta: 'private-' }])).toBe(false);
    expect(ordinary.leaks('', [{ type: 'TEXT_MESSAGE_CHUNK', messageId: '', delta: 'token' }])).toBe(false);
    expect(ordinary.hasPendingPrefix()).toBe(false);
  });

  it('an ID-less first chunk cannot seed a client buffer', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [{ type: 'TEXT_MESSAGE_CHUNK', delta: 'private-' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [{ type: 'TEXT_MESSAGE_CHUNK', messageId: 'message', delta: 'token' }])).toBe(false);
  });

  it('a nameless first tool chunk cannot seed a client buffer', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [{ type: 'TOOL_CALL_CHUNK', toolCallId: 'tool', delta: 'private-' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [{ type: 'TOOL_CALL_CHUNK', toolCallId: 'tool', toolCallName: 'execute', delta: 'token' }])).toBe(false);
  });

  it('a chunk without a delta opens the client message without inventing content', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [{ type: 'TEXT_MESSAGE_CHUNK', messageId: 'message' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(false);
    expect(guard.leaks('', [{ type: 'TEXT_MESSAGE_CHUNK', delta: 'private-' }])).toBe(false);
    expect(guard.hasPendingPrefix()).toBe(true);
    expect(guard.leaks('', [{ type: 'TEXT_MESSAGE_CHUNK', delta: 'token' }])).toBe(true);
  });
});

describe('decoded structured client content', () => {
  it('withholds a credential in one JSON pointer segment after unescaping', () => {
    const guard = turnCredentialGuard(['private/token']);
    expect(guard.leaks('', [{ type: 'STATE_DELTA', delta: [{ op: 'add', path: '/safe/private~1token', value: 'ordinary value' }] }])).toBe(true);
  });

  it('binary message parts separate otherwise adjacent credential fragments', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [{ type: 'MESSAGES_SNAPSHOT', messages: [{ id: 'user', role: 'user', content: [
      { type: 'text', text: 'private-' },
      { type: 'binary', mimeType: 'image/png', data: 'AA==' },
      { type: 'text', text: 'token' },
    ] }] }])).toBe(false);
  });

  it('withholds adjacent multipart text without joining across separate messages', () => {
    const guard = turnCredentialGuard(credentials);
    expect(guard.leaks('', [runStarted([
      { id: 'first', role: 'user', content: [{ type: 'text', text: 'private-' }] },
      { id: 'second', role: 'user', content: [{ type: 'text', text: 'token' }] },
    ])])).toBe(false);
    expect(guard.leaks('', [runStarted([
      { id: 'third', role: 'user', content: [{ type: 'text', text: 'private-' }, { type: 'text', text: 'token' }] },
    ])])).toBe(true);
  });
});

describe('upstream refusal observability', () => {
  it.each([
    ['private-token', "The error body carried the Turn's credentials, so it was withheld", true],
    ['ordinary refusal', 'ordinary refusal', false],
  ])('logs the withholding decision for %s', async (details, expected, withheld) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const upstream: Upstream = { label: 'Test upstream', invoke: async () => new Response(details, { status: 503 }) };
      const response = await relayTurn(upstream, { body: '{}', sessionId: 'session', browserEventName: 'live', saveAgentDocumentEdit: async () => undefined, credentials, finished: async () => undefined, ended: async () => undefined, failed: async () => undefined });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Test upstream returned HTTP 503', details: expected });
      expect(error.mock.calls).toEqual(withheld ? [['Test upstream error status=503 carried a Turn credential; its body was withheld']] : []);
      expect(warn.mock.calls).toEqual([ [`Test upstream error status=503 details=${expected}`] ]);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

// 1616: unrelated non-chunk events cannot release an explicit message prefix.
it('retains an explicit message prefix through unrelated state events', () => {
  const guard = turnCredentialGuard(credentials);
  expect(guard.leaks('', [start(), text('private-')])).toBe(false);
  expect(guard.hasPendingPrefix()).toBe(true);
  expect(guard.leaks('', [{ type: 'STATE_SNAPSHOT', snapshot: {} }])).toBe(false);
  expect(guard.hasPendingPrefix()).toBe(true);
  expect(guard.leaks('', [text('token')])).toBe(true);
});

// 1440: validating JSON Patch paths is distinct from the test operation's checks.
it('a rejected missing-path removal preserves the activity buffer', () => {
  const guard = turnCredentialGuard(credentials);
  expect(guard.leaks('', [activity({ safe: true })])).toBe(false);
  expect(guard.leaks('', [patch([
    { op: 'remove', path: '/missing' },
    { op: 'replace', path: '', value: 'private-' },
  ])])).toBe(false);
  expect(guard.hasPendingPrefix()).toBe(false);
  expect(guard.leaks('', [text('token')])).toBe(false);
});

// 1662: beginning another chunk ID must close its predecessor, not every chunk.
it('an inherited chunk ID remains pending until its actual boundary', () => {
  const guard = turnCredentialGuard(credentials);
  expect(guard.leaks('', [{ type: 'TEXT_MESSAGE_CHUNK', messageId: 'message', delta: 'private-' }])).toBe(false);
  expect(guard.hasPendingPrefix()).toBe(true);
  expect(guard.leaks('', [{ type: 'TEXT_MESSAGE_CHUNK', delta: '' }])).toBe(false);
  expect(guard.hasPendingPrefix()).toBe(true);
  expect(guard.leaks('', [{ type: 'TEXT_MESSAGE_CHUNK', delta: 'token' }])).toBe(true);
});

it('preserves reasoning chunk history after reasoning ends and an empty snapshot arrives', () => {
  const guard = turnCredentialGuard(credentials);
  expect(guard.leaks('', [{ type: 'REASONING_MESSAGE_CHUNK', messageId: 'reasoning', delta: 'private-' }])).toBe(false);
  expect(guard.leaks('', [{ type: 'REASONING_END', messageId: 'reasoning' }])).toBe(false);
  expect(guard.leaks('', [{ type: 'MESSAGES_SNAPSHOT', messages: [] }])).toBe(false);
  expect(guard.hasPendingPrefix()).toBe(true);
  expect(guard.leaks('', [{ type: 'REASONING_MESSAGE_CHUNK', messageId: 'reasoning', delta: 'token' }])).toBe(true);
});
