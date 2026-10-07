import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

// A Harness older than the Chat Service leaves the Files binding
// in its forwarded props, which LangGraph merges into the agent's state, so
// the Turn's STATE_SNAPSHOT carried the Files-sync credentials to the browser.
const FILES = {
  bucket: 'files-bucket',
  prefix: 'accounts/acct-1/',
  region: 'us-east-1',
  accessKeyId: 'ASIAFILESSYNCKEY',
  secretAccessKey: 'files/sync+secret=',
  sessionToken: 'files-sync/session+token==',
};

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess({
    cartridge: {
      invocationPayload: async (input) => ({ ...input, forwardedProps: { ...input.forwardedProps, files: FILES } }),
    },
  });
});
afterAll(() => stack.stop());

async function turn(threadId: string): Promise<string> {
  const response = await stack.app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: {} }),
  });
  expect(response.status).toBe(200);
  return response.text();
}

describe("a credential the Cartridge forwards in its own prop", () => {
  it('never reaches the client', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const signed = await startInProcess({
      cartridge: {
        invocationPayload: async (input) => ({ ...input, forwardedProps: { signedToken: 'v1.signed.token' } }),
        credentialProps: ['signedToken'],
      },
    });
    try {
      const threadId = 'credentials-cartridge-prop';
      signed.agentcore.script(threadId, {
        kind: 'stream',
        frames: [`data: ${JSON.stringify({ type: 'STATE_SNAPSHOT', snapshot: { signedToken: 'v1.signed.token' } })}`],
      });

      const response = await signed.app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: {} }),
      });

      expect(await response.text()).toContain('TURN_CREDENTIALS_IN_STREAM');
    } finally {
      await signed.stop();
    }
  });
});

describe('original client history without an upstream input echo', () => {
  it.each([
    ['same message ID', 'x', 'private-', 'TURN_CREDENTIALS_IN_STREAM'],
    ['different message ID', 'other', 'private-', '"delta":"token"'],
    ['safe history', 'x', 'safe-', '"delta":"token"'],
  ])('checks %s before relay even when the Cartridge transforms messages', async (_, historyId, prefix, expected) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const history = await startInProcess({ cartridge: {
      invocationPayload: async (input) => {
        input.messages.length = 0;
        return { ...input, forwardedProps: { signedToken: 'private-token' } };
      },
      credentialProps: ['signedToken'],
    } });
    try {
      const threadId = `history-${historyId}-${prefix}`;
      history.agentcore.script(threadId, { kind: 'stream', frames: [
        { type: 'RUN_STARTED', threadId, runId: 'run-1' },
        { type: 'TEXT_MESSAGE_START', messageId: 'x', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'x', delta: 'token' },
        { type: 'TEXT_MESSAGE_END', messageId: 'x' },
      ].map((event) => `data: ${JSON.stringify(event)}`) });
      const response = await history.app.request('/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, runId: 'run-1', state: {}, messages: [{ id: historyId, role: 'assistant', content: prefix }], tools: [], context: [], forwardedProps: {} }),
      });
      expect(await response.text()).toContain(expected);
      expect(history.agentcore.invocationFor(threadId).payload.messages).toEqual([]);
    } finally {
      await history.stop();
    }
  });
});

describe('earlier messages the client holds but did not send', () => {
  const held = { heldMessageIds: ['m1', 'a1'], heldToolCallIds: ['call-1'] };
  const request = (threadId: string) => stack.app.request('/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, runId: 'run-1', state: {}, messages: [{ id: 'u2', role: 'user', content: 'And now?' }], tools: [], context: [], forwardedProps: held }),
  });

  it.each([
    ['an earlier message', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'more' }],
    ['an earlier message in chunks', { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', delta: 'more' }],
    ['an earlier reasoning message', { type: 'REASONING_MESSAGE_CONTENT', messageId: 'm1', delta: 'more' }],
    ['an earlier tool call',{ type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', delta: '{}' }],
    ['an earlier activity', { type: 'ACTIVITY_DELTA', messageId: 'a1', activityType: 'browser', patch: [] }],
  ])('fails a stream that writes to %s, which the guard cannot check', async (_, event) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const threadId = `held-${JSON.stringify(event)}`;
    stack.agentcore.script(threadId, { kind: 'stream', frames: [{ type: 'RUN_STARTED', threadId, runId: 'run-1' }, event].map((frame) => `data: ${JSON.stringify(frame)}`) });

    const body = await (await request(threadId)).text();

    expect(body).toContain('TURN_EARLIER_MESSAGE_IN_STREAM');
    expect(body).not.toContain(JSON.stringify(event));
  });

  it('relays a stream that writes only new messages, and keeps the held IDs from the Harness', async () => {
    const threadId = 'held-new-only';
    const frames = [
      { type: 'RUN_STARTED', threadId, runId: 'run-1' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'Still none.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm2' },
    ].map((frame) => `data: ${JSON.stringify(frame)}`);
    stack.agentcore.script(threadId, { kind: 'stream', frames });

    const body = await (await request(threadId)).text();

    expect(body).toContain('"delta":"Still none."');
    expect(stack.agentcore.invocationFor(threadId).payload.forwardedProps).not.toHaveProperty('heldMessageIds');
    expect(stack.agentcore.invocationFor(threadId).payload.forwardedProps).not.toHaveProperty('heldToolCallIds');
  });

  // An empty ID would match every event that names no message, so it would fail every Turn.
  it.each([['not a list', 'm1'], ['an empty ID', ['m1', '']]])('refuses held IDs that are %s', async (_, heldMessageIds) => {
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'held-malformed', runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: { heldMessageIds } }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'heldMessageIds must be a list of IDs' });
  });
});

