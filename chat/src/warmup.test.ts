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
    const response = await postWarmup(stack, '{"threadId":"warm-session","model":"thorough","effort":"high"}');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    const invocation = stack.agentcore.invocationFor('warm-session');
    expect(invocation.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toMatch(/^runtime-[0-9a-f-]{36}$/);
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
        memoryRevision: 0,
        sessionUserId: 'filed-account-1',
      },
    });
  });

  it("warms the account's default model, the one its model selector starts on, when the warmup names none", async () => {
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

  it.each([400, 500])('reports a warmup the Runtime answers with HTTP %i as 502', async (status) => {
    stack.agentcore.script(`warm-rejected-${status}`, { kind: 'error', status, body: '{}' });

    const response = await postWarmup(stack, `{"threadId":"warm-rejected-${status}"}`);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'AgentCore warmup failed', details: `HTTP ${status}` });
  });

  it('accepts a warmup the Runtime answers below HTTP 400', async () => {
    stack.agentcore.script('warm-redirected', { kind: 'error', status: 399, body: '{}' });

    const response = await postWarmup(stack, '{"threadId":"warm-redirected"}');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('accepts a warmup the Runtime answers with no body', async () => {
    stack.agentcore.script('warm-empty', { kind: 'error', status: 204, body: '' });

    const response = await postWarmup(stack, '{"threadId":"warm-empty"}');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it("reports a warmup whose agent build the Harness fails as 502", async () => {
    const error = { type: 'RUN_ERROR', message: 'model relay unavailable', code: 'INTERNAL_ERROR' };
    stack.agentcore.script('warm-build-failed', { kind: 'stream', frames: [`data: ${JSON.stringify(error)}`] });

    const response = await postWarmup(stack, '{"threadId":"warm-build-failed"}');

    expect(response.status).toBe(502);
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
      signed.agentcore.script('warm-build-leaks', { kind: 'stream', frames: [`data: ${JSON.stringify(error)}`] });

      const response = await postWarmup(signed, '{"threadId":"warm-build-leaks"}');

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: 'AgentCore warmup failed',
        details: "The error body carried the Turn's credentials, so it was withheld",
      });
    } finally {
      await signed.stop();
    }
  });

  it('reports a malformed warmup frame without credentials as 502', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stack.agentcore.script('warm-malformed', { kind: 'stream', frames: ['data: not-json'] });

    const response = await postWarmup(stack, '{"threadId":"warm-malformed"}');

    expect(response.status).toBe(502);
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
      signed.agentcore.script('warm-malformed-leaks', { kind: 'stream', frames: ['data: v1.signed.token'] });

      const response = await postWarmup(signed, '{"threadId":"warm-malformed-leaks"}');

      expect(response.status).toBe(502);
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
      signed.agentcore.script('warm-malformed-escaped', { kind: 'stream', frames: ['data: v1.signed.\\u0074oken'] });

      const response = await postWarmup(signed, '{"threadId":"warm-malformed-escaped"}');

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: 'AgentCore warmup failed',
        details: 'SyntaxError: The Runtime sent a warmup frame that is not JSON',
      });
      expect(String(warn.mock.calls)).not.toContain('v1.signed.');
    } finally {
      await signed.stop();
    }
  });

  it('reports a warmup the Runtime does not answer within the warmup timeout as 502', async () => {
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
      expect((response as Response).status).toBe(502);
      expect(await (response as Response).json()).toEqual({
        error: 'AgentCore warmup failed',
        details: 'TimeoutError: The operation was aborted due to timeout',
      });
    } finally {
      await Promise.all([target.stop(), runtime.close()]);
    }
  });

  it('reports a warmup that cannot reach the Runtime as 502', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unreachable = await startInProcess();
    await unreachable.agentcore.close();
    try {
      const response = await postWarmup(unreachable, '{}');

      expect(response.status).toBe(502);
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
    const response = postWarmup(session, '{"threadId":"warm-slow-session"}');

    await vi.waitFor(() => session.agentcore.invocationFor('warm-slow-session'));
    release();
    expect((await response).status).toBe(200);
  });

  it('and answers its failure', async () => {
    const response = await postWarmup(session, '{"threadId":"warm-refused-session"}');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: 'The computer is busy' });
  });

  it('answers an AgentCore failure without waiting for the Cartridge sibling', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const target = await startInProcess({ cartridge: { warmSession: () => held } });
    target.agentcore.script('warm-fail-fast', { kind: 'error', status: 500, body: '{}' });
    let answer: Response | undefined;
    const request = Promise.resolve(postWarmup(target, '{"threadId":"warm-fail-fast"}')).then((response) => { answer = response; });
    try {
      await vi.waitFor(() => expect(answer?.status).toBe(502), { timeout: 500 });
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
