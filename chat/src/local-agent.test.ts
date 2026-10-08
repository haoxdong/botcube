import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentDocuments } from './agent-documents.js';
import type { ChatServiceCartridge } from './cartridge.js';
import { createChatService, type ChatServiceConfig } from './server.js';
import type { SessionMetadata } from './session-metadata.js';
import { buildDirectAgent } from '../../ui/web/src/app/conversations.js';
import { defined } from '../test/defined.js';
import { FakeBedrock } from '../test/fakes/fake-backends.js';

// The local-development path (BOTCUBE_LOCAL_HARNESS_URL), which the
// parity suite cannot reach: it always runs against the AgentCore endpoint.

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

// Each finished Turn is summarized after its stream ends, so the summary model outlives every test.
const bedrock = new FakeBedrock();
beforeAll(() => bedrock.listen());
afterAll(() => bedrock.close());

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listening(server: Server | ServerType): Promise<string> {
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', resolve);
  });
  closers.push(
    () =>
      new Promise((resolve) => {
        (server as Server).closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A local Harness that records each invocation and answers it with `answer`. */
async function localHarness(answer: (response: ServerResponse) => void) {
  const received: Received[] = [];
  const closed: Promise<void>[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    received.push({ path: request.url ?? '', headers: request.headers, body });
    closed.push(new Promise((resolve) => response.once('close', () => resolve())));
    answer(response);
  }).listen(0, '127.0.0.1');
  return { url: await listening(server), received, closed };
}

const cartridge: ChatServiceCartridge = {
  corsOrigins: [],
  authorizeBrowserLiveView: async () => undefined,
  warmSession: async () => undefined,
  agentDocuments: { agentIdentity: { name: 'Test Bot', character: '', vibe: '', avatar: '' }, soul: '' },
  models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
  accountModels: async () => [],
  browserEventName: 'test:browser-live-view',
  routes: new Hono(),
  requester: async () => ({ owner: 'acct_owner' }),
  filingUserId: (owner) => `filed-${owner}`,
  scheduledRequester: async (owner) => ({ owner }),
  signInNeeded: async () => null,
  credentialProps: [],
  invocationPayload: async (input) => ({
    ...input,
    forwardedProps: { ...(input.forwardedProps as object), accountId: 'acct_owner' },
  }),
};

const sessionMetadata: SessionMetadata = {
  createMemoryLease: async () => { throw new Error('not used'); },
  memoryLease: async () => { throw new Error('not used'); },
  endMemoryLease: async () => { throw new Error('not used'); },
  memorySessionActive: async () => { throw new Error('not used'); },
  checkHealth: async () => undefined,
  recordTurn: async (_owner, _sessionId, { filingUserId }) => filingUserId,
  list: async () => [],
  ownsMainChat: async () => false,
  mainChat: async () => 'main-chat',
  get: async () => null,
  fence: async () => null,
  fenceOwner: async () => [],
  transferOwner: async () => undefined,
  saveTurnSummary: async () => undefined,
  turnSummaries: async () => [],
  turnEnded: async () => undefined,
  turnSummaryFailed: async () => undefined,
  turnStarted: async () => undefined,
};

// Every account keeps the Cartridge's templates.
const agentDocuments: AgentDocuments = {
  get: async (_owner, templates) => ({ ...templates, memoryRevision: 0 }),
  save: async () => undefined,
  memoryEdited: async () => undefined,
  picture: async () => null,
  savePicture: async () => undefined,
  delete: async () => undefined,
};

const config: Omit<ChatServiceConfig, 'turnSummaryModel'> = {
  agentCore: null,
  localHarnessUrl: null,
  corsOrigins: null,
  region: 'us-east-1',
  agentCoreEndpoint: 'https://bedrock-agentcore.us-east-1.amazonaws.com',
  browserId: 'aws.browser.v1',
  sessionApi: null,
  warmupTimeoutMs: 10_000,
};

async function chatService(localHarnessUrl: string, metadata = sessionMetadata): Promise<string> {
  const turnSummaryModel = { region: 'us-east-1', url: `${bedrock.url}/model/summary/converse` };
  const app = createChatService(() => cartridge, { ...config, localHarnessUrl, turnSummaryModel }, metadata, agentDocuments);
  return listening(serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }));
}