describe('multipart message credentials on the public Turn route', () => {
  it.each(['RUN_STARTED', 'MESSAGES_SNAPSHOT'])('withholds client-retained credential parts in %s', async (type) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const threadId = `multipart-${type}`;
    const messages = [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'ASIAFILES' }, { type: 'text', text: 'SYNCKEY' }] }];
    const event = type === 'MESSAGES_SNAPSHOT' ? { type, messages } : { type, threadId, runId: 'run-1', input: { threadId, runId: 'run-1', messages, tools: [], context: [], state: {}, forwardedProps: {} } };
    stack.agentcore.script(threadId, { kind: 'stream', frames: [`data: ${JSON.stringify(event)}`] });
    const body = await turn(threadId);
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain('ASIAFILES');
  });
});

describe('JSON Pointer credential segments on the public Turn route', () => {
  it.each([
    { op: 'add', path: '/files~1sync+secret=', value: true },
    { op: 'copy', from: '/files~1sync+secret=', path: '/copied' },
  ])('withholds decoded credential segments in $op', async (operation) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const threadId = `pointer-${operation.op}`;
    stack.agentcore.script(threadId, { kind: 'stream', frames: [`data: ${JSON.stringify({ type: 'STATE_DELTA', delta: [operation] })}`] });
    expect(await turn(threadId)).toContain('TURN_CREDENTIALS_IN_STREAM');
  });
  it.each([
    { op: 'add', path: '/folder~1name~0draft', value: 'safe' },
    { op: 'add', path: '/files~01sync+secret=', value: true },
    { op: 'copy', from: '/folder~1name~0draft', path: '/copied' },
  ])('preserves normal noncredential pointer escapes in $op', async (operation) => {
    const threadId = `safe-pointer-${JSON.stringify(operation)}`;
    const frame = `data: ${JSON.stringify({ type: 'STATE_DELTA', delta: [operation] })}`;
    stack.agentcore.script(threadId, { kind: 'stream', frames: [frame] });
    expect(await turn(threadId)).toBe(
      `${frame}\n\n` +
        'data: {"type":"RUN_ERROR","message":"AgentCore upstream stream ended before the Turn finished","code":"AGENTCORE_UPSTREAM_STREAM_ERROR"}\n\n',
    );
  });
});

// A tokened CDP URL's token alone authenticates the CDP channel.
describe("the query token of a credential URL the Cartridge forwards", () => {
  it('never reaches the client on its own', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tokened = await startInProcess({
      cartridge: {
        invocationPayload: async (input) => ({
          ...input,
          forwardedProps: { cdpUrl: 'ws://computer.internal/cdp?token=cdp.signed.token' },
        }),
        credentialProps: ['cdpUrl'],
      },
    });
    try {
      const threadId = 'credentials-cdp-token';
      tokened.agentcore.script(threadId, {
        kind: 'stream',
        frames: [`data: ${JSON.stringify({ type: 'STATE_SNAPSHOT', snapshot: { token: 'cdp.signed.token' } })}`],
      });

      const response = await tokened.app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: {} }),
      });

      const body = await response.text();
      expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
      expect(body).not.toContain('cdp.signed.token');
    } finally {
      await tokened.stop();
    }
  });
});

describe("a Turn's empty Files-sync credential", () => {
  it('withholds nothing, since it matches every frame', async () => {
    const empty = await startInProcess({
      cartridge: {
        invocationPayload: async (input) => ({
          ...input,
          forwardedProps: { ...input.forwardedProps, files: { ...FILES, sessionToken: '' } },
        }),
      },
    });
    try {
      const threadId = 'credentials-empty';
      const frames = ['data: {"type":"RUN_STARTED"}', 'data: {"type":"RUN_FINISHED"}'];
      empty.agentcore.script(threadId, { kind: 'stream', frames });

      const response = await empty.app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId, runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: {} }),
      });

      expect(await response.text()).toBe(frames.map((frame) => `${frame}\n\n`).join(''));
    } finally {
      await empty.stop();
    }
  });
});

