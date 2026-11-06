import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpError } from './cartridge.js';
import { HttpFake } from '../test/fakes/http-fake.js';
import { RUNTIME_ARN } from '../test/fakes/stack.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

const WARMUP_SESSION_ID = '__warmup__000000000000000000000000';

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess();
});
afterAll(() => stack.stop());
afterEach(() => vi.restoreAllMocks());

const postWarmup = (target: InProcessStack, body?: BodyInit) =>
  target.app.request('/warmup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ?? null });

describe('POST /warmup', () => {
  it("sends the requester's Turn invocation with no message, so the Harness builds their agent before the Turn", async () => {
    await stack.allocate('account-1', 'warm-session');
    const response = await postWarmup(stack, '{"threadId":"warm-session","model":"thorough","effort":"high"}');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    const invocation = stack.agentcore.invocationFor('warm-session');
    expect(invocation.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe('warm-session');
    expect(invocation.payload).toEqual({
      threadId: 'warm-session',
      runId: '__warmup__',
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {
        model: 'thorough',
        effort: 'high',
        warmup: true,
        agentIdentity: { name: 'Test Bot', character: 'A test agent', vibe: 'Plain', avatar: '' },
        soul: 'Be brief.',
        sessionUserId: 'filed-account-1',
      },
    });
  });

  it('logs one chat_warmup_timing line with each stage offset, so a slow warmup shows which stage took the time', async () => {
    await stack.allocate('account-1', 'warm-timed');
    const log = vi.spyOn(console, 'info');

    expect((await postWarmup(stack, '{"threadId":"warm-timed"}')).status).toBe(200);

    const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('{"event":"chat_warmup_timing"'));
    expect(lines).toHaveLength(1);
    const timing = JSON.parse(String(lines[0])) as { sessionId: string; outcome: string; chatMs: Record<string, number> };
    expect(timing).toMatchObject({ sessionId: 'warm-timed', outcome: 'ok' });
    expect(Object.keys(timing.chatMs)).toEqual(expect.arrayContaining(['props', 'dispatch', 'identity', 'invoke', 'answer', 'session', 'end']));
    const ordered = ['props', 'dispatch', 'identity', 'invoke', 'answer', 'end'].map((stage) => timing.chatMs[stage] ?? Number.NaN);
    expect(ordered).toEqual([...ordered].sort((x, y) => x - y));
    expect(timing.chatMs.end).toBeGreaterThanOrEqual(timing.chatMs.session ?? Number.NaN);
  });

  it('logs a failed chat_warmup_timing line for a warmup the Runtime refuses', async () => {
    await stack.allocate('account-1', 'warm-timed-refused');
    stack.agentcore.script('warm-timed-refused', { kind: 'error', status: 500, body: null });
    const log = vi.spyOn(console, 'info');

    expect((await postWarmup(stack, '{"threadId":"warm-timed-refused"}')).status).toBeGreaterThanOrEqual(500);

    const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('{"event":"chat_warmup_timing"'));
    expect(lines.map((line) => (JSON.parse(line) as { outcome: string }).outcome)).toEqual(['failed']);
  });

  it('holds a Turn sent while its chat is still warming until the warmup ends, instead of failing it SESSION_BUSY', async () => {
    await stack.allocate('account-1', 'warm-then-send');
    let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    stack.agentcore.script('warm-then-send', { kind: 'stream', frames: ['data: {"type":"RUN_STARTED"}', 'data: {"type":"RUN_FINISHED"}'], hold });
    const warming = postWarmup(stack, '{"threadId":"warm-then-send"}');
    await vi.waitFor(() => expect(stack.agentcore.invocationFor('warm-then-send')).toBeDefined());

    const sending = stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'warm-then-send', runId: 'instant-send', state: {}, messages: [{ id: 'm', role: 'user', content: 'Hello' }], tools: [], context: [], forwardedProps: { model: 'quick' } }),
    });
    await Promise.race([sending, new Promise((resolve) => setTimeout(resolve, 500))]);
    release();
    const answer = await (await sending).text();

    expect(answer).not.toContain('SESSION_BUSY');
    expect(answer).toContain('RUN_FINISHED');
    expect((await warming).status).toBe(200);
    expect(stack.agentcore.invocations().filter(({ body }) => body.includes('warm-then-send'))).toHaveLength(2);
  });

  it('does not hold a Turn for a warmup that was refused', async () => {
    await stack.allocate('account-1', 'warm-refused-then-send');
    expect((await postWarmup(stack, '{"threadId":"warm-refused-then-send","model":"other"}')).status).toBe(422);

    const answer = await (await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'warm-refused-then-send', runId: 'after-refusal', state: {}, messages: [{ id: 'm', role: 'user', content: 'Hello' }], tools: [], context: [], forwardedProps: { model: 'quick' } }),
    })).text();

    expect(answer).toContain('RUN_FINISHED');
  });

  it("warms the account's default model, the one its model selector starts on, when the warmup names none", async () => {
    await stack.allocate('account-1', 'warm-default');
    await postWarmup(stack, '{"threadId":"warm-default"}');

    expect(stack.agentcore.invocationFor('warm-default').payload.forwardedProps).toMatchObject({ model: 'plan' });
  });

  it("warms the requester's Main Chat by name, so it need not wait for the Main Chat's replay", async () => {
    const response = await postWarmup(stack, '{"mainChat":true}');

    expect(response.status).toBe(200);
    const { id } = (await (await stack.app.request('/main-chat')).json()) as { id: string };
    expect(stack.agentcore.invocationFor(id).payload).toMatchObject({ threadId: id, forwardedProps: { warmup: true } });
  });

  it('refuses to warm a model the account may not use, as a Turn would', async () => {
    await stack.allocate('account-1', 'warm-refused');
    const response = await postWarmup(stack, '{"threadId":"warm-refused","model":"other"}');

    expect(response.status).toBe(422);
  });

  it.each([
    ['no body', undefined],
    ['no threadId', '{}'],
    ['an empty threadId', '{"threadId":""}'],
    ['a threadId that is not a string', '{"threadId":42}'],
  ])('warms the placeholder Session given %s', async (_, body) => {
    const target = await startInProcess();
    try {
      const response = await postWarmup(target, body);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
      const invocation = target.agentcore.invocationFor(WARMUP_SESSION_ID);
      expect(invocation.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(WARMUP_SESSION_ID);
    } finally {
      await target.stop();
    }
  });

  it.each([
    ['truncated JSON', '{', 'SyntaxError: Expected property name or \'}\' in JSON at position 1 (line 1 column 2)'],
    ['non-UTF-8 bytes', new Blob([new Uint8Array([0xff])]), 'TypeError: The encoded data was not valid for encoding utf-8'],
  ])('rejects a warmup body of %s with 400', async (_, body, details) => {
    const response = await postWarmup(stack, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid warmup JSON', details });
  });

  it.each([
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a JSON string', '"warm"'],
  ])('rejects a warmup body of %s with 400', async (_, body) => {
    const response = await postWarmup(stack, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid warmup JSON', details: 'Expected JSON object.' });
  });

  it.each([400, 500])('reports a warmup the Runtime answers with HTTP %i as 503', async (status) => {
    await stack.allocate('account-1', `warm-rejected-${status}`);
    stack.agentcore.script(`warm-rejected-${status}`, { kind: 'error', status, body: '{}' });

    const response = await postWarmup(stack, `{"threadId":"warm-rejected-${status}"}`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AgentCore warmup failed', details: `HTTP ${status}` });
  });

  it('accepts a warmup the Runtime answers below HTTP 400', async () => {
    await stack.allocate('account-1', 'warm-redirected');
    stack.agentcore.script('warm-redirected', { kind: 'error', status: 399, body: '{}' });

    const response = await postWarmup(stack, '{"threadId":"warm-redirected"}');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('accepts a warmup the Runtime answers with no body', async () => {
    await stack.allocate('account-1', 'warm-empty');
    stack.agentcore.script('warm-empty', { kind: 'error', status: 204, body: '' });

    const response = await postWarmup(stack, '{"threadId":"warm-empty"}');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it("reports a warmup whose agent build the Harness fails as 503", async () => {
    const error = { type: 'RUN_ERROR', message: 'model relay unavailable', code: 'INTERNAL_ERROR' };
    await stack.allocate('account-1', 'warm-build-failed');
    stack.agentcore.script('warm-build-failed', { kind: 'stream', frames: [`data: ${JSON.stringify(error)}`] });

    const response = await postWarmup(stack, '{"threadId":"warm-build-failed"}');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AgentCore warmup failed', details: 'model relay unavailable' });
  });

  it("withholds a failed agent build's message that carries the Turn's credentials", async () => {
    const signed = await startInProcess({
      cartridge: {
        invocationPayload: async (input) => ({ ...input, forwardedProps: { ...input.forwardedProps, signedToken: 'v1.signed.token' } }),
        credentialProps: ['signedToken'],
      },
    });
    try {
      const error = { type: 'RUN_ERROR', message: 'relay refused token v1.signed.token', code: 'INTERNAL_ERROR' };
      await signed.allocate('account-1', 'warm-build-leaks');
      signed.agentcore.script('warm-build-leaks', { kind: 'stream', frames: [`data: ${JSON.stringify(error)}`] });

      const response = await postWarmup(signed, '{"threadId":"warm-build-leaks"}');

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'AgentCore warmup failed',
        details: "The error body carried the Turn's credentials, so it was withheld",
      });
    } finally {
      await signed.stop();
    }
  });

  it('reads a warmup error after an SSE comment with CRLF boundaries', async () => {
    await stack.allocate('account-1', 'warm-crlf');
    stack.agentcore.script('warm-crlf', { kind: 'stream', frames: [
      ': keepalive\r\n\r\ndata: {"type":"RUN_ERROR","message":"model unavailable"}',
    ] });
    const response = await postWarmup(stack, '{"threadId":"warm-crlf"}');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AgentCore warmup failed', details: 'model unavailable' });
  });

  it('reports the warmup error after one malformed data frame', async () => {
    await stack.allocate('account-1', 'warm-recover');
    stack.agentcore.script('warm-recover', { kind: 'stream', frames: [
      'data: not-json',
      'data: {"type":"RUN_ERROR","message":"model unavailable"}',
    ] });
    const response = await postWarmup(stack, '{"threadId":"warm-recover"}');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AgentCore warmup failed', details: 'model unavailable' });
  });

  it('accepts a completed warmup after one malformed data frame', async () => {
    await stack.allocate('account-1', 'warm-recovered');
    stack.agentcore.script('warm-recovered', { kind: 'stream', frames: [
      'data: not-json',
      'data: {"type":"RUN_FINISHED"}',
    ] });
    const response = await postWarmup(stack, '{"threadId":"warm-recovered"}');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('rejects a JSON frame without an event type', async () => {
    await stack.allocate('account-1', 'warm-invalid-event');
    stack.agentcore.script('warm-invalid-event', { kind: 'stream', frames: ['data: {"message":"not an event"}'] });
    const response = await postWarmup(stack, '{"threadId":"warm-invalid-event"}');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'AgentCore warmup failed', details: 'SyntaxError: The Runtime sent an invalid AG-UI event stream',
    });
  });

  it('reports a malformed warmup frame without credentials as 503', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await stack.allocate('account-1', 'warm-malformed');
    stack.agentcore.script('warm-malformed', { kind: 'stream', frames: ['data: not-json'] });

    const response = await postWarmup(stack, '{"threadId":"warm-malformed"}');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'AgentCore warmup failed',
      details: expect.stringContaining('SyntaxError:'),
    });
    expect(warn).toHaveBeenCalledWith('warmup failed', expect.any(SyntaxError));
  });

  it("withholds a malformed warmup frame that carries the Turn's credentials", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const signed = await startInProcess({
      cartridge: {
        invocationPayload: async (input) => ({ ...input, forwardedProps: { ...input.forwardedProps, signedToken: 'v1.signed.token' } }),
        credentialProps: ['signedToken'],
      },
    });
    try {
      await signed.allocate('account-1', 'warm-malformed-leaks');
      signed.agentcore.script('warm-malformed-leaks', { kind: 'stream', frames: ['data: v1.signed.token', 'data: {"type":"RUN_FINISHED"}'] });

      const response = await postWarmup(signed, '{"threadId":"warm-malformed-leaks"}');

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'AgentCore warmup failed',
        details: "The error body carried the Turn's credentials, so it was withheld",
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await signed.stop();
    }
  });

  it("reports a malformed warmup frame without quoting it, since it may carry the Turn's credentials JSON-escaped", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const signed = await startInProcess({
      cartridge: {
        invocationPayload: async (input) => ({ ...input, forwardedProps: { ...input.forwardedProps, signedToken: 'v1.signed.token' } }),
        credentialProps: ['signedToken'],
      },
    });
    try {
      await signed.allocate('account-1', 'warm-malformed-escaped');
      signed.agentcore.script('warm-malformed-escaped', { kind: 'stream', frames: ['data: v1.signed.\\u0074oken'] });

      const response = await postWarmup(signed, '{"threadId":"warm-malformed-escaped"}');

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'AgentCore warmup failed',
        details: 'SyntaxError: The Runtime sent an invalid AG-UI event stream',
      });
      expect(String(warn.mock.calls)).not.toContain('v1.signed.');
    } finally {
      await signed.stop();
    }
  });

  it('reports a warmup the Runtime does not answer within the warmup timeout as 503', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = await new HttpFake(() => undefined).listen();
    const target = await startInProcess({
      config: { agentCore: { arn: RUNTIME_ARN, region: 'us-east-1', endpoint: runtime.url }, warmupTimeoutMs: 200 },
    });
    try {
      const started = Date.now();
      // A bound of our own, so a warmup that waits forever fails this test rather than timing it out.
      const response = await Promise.race([
        postWarmup(target, '{}'),
        new Promise<string>((resolve) => setTimeout(() => resolve('still waiting after 2 s'), 2_000)),
      ]);

      expect(response).toBeInstanceOf(Response);
      expect(Date.now() - started).toBeGreaterThanOrEqual(190);
      expect((response as Response).status).toBe(503);
      expect(await (response as Response).json()).toEqual({
        error: 'AgentCore warmup failed',
        details: 'TimeoutError: The operation was aborted due to timeout',
      });
    } finally {
      await Promise.all([target.stop(), runtime.close()]);
    }
  });

  it('reports a warmup that cannot reach the Runtime as 503', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unreachable = await startInProcess();
    await unreachable.agentcore.close();
    try {
      const response = await postWarmup(unreachable, '{}');

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'AgentCore warmup failed', details: 'TypeError: fetch failed' });
      expect(consoleWarn.mock.calls).toEqual([['warmup failed', expect.any(TypeError)]]);
    } finally {
      await unreachable.stop();
    }
  });

  it('is skipped when no Runtime is configured', async () => {
    const bare = await startInProcess({ config: { agentCore: null } });
    try {
      const response = await postWarmup(bare, '{"threadId":"warm-skipped"}');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'skipped', reason: 'AGENTCORE_RUNTIME_ARN not configured' });
      expect(bare.agentcore.invocations()).toEqual([]);
    } finally {
      await bare.stop();
    }
  });
});

