import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpFake } from '../test/fakes/http-fake.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';
import { HttpError } from './cartridge.js';

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess();
});
afterAll(() => stack.stop());
afterEach(() => vi.restoreAllMocks());

const turn = (threadId: string, messages: unknown[] = [{ id: 'm1', role: 'user', content: 'hello' }]) =>
  JSON.stringify({ threadId, runId: 'run-1', state: {}, messages, tools: [], context: [], forwardedProps: {} });

const postTurn = (target: InProcessStack, body: string, headers: Record<string, string> = {}) =>
  target.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

async function titleOf(threadId: string, messages: unknown[]): Promise<string> {
  await (await postTurn(stack, turn(threadId, messages))).text();
  const { threads } = (await (await stack.app.request('/threads')).json()) as { threads: { id: string; title: string }[] };
  return defined(threads.find(({ id }) => id === threadId), `thread ${threadId}`).title;
}

describe('a Turn', () => {
  // Reloading during payload preparation must already follow the accepted Turn.
  it.each(['Main', 'Side'])('replays the accepted %s Chat while payload preparation waits', async (kind) => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const preparing = new Promise<void>((resolve) => { entered = resolve; });
    const target = await startInProcess({ cartridge: { invocationPayload: async (input) => {
      entered();
      await waiting;
      return { ...input, forwardedProps: { ...input.forwardedProps } };
    } } });
    const id = kind === 'Main' ? (await (await target.app.request('/main-chat')).json()).id as string : 'preparing-side';
    const path = kind === 'Main' ? '/main-chat' : `/threads/${id}`;
    target.sessionApi.reply(id, 200, { messages: [] });
    const posted = postTurn(target, turn(id));
    try {
      await preparing;
      const replay = await target.app.request(path);
      expect(replay.status).toBe(200);
      const pending = await replay.json();
      expect(pending).toMatchObject({ running: true });
      expect(pending).not.toHaveProperty('runId');
      expect(target.agentcore.invocations()).toEqual([]);
      release();
      const response = await posted;
      expect(response.status).toBe(200);
      await response.text();
      expect(await (await target.app.request(path)).json()).toMatchObject({ running: false });
    } finally {
      release();
      const response = await posted;
      if (!response.bodyUsed) await response.text();
      await target.stop();
    }
  });

  it.each(['Main', 'Side'])('clears the accepted %s Chat mark when payload preparation fails, preserving its classified error', async (kind) => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const preparing = new Promise<void>((resolve) => { entered = resolve; });
    const target = await startInProcess({ cartridge: { invocationPayload: async () => {
      entered();
      await waiting;
      throw new HttpError(503, 'Turn credentials unavailable');
    } } });
    const id = kind === 'Main' ? (await (await target.app.request('/main-chat')).json()).id as string : 'failed-preparing-side';
    const path = kind === 'Main' ? '/main-chat' : `/threads/${id}`;
    target.sessionApi.reply(id, 200, { messages: [] });
    const posted = postTurn(target, turn(id));
    try {
      await preparing;
      const before = await target.app.request(path);
      expect(before.status).toBe(200);
      const pending = await before.json();
      expect(pending).toMatchObject({ running: true });
      expect(pending).not.toHaveProperty('runId');
      release();
      const response = await posted;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ detail: 'Turn credentials unavailable' });
      const after = await (await target.app.request(path)).json();
      expect(after).toMatchObject({ running: false, failure: { runId: 'run-1', code: 'TURN_PREPARATION_FAILED', message: 'Turn credentials unavailable' } });
      expect(after).not.toHaveProperty('runId');
      expect(target.agentcore.invocations()).toEqual([]);
    } finally {
      release();
      await posted;
      await target.stop();
    }
  });

  it('withholds newly issued payload credentials from a preparation failure on reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const target = await startInProcess({ cartridge: {
      credentialProps: ['testToken'],
      invocationPayload: async (input) => ({ ...input, forwardedProps: { testToken: 'issued-private-token' } }),
      browserLiveView: async () => { throw new Error('echo: issued-private-token'); },
    } });
    const id = 'preparation-credential';
    target.sessionApi.reply(id, 200, { messages: [] });
    try {
      const response = await postTurn(target, turn(id));
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Internal Server Error');
      const after = await (await target.app.request(`/threads/${id}`)).json();
      expect(after).toMatchObject({ running: false, failure: {
        runId: 'run-1', code: 'TURN_PREPARATION_FAILED',
        message: "The error body carried the Turn's credentials, so it was withheld",
      } });
      expect(JSON.stringify(after)).not.toContain('issued-private-token');
      expect(target.agentcore.invocations()).toEqual([]);
    } finally { await target.stop(); }
  });

  it.each(['Main', 'Side'].flatMap((kind) => [
    { kind, mode: 'request' as const, status: 502, body: { error: 'Local Harness request failed', details: 'fetch failed: SocketError: other side closed' }, failure: { code: 'AGENTCORE_UPSTREAM_REQUEST_ERROR', message: 'Local Harness request failed: fetch failed: SocketError: other side closed' } },
    { kind, mode: 'http' as const, status: 503, body: { error: 'Local Harness returned HTTP 503', details: 'Harness unavailable' }, failure: { code: 'AGENTCORE_UPSTREAM_HTTP_ERROR', message: 'Local Harness returned HTTP 503: Harness unavailable' } },
    { kind, mode: 'bodiless' as const, status: 502, body: { error: 'Local Harness returned HTTP 204', details: '' }, failure: { code: 'AGENTCORE_UPSTREAM_HTTP_ERROR', message: 'Local Harness returned HTTP 204' } },
  ]))('reloads the $kind Chat with why its $mode failed before opening the stream', async (scenario) => {
    const { kind } = scenario;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let mode: 'request' | 'http' | 'bodiless' | 'success' = scenario.mode;
    const local = await new HttpFake((_request, response) => {
      if (mode === 'request') { response.destroy(); return; }
      if (mode === 'http') { response.writeHead(503); response.end('Harness unavailable'); return; }
      if (mode === 'bodiless') { response.writeHead(204); response.end(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n');
    }).listen();
    const target = await startInProcess({ config: { localHarnessUrl: local.url } });
    const id = kind === 'Main' ? (await (await target.app.request('/main-chat')).json()).id as string : 'failed-before-stream-side';
    const path = kind === 'Main' ? '/main-chat' : `/threads/${id}`;
    target.sessionApi.reply(id, 200, { messages: [] });
    try {
      const response = await postTurn(target, turn(id));
      expect(response.status).toBe(scenario.status);
      expect(await response.json()).toEqual(scenario.body);
      const reloaded = await (await target.app.request(path)).json();
      expect(reloaded).toMatchObject({ running: false, failure: { runId: 'run-1', ...scenario.failure } });
      expect(reloaded).not.toHaveProperty('runId');
      mode = 'success';
      const retried = await postTurn(target, turn(id));
      expect(retried.status).toBe(200);
      expect(await retried.text()).toBe('data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n');
      const recovered = await (await target.app.request(path)).json();
      expect(recovered).toMatchObject({ running: false });
      expect(recovered).not.toHaveProperty('failure');
    } finally {
      await target.stop();
      await local.close();
    }
  });

  it.each(['Main', 'Side'].flatMap((kind) => ['http', 'preparation'].map((mode) => ({ kind, mode }))))(
    'reloads the $kind Chat after an oversized $mode failure and permits a retry', async ({ kind, mode }) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const details = kind === 'Main' ? 'x'.repeat(410 * 1024) : '😀'.repeat(105 * 1024);
      let failing = true;
      const local = await new HttpFake((_request, response) => {
        if (failing && mode === 'http') { response.writeHead(503); response.end(details); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n');
      }).listen();
      const target = await startInProcess({
        config: { localHarnessUrl: local.url },
        cartridge: { invocationPayload: async (input) => {
          if (failing && mode === 'preparation') throw new HttpError(503, `Turn credentials unavailable: ${details}`);
          return { ...input, forwardedProps: { ...input.forwardedProps } };
        } },
      });
      const id = kind === 'Main' ? (await (await target.app.request('/main-chat')).json()).id as string : `oversized-${mode}-side`;
      const path = kind === 'Main' ? '/main-chat' : `/threads/${id}`;
      target.sessionApi.reply(id, 200, { messages: [] });
      try {
        const response = await postTurn(target, turn(id));
        const reloaded = await (await target.app.request(path)).json();
        expect(reloaded).toMatchObject({ running: false, failure: {
          runId: 'run-1', code: mode === 'http' ? 'AGENTCORE_UPSTREAM_HTTP_ERROR' : 'TURN_PREPARATION_FAILED',
        } });
        expect(reloaded).not.toHaveProperty('runId');
        expect(reloaded.failure.message).toMatch(mode === 'http' ? /^Local Harness returned HTTP 503: / : /^Turn credentials unavailable: /);
        expect(Buffer.byteLength(reloaded.failure.message, 'utf8')).toBeLessThanOrEqual(16 * 1024);
        expect(reloaded.failure.message).toMatch(/…$/);
        expect(reloaded.failure.message).not.toContain('�');
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual(mode === 'http'
          ? { error: 'Local Harness returned HTTP 503', details }
          : { detail: `Turn credentials unavailable: ${details}` });
        failing = false;
        const retried = await postTurn(target, turn(id));
        expect(retried.status).toBe(200);
        expect(await retried.text()).toBe('data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n');
        const recovered = await (await target.app.request(path)).json();
        expect(recovered).toMatchObject({ running: false });
        expect(recovered).not.toHaveProperty('failure');
      } finally {
        await target.stop();
        await local.close();
      }
    },
  );

  // A reload or a closed tab stopped the Turn, leaving its reply cut off.
  it('runs on to its end when its client goes away, sending AgentCore no stop', async () => {
    const response = await postTurn(stack, turn('session-left'));

    await defined(response.body, 'a response body').cancel();

    expect(stack.agentcore.invocationFor('session-left').payload.forwardedProps).not.toHaveProperty('stop');
    stack.sessionApi.reply('session-left', 200, { messages: [] });
    expect(await (await stack.app.request('/threads/session-left')).json()).toMatchObject({ running: false });
  });

  // A Turn that failed with no client attached failed unseen; the page opened on it later shows why.
  it.each([
    ['the agent sends a run error', 'session-failed-left', false, { code: 'PROVIDER_ERROR', message: 'The provider failed' }],
    ['its stream is cut', 'session-cut-left', true, { code: 'AGENTCORE_UPSTREAM_STREAM_ERROR' }],
  ])('records why it failed when %s after its client went away', async (_label, sessionId, drop, failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stack.agentcore.script(sessionId, {
      kind: 'stream',
      frames: [
        `data: {"type":"RUN_STARTED","threadId":"${sessionId}","runId":"run-1"}`,
        ...(drop ? [] : ['data: {"type":"RUN_ERROR","message":"The provider failed","code":"PROVIDER_ERROR"}']),
      ],
      drop,
    });
    const response = await postTurn(stack, turn(sessionId));

    await defined(response.body, 'a response body').cancel();

    stack.sessionApi.reply(sessionId, 200, { messages: [] });
    expect(await (await stack.app.request(`/threads/${sessionId}`)).json()).toMatchObject({ running: false, failure });
  });

  // A page that opens the chat mid-Turn stops it by its run ID.
  it('says it runs, and its run ID, after RUN_STARTED until its relay ends', async () => {
    let finish: (() => void) | undefined;
    const local = await new HttpFake((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"RUN_STARTED"}\n\n');
      finish = () => response.end('data: {"type":"RUN_FINISHED"}\n\n');
    }).listen();
    const target = await startInProcess({ config: { localHarnessUrl: local.url } });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await postTurn(target, turn('session-midway'));
      target.sessionApi.reply('session-midway', 200, { messages: [] });
      reader = defined(response.body, 'the running Turn stream').getReader();
      const started = await reader.read();
      expect(new TextDecoder().decode(started.value)).toContain('RUN_STARTED');
      expect(await (await target.app.request('/threads/session-midway')).json()).toMatchObject({ running: true, runId: 'run-1' });
      defined(finish, 'the held Turn completion')();
      // eslint-disable-next-line no-await-in-loop -- read each frame in order until completion
      while (!(await reader.read()).done) { /* Drain the finished Turn. */ }
      const completed = await (await target.app.request('/threads/session-midway')).json();
      expect(completed).toMatchObject({ running: false });
      expect(completed).not.toHaveProperty('runId');
    } finally {
      finish?.();
      if (reader !== undefined) { await reader.cancel(); reader.releaseLock(); }
      await target.stop(); await local.close();
    }
  });

  it('reaches the AgentCore Runtime for its Session, filed under its account', async () => {
    const response = await postTurn(stack, turn('session-relayed'), { accept: 'text/event-stream' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n');
    const invocation = stack.agentcore.invocationFor('session-relayed');
    expect(invocation.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toMatch(/^runtime-[a-f0-9-]{36}$/);
    expect(invocation.payload).toEqual({
      threadId: 'session-relayed',
      runId: 'run-1',
      state: {},
      messages: [{ id: 'm1', role: 'user', content: 'hello' }],
      tools: [],
      context: [],
      forwardedProps: {
        sessionUserId: 'filed-account-1',
        agentIdentity: { name: 'Test Bot', character: 'A test agent', vibe: 'Plain', avatar: '' },
        soul: 'Be brief.',
        memoryRevision: 0,
        model: 'plan',
      },
    });
  });

  it('carries the browser live-view event name the Cartridge picks', async () => {
    stack.agentcore.script('session-live-view', {
      kind: 'stream',
      frames: ['data: {"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"Session: S-1 "}'],
    });

    const response = await postTurn(stack, turn('session-live-view'));

    expect(await response.text()).toBe(
      'data: {"type":"TOOL_CALL_ARGS","toolCallId":"c1","delta":"Session: S-1 "}\n\n' +
        'data: {"type":"CUSTOM","name":"test:browser-live-view","value":{"open":true,"sessionId":"S-1"}}\n\n' +
        'data: {"type":"RUN_ERROR","message":"AgentCore upstream stream ended before the Turn finished","code":"AGENTCORE_UPSTREAM_STREAM_ERROR"}\n\n',
    );
  });

  it('answers 503 when no Harness is configured', async () => {
    const bare = await startInProcess({ config: { agentCore: null } });
    try {
      const response = await postTurn(bare, turn('session-unconfigured'));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'AGENTCORE_RUNTIME_ARN is not configured' });
      expect(bare.agentcore.invocations()).toEqual([]);
    } finally {
      await bare.stop();
    }
  });

  it('goes to the local Harness instead of AgentCore when one is configured', async () => {
    const local = await new HttpFake((_, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"type":"RUN_FINISHED"}\n\n');
    }).listen();
    const target = await startInProcess({ config: { localHarnessUrl: local.url } });
    try {
      const response = await postTurn(target, turn('session-local'), { accept: 'application/json' });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('data: {"type":"RUN_FINISHED"}\n\n');
      expect(target.agentcore.invocations()).toEqual([]);
      const request = defined(local.requests[0], 'a local request');
      expect(request.path).toBe('/invocations');
      expect(request.headers.accept).toBe('application/json');
      expect(JSON.parse(request.body)).toMatchObject({ threadId: 'session-local' });
    } finally {
      await Promise.all([target.stop(), local.close()]);
    }
  });

  it('on a deleted Session answers 410 without reaching the agent', async () => {
    await (await postTurn(stack, turn('session-deleted'))).text();
    expect((await stack.app.request('/threads/session-deleted', { method: 'DELETE' })).status).toBe(204);

    const response = await postTurn(stack, turn('session-deleted'));

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ detail: 'The Session was deleted' });
    expect(stack.agentcore.invocations().filter((request) => request.body.includes('session-deleted'))).toHaveLength(1);
  });

  it('tells the Cartridge it starts only once its Session took it', async () => {
    const turnStarting = vi.fn();
    const watched = await startInProcess({ cartridge: { turnStarting } });
    try {
      await (await postTurn(watched, turn('session-starting'))).text();
      expect(turnStarting.mock.calls).toEqual([[expect.anything(), 'session-starting']]);
      expect((await watched.app.request('/threads/session-starting', { method: 'DELETE' })).status).toBe(204);
      turnStarting.mockClear();

      expect((await postTurn(watched, turn('session-starting'))).status).toBe(410);
      expect(turnStarting).not.toHaveBeenCalled();
    } finally {
      await watched.stop();
    }
  });

  it('whose Session cannot be recorded fails as a 500', async () => {
    const failure = new Error('no filing user');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = await startInProcess({
      cartridge: {
        filingUserId: () => {
          throw failure;
        },
      },
    });
    try {
      const response = await postTurn(broken, turn('session-unrecorded'));

      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Internal Server Error');
      expect(consoleError.mock.calls).toEqual([['POST / failed', failure]]);
      expect(broken.agentcore.invocations()).toEqual([]);
    } finally {
      await broken.stop();
    }
  });
});