describe("a Turn's Files-sync credentials", () => {
  it.each([
    ['accessKeyId', FILES.accessKeyId],
    ['secretAccessKey', FILES.secretAccessKey],
    ['sessionToken', FILES.sessionToken],
  ])('never reach the client, even when the Harness streams its %s back', async (field, value) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const threadId = `credentials-${field}`;
    stack.agentcore.script(threadId, {
      kind: 'stream',
      frames: [
        'data: {"type":"RUN_STARTED"}',
        `data: ${JSON.stringify({ type: 'STATE_SNAPSHOT', snapshot: { messages: [], files: { [field]: value } } })}`,
        'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"after"}',
        'data: {"type":"RUN_FINISHED"}',
      ],
    });

    const body = await turn(threadId);

    expect(stack.agentcore.invocationFor(threadId).payload.forwardedProps.files).toEqual(FILES);
    expect(body).toBe(
      'data: {"type":"RUN_STARTED"}\n\n' +
        `data: ${JSON.stringify({
          type: 'RUN_ERROR',
          message: "The agent's answer carried the Turn's credentials, so it was withheld",
          code: 'TURN_CREDENTIALS_IN_STREAM',
        })}\n\n`,
    );
  });

  it.each([
    ['accessKeyId', FILES.accessKeyId],
    ['secretAccessKey', FILES.secretAccessKey],
    ['sessionToken', FILES.sessionToken],
  ])('withholds a %s split across message deltas', async (field, value) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const threadId = `credentials-split-${field}`;
    const split = Math.floor(value.length / 2);
    stack.agentcore.script(threadId, {
      kind: 'stream',
      frames: [
        'data: {"type":"RUN_STARTED"}',
        ...[value.slice(0, split), value.slice(split)].map((delta) =>
          `data: ${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta })}`,
        ),
        'data: {"type":"RUN_FINISHED"}',
      ],
    });

    const body = await turn(threadId);

    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain(value.slice(0, split));
    expect(body).not.toContain(value.slice(split));
    expect(body).not.toContain('RUN_FINISHED');
  });

  it.each([
    ['accessKeyId', FILES.accessKeyId],
    ['secretAccessKey', FILES.secretAccessKey],
    ['sessionToken', FILES.sessionToken],
  ])('withholds a %s split across tool argument deltas', async (field, value) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const threadId = `credentials-tool-split-${field}`;
    const split = Math.floor(value.length / 2);
    stack.agentcore.script(threadId, {
      kind: 'stream',
      frames: [
        'data: {"type":"TOOL_CALL_START","toolCallId":"t1","toolCallName":"browser"}',
        ...[`{"command":"${value.slice(0, split)}`, `${value.slice(split)}"}`].map((delta) =>
          `data: ${JSON.stringify({ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta })}`,
        ),
        'data: {"type":"TOOL_CALL_END","toolCallId":"t1"}',
      ],
    });

    const body = await turn(threadId);

    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain(value.slice(0, split));
    expect(body).not.toContain(value.slice(split));
    expect(body).not.toContain('TOOL_CALL_END');
  });

  it.each([
    ['STATE_SNAPSHOT', { type: 'STATE_SNAPSHOT', snapshot: { files: { secretAccessKey: FILES.secretAccessKey } } }],
    ['RUN_ERROR', { type: 'RUN_ERROR', code: 'X', message: `sync failed for ${FILES.secretAccessKey}` }],
  ])('withholds decoded credentials in an escaped %s before relay or logging', async (type, event) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const threadId = `credentials-escaped-${type}`;
    stack.agentcore.script(threadId, {
      kind: 'stream',
      frames: [`data: ${JSON.stringify(event).replaceAll('/', '\\/')}`],
    });

    const body = await turn(threadId);

    expect(logged.mock.calls.flat().map(String).join('\n').includes(FILES.secretAccessKey)).toBe(false);
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain(JSON.stringify(event).replaceAll('/', '\\/'));
    expect(body).not.toContain('sync failed');
  });

  it('are never written to the log, even in a run error the Harness sends', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const threadId = 'credentials-run-error';
    stack.agentcore.script(threadId, {
      kind: 'stream',
      frames: [
        'data: {"type":"RUN_STARTED"}',
        `data: ${JSON.stringify({ type: 'RUN_ERROR', code: 'X', message: `sync failed for ${FILES.secretAccessKey}` })}`,
      ],
    });

    const body = await turn(threadId);

    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(logged.mock.calls.flat().map(String).join('\n')).not.toContain(FILES.secretAccessKey);
  });

  it("leave a stream that does not carry them as the Harness sent it", async () => {
    const threadId = 'credentials-absent';
    const frames = [
      'data: {"type":"RUN_STARTED"}',
      `data: ${JSON.stringify({ type: 'STATE_SNAPSHOT', snapshot: { messages: [], files: {} } })}`,
      'data: {"type":"RUN_FINISHED"}',
    ];
    stack.agentcore.script(threadId, { kind: 'stream', frames });

    expect(await turn(threadId)).toBe(frames.map((frame) => `${frame}\n\n`).join(''));
  });
});