describe("POST /warmup readies the Cartridge's side of the chat", () => {
  const warmed: [string, string][] = [];
  let release = () => {};
  let session: InProcessStack;
  beforeAll(async () => {
    session = await startInProcess({
      cartridge: {
        warmSession: async ({ owner }, sessionId) => {
          warmed.push([owner, sessionId]);
          if (sessionId === 'warm-refused-session') throw new HttpError(409, 'The computer is busy');
          if (sessionId === 'warm-slow-session') await new Promise<void>((resolve) => (release = resolve));
        },
      },
    });
  });
  afterAll(() => session.stop());

  it('for the chat the requester opened (ADR 0077)', async () => {
    await session.allocate('account-1', 'warm-opened');
    const response = await postWarmup(session, '{"threadId":"warm-opened"}');

    expect(response.status).toBe(200);
    expect(warmed).toContainEqual(['account-1', 'warm-opened']);
  });

  it('for the Main Chat by name', async () => {
    await postWarmup(session, '{"mainChat":true}');

    const { id } = (await (await session.app.request('/main-chat')).json()) as { id: string };
    expect(warmed).toContainEqual(['account-1', id]);
  });

  it('while the agent builds, so neither waits for the other', async () => {
    await session.allocate('account-1', 'warm-slow-session');
    const response = postWarmup(session, '{"threadId":"warm-slow-session"}');

    await vi.waitFor(() => session.agentcore.invocationFor('warm-slow-session'));
    release();
    expect((await response).status).toBe(200);
  });

  it('and answers its failure', async () => {
    await session.allocate('account-1', 'warm-refused-session');
    const response = await postWarmup(session, '{"threadId":"warm-refused-session"}');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: 'The computer is busy' });
  });

  it('answers an AgentCore failure without waiting for the Cartridge sibling', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const target = await startInProcess({ cartridge: { warmSession: () => held } });
    await target.allocate('account-1', 'warm-fail-fast');
    target.agentcore.script('warm-fail-fast', { kind: 'error', status: 500, body: '{}' });
    let answer: Response | undefined;
    const request = Promise.resolve(postWarmup(target, '{"threadId":"warm-fail-fast"}')).then((response) => { answer = response; });
    try {
      await vi.waitFor(() => expect(answer?.status).toBe(503), { timeout: 500 });
      expect(await answer?.json()).toEqual({ error: 'AgentCore warmup failed', details: 'HTTP 500' });
    } finally {
      release();
      await request;
      await target.stop();
    }
  });

  it('only for a named chat, not the placeholder Session', async () => {
    const before = warmed.length;

    await postWarmup(session, '{}');

    expect(warmed).toHaveLength(before);
  });
});
