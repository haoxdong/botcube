import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { runScheduledTask } from './scheduled-runs.js';
import { TurnMemory, turnMemoryRoutes } from './turn-memory.js';
import { sessionLifecycle } from './session-lifecycle.js';
import * as purges from './purges.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, RUNTIME_ARN, createChatTable } from '../../../tests/chat/fakes/stack.js';
import type { AgentDocuments } from './agent-documents.js';
import type { AccountHistory, ChatServiceCartridge } from './cartridge.js';
import { createChatService, type ChatServiceConfig } from './server.js';
import type { SessionApi } from './session-api.js';
import { DynamoDBSessionMetadata, SessionDispatchPendingError, type SessionMetadata } from './session-metadata.js';
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
  checkRuntimeNamespaceReady: async () => undefined,
  beginDispatch: async (_owner, sessionId, filingUserId) => Object.assign(async () => undefined, { session: { session_id: sessionId, filing_user_id: filingUserId ?? 'filed-acct_owner', runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000001' } }),
  assertNoDispatch: async () => undefined,
  rejectedDispatches: async () => [],
  pendingPurges: async () => [],
  completePurge: async () => undefined,
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

async function chatService(localHarnessUrl: string, options: {
  metadata?: SessionMetadata;
  invoke?: SessionApi;
  history?: (history: AccountHistory) => void;
  cartridge?: Partial<ChatServiceCartridge>;
  config?: Partial<ChatServiceConfig>;
} = {}): Promise<string> {
  const turnSummaryModel = { region: 'us-east-1', url: `${bedrock.url}/model/summary/converse` };
  const app = createChatService((history) => {
    options.history?.(history);
    return { ...cartridge, ...options.cartridge };
  }, { ...config, localHarnessUrl, turnSummaryModel, ...options.config }, options.metadata ?? sessionMetadata, agentDocuments, options.invoke);
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
  it('recovers a rejected pre-header admission after replacing the Chat Service lifecycle', async () => {
    const agent = await localHarness((response) => {
      if (response.req.url?.includes('/stopruntimesession')) response.end();
      else response.destroy();
    });
    const table = `rejected-replacement-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const client = new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
    const metadata = new DynamoDBSessionMetadata(table, client);
    const invoke = vi.fn<SessionApi>(async () => ({}));
    const runtime = { localHarnessUrl: null, agentCore: { arn: RUNTIME_ARN, region: 'us-east-1', endpoint: agent.url } };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const first = await chatService(agent.url, { metadata, invoke, config: runtime });
      await (await sendTurn(first)).text();
      const admitted = defined(await metadata.get('acct_owner', TURN.threadId), 'tracked admission');
      await metadata.fence('acct_owner', TURN.threadId);
      const replacement = new DynamoDBSessionMetadata(table, client);
      await chatService(agent.url, { metadata: replacement, invoke, config: runtime });
      await expect.poll(() => replacement.pendingPurges()).toEqual([]);
      expect(agent.received.filter((request) => request.path.includes('/stopruntimesession'))).toHaveLength(1);
      expect(agent.received.at(-1)?.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(admitted.runtime_binding);
      expect(invoke).toHaveBeenCalledWith({ operation: 'purge', sessionId: TURN.threadId, userId: 'filed-acct_owner' }, 900);
    } finally { errors.mockRestore(); }
  });

  it.each(['recovered', 'classification-failed', 'other-writer', 'ack-reply-lost'] as const)('recovers failed header acknowledgement after replacement with %s controls', async (control) => {
    const agent = await localHarness((response) => {
      response.writeHead(200, { 'x-amzn-bedrock-agentcore-runtime-session-id': response.req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] });
      if (response.req.url?.includes('/stopruntimesession')) response.end();
      else response.end('data: {"type":"RUN_STARTED"}\n\n');
    });
    const table = `header-ack-replacement-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const client = new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
    let failed = false;
    client.middlewareStack.add((next, context) => async (args) => {
      const input = args.input as { TableName?: string; Key?: { pk?: string }; UpdateExpression?: string };
      if (control === 'classification-failed' && context.commandName === 'UpdateItemCommand' && input.TableName === table && input.UpdateExpression?.includes('rejected_runtime_binding')) throw new Error('Durable header failure classification unavailable');
      if (!failed && context.commandName === 'DeleteItemCommand' && input.TableName === table && input.Key?.pk?.startsWith('DISPATCH#')) {
        failed = true;
        if (control === 'ack-reply-lost') await next(args);
        throw new Error('Exact registered header acknowledgement delete failed');
      }
      return next(args);
    }, { step: 'initialize', name: 'failExactHeaderAcknowledgement' });
    const metadata = new DynamoDBSessionMetadata(table, client);
    const invoke = vi.fn<SessionApi>(async () => ({}));
    const runtime = { localHarnessUrl: null, agentCore: { arn: RUNTIME_ARN, region: 'us-east-1', endpoint: agent.url } };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const first = await chatService(agent.url, { metadata, invoke, config: runtime });
      await (await sendTurn(first)).text();
      expect(failed).toBe(true);
      const admitted = defined(await metadata.get('acct_owner', TURN.threadId), 'tracked admission');
      const target = JSON.stringify(['us-east-1', `${agent.url}/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=DEFAULT`]);
      const rejected = await metadata.rejectedDispatches(admitted, target);
      expect(rejected).toHaveLength(['classification-failed', 'ack-reply-lost'].includes(control) ? 0 : 1);
      if (control === 'ack-reply-lost') await expect(metadata.assertNoDispatch(admitted)).resolves.toBeUndefined();
      if (control === 'other-writer') await metadata.beginDispatch('acct_owner', TURN.threadId);
      await metadata.fence('acct_owner', TURN.threadId);
      const replacement = new DynamoDBSessionMetadata(table, client);
      let checked!: () => void;
      const checkAttempt = new Promise<void>((resolve) => { checked = resolve; });
      const assert = replacement.assertNoDispatch.bind(replacement);
      vi.spyOn(replacement, 'assertNoDispatch').mockImplementation(async (...args) => {
        try { return await assert(...args); }
        finally { checked(); }
      });
      await chatService(agent.url, { metadata: replacement, invoke, config: runtime });
      await checkAttempt;
      if (control === 'classification-failed' || control === 'other-writer') {
        expect(await replacement.pendingPurges()).toHaveLength(1);
        expect(agent.received.filter((request) => request.path.includes('/stopruntimesession'))).toHaveLength(0);
        expect(invoke).not.toHaveBeenCalled();
        return;
      }
      await expect.poll(() => replacement.pendingPurges()).toEqual([]);
      expect(agent.received.filter((request) => request.path.includes('/stopruntimesession'))).toHaveLength(1);
      expect(agent.received.at(-1)?.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(admitted.runtime_binding);
      expect(invoke).toHaveBeenCalledWith({ operation: 'purge', sessionId: TURN.threadId, userId: 'filed-acct_owner' }, 900);
    } finally { errors.mockRestore(); }
  });

  it.each([['thread', 'success'], ['account', 'success'], ['thread', 'failed-marker'], ['thread', 'other-writer'], ['thread', 'legacy']] as const)('recovers a successful broker writer after replacement for %s erasure with %s controls', async (deletion, control) => {
    const agent = await localHarness((response) => response.end());
    const table = `broker-ack-replacement-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const client = new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
    let failed = false;
    client.middlewareStack.add((next, context) => async (args) => {
      const input = args.input as { TableName?: string; Key?: { pk?: string }; UpdateExpression?: string };
      if (control === 'failed-marker' && context.commandName === 'UpdateItemCommand' && input.TableName === table && input.UpdateExpression?.includes('writer_succeeded')) {
        failed = true;
        throw new Error('Durable broker success marker unavailable');
      }
      if (!failed && context.commandName === 'DeleteItemCommand' && input.TableName === table && input.Key?.pk?.startsWith('DISPATCH#')) {
        failed = true;
        throw new Error('Successful broker registration acknowledgement failed');
      }
      return next(args);
    }, { step: 'initialize', name: 'failExactBrokerAcknowledgement' });
    const metadata = new DynamoDBSessionMetadata(table, client);
    const call = vi.fn(async () => ({ eventId: 'completed-checkpoint' }));
    const memory = new TurnMemory(metadata, 'shared-chat-service-signing-secret-for-tests', 'memory', { call });
    const app = new Hono().route('/memory', turnMemoryRoutes(memory));
    const invoke = vi.fn<SessionApi>(async () => ({}));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const startedAt = new Date().toISOString();
      await metadata.recordTurn('acct_owner', TURN.threadId, { filingUserId: 'filed-acct_owner', title: 'Original checkpoint' });
      if (control === 'legacy') await DynamoDBDocumentClient.from(client).send(new PutCommand({ TableName: table, Item: { pk: 'SESSIONS#acct_owner', sk: `SESSION#${TURN.threadId}`, session_id: TURN.threadId, filing_user_id: 'filed-acct_owner', title: 'Legacy checkpoint' } }));
      const { token } = await memory.start({ owner: 'acct_owner', accountActorId: 'filed-acct_owner', filingUserId: 'filed-acct_owner', sessionId: TURN.threadId, runId: 'broker-run', startedAt });
      const answer = await app.request('/memory', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'create_event', params: { memoryId: 'memory', actorId: 'filed-acct_owner', sessionId: TURN.threadId, eventTimestamp: startedAt, payload: [{ blob: 'completed checkpoint' }] } }) });
      expect(answer.status).toBe(500);
      expect(failed).toBe(true);
      expect(call).toHaveBeenCalledOnce();
      const admitted = defined(await metadata.get('acct_owner', TURN.threadId), 'registered Session');
      if (control === 'other-writer') await metadata.beginDispatch('acct_owner', TURN.threadId);
      if (deletion === 'thread') await metadata.fence('acct_owner', TURN.threadId);
      else await metadata.fenceOwner('acct_owner');
      const replacement = new DynamoDBSessionMetadata(table, client);
      let checked!: () => void;
      const checkAttempt = new Promise<void>((resolve) => { checked = resolve; });
      const assert = replacement.assertNoDispatch.bind(replacement);
      vi.spyOn(replacement, 'assertNoDispatch').mockImplementation(async (...args) => {
        try { return await assert(...args); }
        finally { checked(); }
      });
      await chatService(agent.url, { metadata: replacement, invoke, config: { localHarnessUrl: null, agentCore: { arn: RUNTIME_ARN, region: 'us-east-1', endpoint: agent.url } } });
      await checkAttempt;
      if (control !== 'success') {
        expect(await replacement.pendingPurges()).toHaveLength(1);
        expect(agent.received).toHaveLength(0);
        expect(invoke).not.toHaveBeenCalled();
        return;
      }
      await expect.poll(() => replacement.pendingPurges()).toEqual([]);
      expect(agent.received.filter((request) => request.path.includes('/stopruntimesession'))).toHaveLength(1);
      expect(agent.received.at(-1)?.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(admitted.runtime_binding);
      expect(invoke).toHaveBeenCalledWith({ operation: 'purge', sessionId: TURN.threadId, userId: 'filed-acct_owner' }, 900);
    } finally { errors.mockRestore(); }
  });

  it('classifies a missing admission prerequisite as unavailable in local mode', async () => {
    const agent = await localHarness((response) => response.end());
    const table = `local-unproved-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table, false);
    const metadata = new DynamoDBSessionMetadata(table, new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await sendTurn(await chatService(agent.url, { metadata }))).status).toBe(503);
      expect(agent.received).toEqual([]);
      expect(await metadata.get('acct_owner', TURN.threadId)).toBeNull();
    } finally { errors.mockRestore(); }
  });

  it('purges a tracked Session after lost invocation headers and a confirmed Runtime stop', async () => {
    const agent = await localHarness((response) => {
      if (response.req.url?.includes('/stopruntimesession')) {
        response.writeHead(200, { 'x-amzn-bedrock-agentcore-runtime-session-id': response.req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] });
        response.end();
      } else response.destroy();
    });
    const table = `lost-headers-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const metadata = new DynamoDBSessionMetadata(table, new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }));
    const invoke = vi.fn<SessionApi>(async () => ({}));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const queue = purges.purgeQueue;
    const queues = vi.spyOn(purges, 'purgeQueue').mockImplementation((api, stop, _backoff, complete) => queue(api, stop, [100], complete));
    try {
      const url = await chatService(agent.url, { config: { localHarnessUrl: null, agentCore: { arn: RUNTIME_ARN, region: 'us-east-1', endpoint: agent.url } }, metadata, invoke });
      queues.mockRestore();
      const response = await sendTurn(url);
      await response.text();
      const admitted = defined(await metadata.get('acct_owner', TURN.threadId), 'admitted tracked Session');
      const broker = await metadata.beginDispatch('acct_owner', TURN.threadId);
      let blocked: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => { blocked = resolve; });
      const check = metadata.assertNoDispatch.bind(metadata);
      vi.spyOn(metadata, 'assertNoDispatch').mockImplementation(async (...args) => {
        try { return await check(...args); } catch (error) {
          if (error instanceof SessionDispatchPendingError && args[0].session_id === admitted.session_id && args[0].filing_user_id === admitted.filing_user_id && args[0].runtime_binding === admitted.runtime_binding) defined(blocked, 'owning purge pending observation')();
          throw error;
        }
      });
      let completed: (() => void) | undefined;
      const settled = new Promise<void>((resolve) => { completed = resolve; });
      const complete = metadata.completePurge.bind(metadata);
      vi.spyOn(metadata, 'completePurge').mockImplementation(async (session) => {
        await complete(session);
        defined(completed, 'durable purge completion')();
      });
      expect((await fetch(`${url}/threads/${TURN.threadId}`, { method: 'DELETE' })).status).toBe(204);
      await pending;
      expect(agent.received.filter((request) => request.path.includes('/stopruntimesession'))).toHaveLength(0);
      expect(invoke).not.toHaveBeenCalled();
      await broker();
      await settled;
      expect(invoke.mock.calls).toContainEqual([{ operation: 'purge', sessionId: TURN.threadId, userId: 'filed-acct_owner' }, 900]);
      expect(agent.received.filter((request) => request.path.includes('/stopruntimesession'))).toHaveLength(1);
      expect(agent.received.at(-1)?.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(admitted.runtime_binding);
      expect(await metadata.pendingPurges()).toEqual([]);
    } finally { queues.mockRestore(); errors.mockRestore(); }
  });

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
    const service = await chatService(upstream.url, { metadata });
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
    const agent = buildDirectAgent({ chatServiceUrl: await chatService(upstream.url, { metadata }), threadId: 'local-session', messages: TURN.messages, onStopFailed });
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
    expect(invocation.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toMatch(/^runtime-[0-9a-f-]{36}$/);
    expect(JSON.parse(invocation.body).threadId).toBe('local-session');
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

  it.each(['thread', 'account'])('waits for an active Turn final flush before %s deletion purges its record', async (scope) => {
    let finish: (() => void) | undefined;
    let checkpoint = 'old checkpoint';
    const agent = await localHarness((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"RUN_STARTED"}\n\n');
      finish = () => {
        // The Harness flushes in its producer finally, before HTTP EOF.
        checkpoint = 'final checkpoint';
        response.end('data: {"type":"RUN_FINISHED"}\n\n');
      };
    });
    const summary = { runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000001', session_id: TURN.threadId, filing_user_id: 'filed-acct_owner', title: 'hello', created_at: '', updated_at: '' };
    const purged: string[] = [];
    let history: AccountHistory | undefined;
    const url = await chatService(agent.url, {
      metadata: { ...sessionMetadata, fence: async () => summary, fenceOwner: async () => [summary] },
      history: (value) => { history = value; },
      invoke: async (event) => {
        if (event.operation === 'purge') { purged.push(checkpoint); checkpoint = ''; }
        return {};
      },
    });
    const response = await sendTurn(url);
    const reader = defined(response.body, 'Turn body').getReader();
    await reader.read();
    if (scope === 'thread') expect((await fetch(`${url}/threads/${TURN.threadId}`, { method: 'DELETE' })).status).toBe(204);
    const historyDeletion = scope === 'account' ? defined(history, 'history').delete('acct_owner') : undefined;
    // The queue gets a task turn; deletion must not touch persistence yet.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(purged).toEqual([]);
    defined(finish, 'producer completion')();
    await expect.poll(() => purged, { timeout: 1_000 }).toEqual(['final checkpoint']);
    expect(checkpoint).toBe('');
    await historyDeletion;
    await reader.cancel();
  });

  it('refuses dispatch when a Turn admitted before deletion finishes recording afterward', async () => {
    const agent = await localHarness((response) => response.end());
    let admitted = false;
    let release: (() => void) | undefined;
    const summary = { runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000001', session_id: TURN.threadId, filing_user_id: 'filed-acct_owner', title: 'hello', created_at: '', updated_at: '' };
    const url = await chatService(agent.url, {
      metadata: {
        ...sessionMetadata,
        recordTurn: async () => { admitted = true; await new Promise<void>((resolve) => { release = resolve; }); return summary.filing_user_id; },
        fence: async () => summary,
      },
      invoke: async () => ({}),
    });
    const turn = sendTurn(url);
    await expect.poll(() => admitted).toBe(true);
    expect((await fetch(`${url}/threads/${TURN.threadId}`, { method: 'DELETE' })).status).toBe(204);
    defined(release, 'admitted Turn continuation')();
    const response = await turn;
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ details: 'Error: The Session was deleted' });
    expect(agent.received).toEqual([]);
  });

  it('prevents a delayed admitted Turn in another Chat Service instance from dispatching after deletion', async () => {
    const agent = await localHarness((response) => response.end());
    let admitted = false;
    let release: (() => void) | undefined;
    const table = `dispatch-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const client = () => new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
    const deletingMetadata = new DynamoDBSessionMetadata(table, client());
    const dispatchingMetadata = new DynamoDBSessionMetadata(table, client());
    const recordTurn = dispatchingMetadata.recordTurn.bind(dispatchingMetadata);
    vi.spyOn(dispatchingMetadata, 'recordTurn').mockImplementation(async (...args) => {
      const filed = await recordTurn(...args);
      admitted = true;
      await new Promise<void>((resolve) => { release = resolve; });
      return filed;
    });
    const deleting = await chatService(agent.url, { metadata: deletingMetadata, invoke: async () => ({}) });
    const dispatching = await chatService(agent.url, { metadata: dispatchingMetadata });
    const turn = sendTurn(dispatching);
    await expect.poll(() => admitted).toBe(true);
    expect((await fetch(`${deleting}/threads/${TURN.threadId}`, { method: 'DELETE' })).status).toBe(204);
    expect(await deletingMetadata.get('acct_owner', TURN.threadId)).toBeNull();
    defined(release, 'other instance admitted Turn')();
    const response = await turn;
    await response.text();
    expect(agent.received).toEqual([]);
    expect(response.status).toBe(410);
  });

  it('resumes a registered Session purge after the deleting Chat Service is replaced', async () => {
    const agent = await localHarness((response) => response.end());
    const table = `replacement-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const client = () => new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
    const deletingMetadata = new DynamoDBSessionMetadata(table, client());
    const dispatchingMetadata = new DynamoDBSessionMetadata(table, client());
    await dispatchingMetadata.recordTurn('acct_owner', TURN.threadId, { filingUserId: 'filed-acct_owner', title: 'hello' });
    const complete = await dispatchingMetadata.beginDispatch('acct_owner', TURN.threadId);
    const purged: string[] = [];
    const deleting = await chatService(agent.url, { metadata: deletingMetadata, invoke: async () => { purged.push('old task'); return {}; } });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      expect((await fetch(`${deleting}/threads/${TURN.threadId}`, { method: 'DELETE' })).status).toBe(204);
      await expect.poll(() => timers.mock.calls.findIndex(([, delay]) => delay === 5_000)).not.toBe(-1);
      const timerIndex = timers.mock.calls.findIndex(([, delay]) => delay === 5_000);
      // Task replacement destroys its pending continuation, not the shared metadata.
      clearTimeout(defined(timers.mock.results[timerIndex], 'pending purge timer').value as ReturnType<typeof setTimeout>);
      await defined(closers.pop(), 'deleting task shutdown')();
      expect(purged).toEqual([]);
      await complete();
      await chatService(agent.url, { metadata: new DynamoDBSessionMetadata(table, client()), invoke: async () => { purged.push('replacement task'); return {}; } });
      await expect.poll(() => purged, { timeout: 1_000 }).toEqual(['replacement task']);
    } finally {
      timers.mockRestore();
    }
  });

  it('retains cleanup until purge succeeds and safely acknowledges recovery from two replacement tasks', async () => {
    const agent = await localHarness((response) => response.end());
    const table = `duplicate-recovery-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const client = () => new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
    const metadata = new DynamoDBSessionMetadata(table, client());
    await metadata.recordTurn('acct_owner', TURN.threadId, { filingUserId: 'filed-acct_owner', title: 'hello' });
    await metadata.fence('acct_owner', TURN.threadId);
    const finishes: (() => void)[] = [];
    const purge = vi.fn<SessionApi>(() => new Promise((resolve) => { finishes.push(() => resolve({})); }));
    const first = await chatService(agent.url, { metadata: new DynamoDBSessionMetadata(table, client()), invoke: purge });
    await chatService(agent.url, { metadata: new DynamoDBSessionMetadata(table, client()), invoke: purge });
    await expect.poll(() => purge.mock.calls.length).toBe(2);
    expect(await metadata.pendingPurges()).toMatchObject([{ session_id: TURN.threadId, filing_user_id: 'filed-acct_owner' }]);
    expect(purge.mock.calls).toEqual(Array(2).fill([{ operation: 'purge', sessionId: TURN.threadId, userId: 'filed-acct_owner' }, 900]));
    for (const finish of finishes) finish();
    await expect.poll(() => metadata.pendingPurges()).toEqual([]);
    expect((await sendTurn(first)).status).toBe(410);
    expect(agent.received).toEqual([]);
  });

  it('reports startup discovery failure through the purge alarm with its original cause', async () => {
    const agent = await localHarness((response) => response.end());
    const failure = new Error('durable cleanup query denied');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await chatService(agent.url, { metadata: { ...sessionMetadata, pendingPurges: async () => { throw failure; } } });
      await expect.poll(() => logged.mock.calls).toEqual([
        ['Session purge failed; durable cleanup recovery failed', failure],
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('fails readiness when recovery storage is unavailable and retries discovery', async () => {
    const agent = await localHarness((response) => response.end());
    const pendingPurges = vi.fn().mockRejectedValueOnce(new Error('recovery query denied')).mockResolvedValue([]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      const url = await chatService(agent.url, { metadata: { ...sessionMetadata, pendingPurges } });
      expect((await fetch(`${url}/health`)).status).toBe(503);
      const retryIndex = timers.mock.calls.findIndex(([, delay]) => delay === 120_000);
      expect(retryIndex).toBeGreaterThanOrEqual(0);
      clearTimeout(defined(timers.mock.results[retryIndex], 'recovery timer').value as NodeJS.Timeout);
      defined(timers.mock.calls[retryIndex], 'recovery retry')[0]();
      await expect.poll(async () => (await fetch(`${url}/health`)).status).toBe(200);
      expect(pendingPurges).toHaveBeenCalledTimes(2);
    } finally { timers.mockRestore(); errors.mockRestore(); }
  });

  it('discovers durable cleanup written by another task after its initial discovery', async () => {
    const agent = await localHarness((response) => response.end());
    const table = `later-purge-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const client = () => new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
    const metadata = new DynamoDBSessionMetadata(table, client());
    const discovery = vi.spyOn(metadata, 'pendingPurges');
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const purged: string[] = [];
    try {
      await chatService(agent.url, { metadata, invoke: async (event) => { if (event.operation === 'purge') purged.push(event.sessionId); return {}; } });
      await expect.poll(() => discovery.mock.calls.length).toBe(1);
      await (defined(discovery.mock.results[0], 'initial recovery').value as Promise<unknown>);
      const other = new DynamoDBSessionMetadata(table, client());
      await other.recordTurn('acct_owner', TURN.threadId, { filingUserId: 'filed-acct_owner', title: 'hello' });
      await other.fence('acct_owner', TURN.threadId);
      const retryIndex = timers.mock.calls.findIndex(([, delay]) => delay === 120_000);
      if (retryIndex !== -1) {
        clearTimeout(defined(timers.mock.results[retryIndex], 'recovery timer').value as NodeJS.Timeout);
        defined(timers.mock.calls[retryIndex], 'periodic recovery')[0]();
      }
      await expect.poll(() => purged, { timeout: 1_000 }).toEqual([TURN.threadId]);
      await expect.poll(() => other.pendingPurges()).toEqual([]);
    } finally { timers.mockRestore(); discovery.mockRestore(); }
  });

  it('keeps another owner running when both owners use the same logical Session ID', async () => {
    const responses = new Map<string, ServerResponse>();
    const agent = await localHarness((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"RUN_STARTED"}\n\n');
      responses.set(String(JSON.parse(defined(agent.received.at(-1), 'invocation').body).forwardedProps.sessionUserId), response);
    });
    const table = `isolated-purge-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const metadata = new DynamoDBSessionMetadata(table, new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }));
    const purged: string[] = [];
    const url = await chatService(agent.url, {
      metadata, cartridge: { requester: async (c) => ({ owner: c.req.header('x-test-owner') ?? 'owner-a' }) },
      invoke: async (event) => { if (event.operation === 'purge') purged.push(event.userId); return {}; },
    });
    const turn = (owner: string) => fetch(`${url}/`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': owner }, body: JSON.stringify(TURN) });
    const first = await turn('owner-a');
    const second = await turn('owner-b');
    const firstReader = defined(first.body, 'first body').getReader();
    const secondReader = defined(second.body, 'second body').getReader();
    await firstReader.read();
    await secondReader.read();
    try {
      expect((await fetch(`${url}/threads/${TURN.threadId}`, { method: 'DELETE', headers: { 'x-test-owner': 'owner-a' } })).status).toBe(204);
      defined(responses.get('filed-owner-a'), 'first producer').end();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const survivor = defined(responses.get('filed-owner-b'), 'second producer');
      survivor.write('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"b","delta":"still running"}\n\n');
      const next = await secondReader.read();
      expect(next.done).toBe(false);
      expect(new TextDecoder().decode(next.value)).toContain('still running');
      await expect.poll(() => purged).toEqual(['filed-owner-a']);
      const headers = agent.received.map(({ headers }) => headers['x-amzn-bedrock-agentcore-runtime-session-id']);
      expect(headers[0]).not.toBe(headers[1]);
      survivor.end();
      // eslint-disable-next-line no-await-in-loop -- drain this Turn before sending its continuation
      while (!(await secondReader.read()).done) { /* Drain the surviving Turn before continuing it. */ }
      const continued = await turn('owner-b');
      expect(continued.status).toBe(200);
      defined(responses.get('filed-owner-b'), 'continued producer').end();
      await continued.text();
    } finally {
      for (const response of responses.values()) response.end();
      await Promise.all([firstReader.cancel(), secondReader.cancel()]);
    }
  });

  it('warms the same physical Sandbox as a Turn under its persisted filing identity', async () => {
    const agent = await localHarness((response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"type":"RUN_FINISHED"}\n\n'); });
    const claimed = { session_id: TURN.threadId, filing_user_id: 'filed-before-claim', title: 'hello', created_at: '', updated_at: '' };
    const url = await chatService(agent.url, {
      config: { localHarnessUrl: null, agentCore: { arn: RUNTIME_ARN, region: 'us-east-1', endpoint: agent.url } },
      metadata: { ...sessionMetadata, get: async () => claimed, recordTurn: async () => claimed.filing_user_id },
    });
    await (await sendTurn(url)).text();
    expect((await fetch(`${url}/warmup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: TURN.threadId }) })).status).toBe(200);
    const headers = agent.received.map(({ headers }) => headers['x-amzn-bedrock-agentcore-runtime-session-id']);
    expect(headers[1]).toBe(headers[0]);
    expect(headers[1]).toMatch(/^runtime-[0-9a-f-]{36}$/);
    expect(JSON.parse(defined(agent.received[1], 'warmup invocation').body)).toMatchObject({ threadId: TURN.threadId, forwardedProps: { warmup: true } });
  });

  it('blocks AWS admission and readiness until the verified namespace rollout marker exists', async () => {
    const agent = await localHarness((response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"type":"RUN_FINISHED"}\n\n'); });
    const table = `namespace-gate-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const client = new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
    await DynamoDBDocumentClient.from(client).send(new DeleteCommand({ TableName: table, Key: { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED' } }));
    const metadata = new DynamoDBSessionMetadata(table, client);
    const recordTurn = vi.spyOn(metadata, 'recordTurn');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const url = await chatService(agent.url, { config: { localHarnessUrl: null, agentCore: { arn: RUNTIME_ARN, region: 'us-east-1', endpoint: agent.url } }, metadata });
      const blocked = await sendTurn(url);
      await blocked.text();
      expect(blocked.status).toBe(503);
      expect((await fetch(`${url}/warmup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: TURN.threadId }) })).status).toBe(503);
      expect((await fetch(`${url}/health`)).status).toBe(503);
      expect(recordTurn).not.toHaveBeenCalled();
      expect(agent.received).toEqual([]);
      await DynamoDBDocumentClient.from(client).send(new PutCommand({ TableName: table, Item: { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED', old_chat_retired: true, memory_broker_only: true } }));
      const admitted = await sendTurn(url);
      await admitted.text();
      expect(admitted.status).toBe(200);
      expect((await fetch(`${url}/warmup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ threadId: TURN.threadId }) })).status).toBe(200);
      expect((await fetch(`${url}/health`)).status).toBe(200);
      expect(recordTurn).toHaveBeenCalledOnce();
      expect(agent.received).toHaveLength(2);
    } finally { recordTurn.mockRestore(); errors.mockRestore(); }
  });

  it('blocks scheduled AWS model dispatch and summary writes while the namespace gate is closed', async () => {
    const table = `scheduled-gate-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table, false);
    const metadata = new DynamoDBSessionMetadata(table, new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } }));
    const invoke = vi.fn(async () => new Response('data: {"type":"RUN_FINISHED"}\n\n'));
    const post = vi.fn<SessionApi>(async () => ({}));
    const recordTurn = vi.spyOn(metadata, 'recordTurn');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runScheduledTask({
        cartridge, sessionMetadata: metadata, agentDocuments, invokeSessionApi: post,
        scheduledTasks: { get: async () => ({ id: 'scheduled-gate', proposalId: 'proposal-gate', title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 day)', timezone: 'UTC', paused: false }) },
        upstream: sessionLifecycle({ label: 'AgentCore', invoke }, async () => undefined), runtimeNamespaceRequired: true,
        summarizeTurn: async () => ({ title: 'Brief', summary: 'Brief summary' }),
      }, { owner: 'acct_owner', taskId: 'scheduled-gate', deliveryId: 'scheduled-gate-delivery' })).rejects.toMatchObject({ status: 503 });
      expect(invoke).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(recordTurn).not.toHaveBeenCalled();
    } finally { recordTurn.mockRestore(); errors.mockRestore(); }
  });

  it('keeps legacy cleanup fenced and pending after the closed retirement prerequisite', async () => {
    const agent = await localHarness((response) => response.end());
    const table = `cleanup-gate-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const client = new DynamoDBClient({ region: 'us-east-1', endpoint: inject('dynamodbEndpoint'), credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
    const documents = DynamoDBDocumentClient.from(client);
    await documents.send(new PutCommand({ TableName: table, Item: {
      pk: 'SESSIONS#acct_owner', sk: `SESSION#${TURN.threadId}`, session_id: TURN.threadId, filing_user_id: 'filed-acct_owner',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: '2026-01-02T00:00:00Z',
    } }));
    const metadata = new DynamoDBSessionMetadata(table, client);
    const invoke = vi.fn<SessionApi>(async () => ({}));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await chatService(agent.url, { config: { localHarnessUrl: null, agentCore: { arn: RUNTIME_ARN, region: 'us-east-1', endpoint: agent.url } }, metadata, invoke });
      const jobs = await metadata.pendingPurges();
      expect(jobs).toEqual([{ session_id: TURN.threadId, filing_user_id: 'filed-acct_owner' }]);
      await expect(metadata.assertNoDispatch(defined(jobs[0], 'stored Session identity'))).rejects.toThrow('legacy settlement is unproved');
      expect(invoke).not.toHaveBeenCalled();
      expect(agent.received).toEqual([]);
    } finally { errors.mockRestore(); }
  });

  it('drains the producer through its final flush when the client goes away mid-Turn', async () => {
    let finish: (() => void) | undefined;
    let flushed = false;
    const agent = await localHarness((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"RUN_STARTED"}\n\n');
      finish = () => { flushed = true; response.end(); };
    });
    const turnEnded = vi.spyOn(sessionMetadata, 'turnEnded');
    const client = new AbortController();
    const response = await sendTurn(await chatService(agent.url), { signal: client.signal });
    const reader = defined(response.body, 'a response body').getReader();
    await reader.read();
    let closed = false;
    void agent.closed[0]?.then(() => { closed = true; });
    client.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    defined(finish, 'producer completion')();
    await expect.poll(() => closed).toBe(true);
    expect(flushed).toBe(true);
    await vi.waitFor(() => expect(turnEnded).toHaveBeenCalledOnce());
    expect(agent.received).toHaveLength(1);
  });
});