describe("a Session's title", () => {
  it('is the text of its first user message, trimmed', async () => {
    expect(
      await titleOf('title-first-user', [
        { id: 's', role: 'system', content: 'You are helpful' },
        { id: 'a', role: 'assistant', content: 'Hi' },
        { id: 'u1', role: 'user', content: '  first question  ' },
        { id: 'u2', role: 'user', content: 'second question' },
      ]),
    ).toBe('first question');
  });

  it('skips a user message with only whitespace', async () => {
    expect(
      await titleOf('title-blank-first', [
        { id: 'u1', role: 'user', content: '   ' },
        { id: 'u2', role: 'user', content: 'the real question' },
      ]),
    ).toBe('the real question');
  });

  it("joins a multi-part message's text parts with spaces, leaving out other parts", async () => {
    expect(
      await titleOf('title-parts', [
        {
          id: 'u1',
          role: 'user',
          content: [
            { type: 'text', text: 'look at' },
            { type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' } },
            { type: 'text', text: 'this chart' },
          ],
        },
      ]),
    ).toBe('look at this chart');
  });

  it('is "Untitled conversation" without any user text', async () => {
    expect(
      await titleOf('title-none', [
        { id: 'a', role: 'assistant', content: 'Hello' },
        { id: 'u1', role: 'user', content: [{ type: 'image', source: { type: 'data', value: 'AAAA', mimeType: 'image/png' } }] },
      ]),
    ).toBe('Untitled conversation');
  });
});