const TURN = {
  threadId: 'local-session',
  runId: 'run-1',
  state: {},
  messages: [{ id: 'm1', role: 'user' as const, content: 'hello' }],
  tools: [],
  context: [],
  forwardedProps: { model: 'echo' },
};

function sendTurn(url: string, { signal, turn = TURN }: { signal?: AbortSignal; turn?: object } = {}) {
  return fetch(`${url}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(turn),
    signal: signal ?? null,
  });
}

describe('a Turn against a local Harness', () => {
  it('retains a Stop requested before admission until it can actually stop the queued Turn', async () => {
    let admit: () => void = () => undefined;
    let releaseWork: () => void = () => undefined;
    const workGate = new Promise<void>((resolve) => { releaseWork = resolve; });
    let held: () => void = () => undefined;
    const queued = new Promise<void>((resolve) => { held = resolve; });
    let registered = false;
    let stopped = false;
    let work: Promise<void> | undefined;
    const toolWrites: string[] = [];
    const upstream = await localHarness((response) => {
      const input = JSON.parse(defined(upstream.received.at(-1), 'an invocation').body);
      if (input.forwardedProps.stop) {
        if (registered) stopped = true;
        response.end();
        return;
      }
      admit = () => {
        if (registered) return;
        registered = true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId })}\n\n`);
        work = workGate.then(() => { if (!stopped) toolWrites.push('queued tool ran after Stop'); });
      };
      held();
    });
    const metadata = { ...sessionMetadata, get: async () => ({ session_id: 'local-session', filing_user_id: 'filed-acct_owner', title: '', created_at: '', updated_at: '' }) };
    const service = await chatService(upstream.url, metadata);
    let stopRequests = 0;
    const fetchImpl = (url: string, init: RequestInit) => {
      if (url.endsWith('/stop')) stopRequests += 1;
      return fetch(url, init);
    };
    const agent = buildDirectAgent({ chatServiceUrl: service, threadId: 'local-session', messages: TURN.messages, fetchImpl, onStopFailed: vi.fn() });
    const result = agent.runAgent({ forwardedProps: { model: 'echo' } });
    await queued;
    agent.abortRun();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopRequests).toBe(0);
      admit();
      await result;
      releaseWork();
      await work;
      expect(toolWrites).toEqual([]);
      expect(stopped).toBe(true);
    } finally {
      releaseWork();
      admit();
      agent.abortController.abort();
      await result;
    }
  });

  it('keeps a failed user Stop visible and retryable, then stops its pending tool work before disconnecting', async () => {
    let releaseWork: () => void = () => undefined;
    const workGate = new Promise<void>((resolve) => { releaseWork = resolve; });
    let stopped = false;
    let stops = 0;
    let work: Promise<void> | undefined;
    const toolWrites: string[] = [];
    const upstream = await localHarness((response) => {
      const input = JSON.parse(defined(upstream.received.at(-1), 'an invocation').body);
      if (input.forwardedProps.stop) {
        stops += 1;
        if (stops === 1) { response.writeHead(503); response.end(); return; }
        stopped = true;
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId })}\n\n`);
      work = workGate.then(() => { if (!stopped) toolWrites.push('sent after Stop'); });
    });
    const metadata = { ...sessionMetadata, get: async () => ({ session_id: 'local-session', filing_user_id: 'filed-acct_owner', title: '', created_at: '', updated_at: '' }) };
    const onStopFailed = vi.fn();
    const agent = buildDirectAgent({ chatServiceUrl: await chatService(upstream.url, metadata), threadId: 'local-session', messages: TURN.messages, onStopFailed });
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const result = agent.runAgent({ forwardedProps: { model: 'echo' } }, { onRunStartedEvent: () => { started(); } });
    await running;
    try {
      agent.abortRun();
      await vi.waitFor(() => expect(onStopFailed).toHaveBeenLastCalledWith(expect.objectContaining({ status: 502 })));
      expect(agent.isRunning).toBe(true);
      expect(stops).toBe(1);
      expect(stopped).toBe(false);
      agent.abortRun();
      await result;
      expect(onStopFailed).toHaveBeenCalledOnce();
      expect(agent.isRunning).toBe(false);
      releaseWork();
      await work;
      expect(toolWrites).toEqual([]);
    } finally {
      releaseWork();
      agent.abortController.abort();
      await result;
    }
  });

  it('invokes /invocations over plain HTTP with the Session ID header and the shaped payload', async () => {
    const agent = await localHarness((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n');
    });

    const response = await sendTurn(await chatService(agent.url));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n');
    const invocation = defined(agent.received[0], 'an invocation');
    expect(invocation.path).toBe('/invocations');
    expect(invocation.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe('local-session');
    expect(invocation.headers.accept).toBe('text/event-stream');
    expect(invocation.headers.authorization).toBeUndefined();
    expect(JSON.parse(invocation.body).forwardedProps).toEqual({
      model: 'echo',
      accountId: 'acct_owner',
      sessionUserId: 'filed-acct_owner',
      agentIdentity: { name: 'Test Bot', character: '', vibe: '', avatar: '' },
      soul: '',
      memoryRevision: 0,
    });
  });

  it("answers with the local Harness's content type", async () => {
    const agent = await localHarness((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.end('data: {"type":"RUN_FINISHED"}\n\n');
    });

    const response = await sendTurn(await chatService(agent.url));

    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  });

  it('reads a null optional field as absent and forwards the Turn without it', async () => {
    const agent = await localHarness((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"type":"RUN_FINISHED"}\n\n');
    });

    const response = await sendTurn(await chatService(agent.url), {
      turn: {
        ...TURN,
        parentRunId: null,
        state: { draft: null },
        messages: [
          { id: 'm1', role: 'user', content: 'hello', name: null },
          { id: 'm2', role: 'assistant', content: null, toolCalls: null },
        ],
      },
    });

    expect(response.status).toBe(200);
    const forwarded = JSON.parse(defined(agent.received[0], 'an invocation').body);
    expect(forwarded).not.toHaveProperty('parentRunId');
    expect(forwarded.state).toEqual({ draft: null });
    expect(forwarded.messages).toEqual([
      { id: 'm1', role: 'user', content: 'hello' },
      { id: 'm2', role: 'assistant' },
    ]);
  });

  it('names the local Harness in an upstream error', async () => {
    const agent = await localHarness((response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"detail":"missing accountId"}');
    });

    const response = await sendTurn(await chatService(agent.url));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Local Harness returned HTTP 500',
      details: '{"detail":"missing accountId"}',
    });
  });

  it('answers 502 when the local Harness is not running', async () => {
    const agent = await localHarness(() => undefined);
    const url = await chatService(agent.url);
    await defined(closers.shift(), 'a closer')();

    const response = await sendTurn(url);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'Local Harness request failed' });
  });

  it('reads the Turn to its end after the client goes away, asking the Harness nothing else', async () => {
    let finish: () => void = () => undefined;
    const agent = await localHarness((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"RUN_STARTED","threadId":"local-session","runId":"run-1"}\n\n');
      finish = () => response.end('data: {"type":"RUN_FINISHED","threadId":"local-session","runId":"run-1"}\n\n');
    });
    const turnEnded = vi.spyOn(sessionMetadata, 'turnEnded');
    const client = new AbortController();
    const response = await sendTurn(await chatService(agent.url), { signal: client.signal });
    await defined(response.body, 'a response body').getReader().read();

    client.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(turnEnded).not.toHaveBeenCalled();
    finish();

    await vi.waitFor(() => expect(turnEnded).toHaveBeenCalledOnce());
    expect(agent.received).toHaveLength(1);
  });
});
