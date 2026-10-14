import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt } from 'jose';
import { defined } from '../test/defined.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError } from './cartridge.js';
import { finishedSnapshotReuseFromEnv } from './server.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { recordRoundTrips, serialDepth, type RoundTrip } from '../test/fakes/round-trips.js';

let stack: InProcessStack;
const authorized: string[] = [];
beforeAll(async () => {
  stack = await startInProcess({
    cartridge: {
      authorizeBrowserLiveView: async (sessionId) => {
        if (sessionId === 'not-yours') throw new HttpError(403, 'Not your browser Session');
        authorized.push(sessionId);
      },
    },
    config: { region: 'us-west-2', agentCoreEndpoint: 'https://agentcore.example.com', browserId: "browser!'()*" },
  });
});
afterAll(() => stack.stop());
afterEach(() => vi.restoreAllMocks());

describe('GET /health', () => {
  it('is ok when Session Metadata storage is reachable', async () => {
    const response = await stack.app.request('/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('is 503 when the Session Metadata table is missing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bare = await startInProcess({ table: 'missing' });
    try {
      const response = await bare.app.request('/health');

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ detail: 'Session Metadata storage is unavailable' });
      expect(consoleError.mock.calls).toEqual([
        ['Session purge failed; durable cleanup recovery failed', expect.objectContaining({ name: 'ResourceNotFoundException' })],
        ['Session Metadata readiness probe failed', expect.objectContaining({ name: 'ResourceNotFoundException' })],
      ]);
    } finally {
      await bare.stop();
    }
  });
});

describe('GET /agent', () => {
  it("names the Cartridge's agent and reports it online with a Runtime", async () => {
    const response = await stack.app.request('/agent');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'Test Bot', avatar: '', picture: null, status: 'online' });
  });

  it('reports the agent offline without a Runtime or local Harness', async () => {
    const bare = await startInProcess({ config: { agentCore: null } });
    try {
      expect(await (await bare.app.request('/agent')).json()).toEqual({ name: 'Test Bot', avatar: '', picture: null, status: 'offline' });
    } finally {
      await bare.stop();
    }
  });
});

it('GET /ping is healthy', async () => {
  const response = await stack.app.request('/ping');

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'Healthy' });
});

it('reports failed scheduled polling as unavailable through both health endpoints', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = new Error('ECS DescribeTasks is unreachable');
  const failed = await startInProcess({ scheduled: true, scheduledDraining: async () => { throw failure; } });
  try {
    const responses = await Promise.all(['/health', '/ping'].map((path) => failed.app.request(path)));
    expect(responses.map((response) => response.status)).toEqual([503, 503]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { detail: 'Scheduled runs are unavailable' },
      { detail: 'Scheduled runs are unavailable' },
    ]);
  } finally {
    await failed.stop();
  }
});

describe('GET /browser-live-view-url', () => {
  it("presigns the browser Session's live view for five minutes, each path segment percent-encoded", async () => {
    const response = await stack.app.request('/browser-live-view-url?session_id=S%201%2Fa*');

    expect(response.status).toBe(200);
    const signed = new URL(((await response.json()) as { signedUrl: string }).signedUrl);
    expect(`${signed.origin}${signed.pathname}`).toBe(
      'https://agentcore.example.com/browser-streams/browser%21%27%28%29%2A/sessions/S%201%2Fa%2A/live-view',
    );
    expect(signed.searchParams.get('X-Amz-Credential')).toMatch(/^AKIAPARITYSUITE\/\d{8}\/us-west-2\/bedrock-agentcore\/aws4_request$/);
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(authorized).toContain('S 1/a*');
  });

  it('answers 422 without a session_id', async () => {
    const response = await stack.app.request('/browser-live-view-url');

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      detail: [{ type: 'missing', loc: ['query', 'session_id'], msg: 'Field required' }],
    });
  });

  it('answers 422 for a blank session_id', async () => {
    const response = await stack.app.request('/browser-live-view-url?session_id=%20');

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'session_id must not be blank' });
  });

  it('answers the Cartridge refusal for a browser Session the request may not watch', async () => {
    const response = await stack.app.request('/browser-live-view-url?session_id=not-yours');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ detail: 'Not your browser Session' });
  });
});

describe('a request that fails', () => {
  it('with an HttpError answers its status and detail', async () => {
    const refusing = await startInProcess({
      cartridge: {
        requester: async () => {
          throw new HttpError(401, 'Missing account cookie');
        },
      },
    });
    try {
      const response = await refusing.app.request('/threads');

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ detail: 'Missing account cookie' });
    } finally {
      await refusing.stop();
    }
  });

  it('with any other error answers 500 and logs it', async () => {
    const failure = new Error('boom');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = await startInProcess({
      cartridge: {
        requester: async () => {
          throw failure;
        },
      },
    });
    try {
      const response = await broken.app.request('/threads/session-1', { method: 'DELETE' });

      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Internal Server Error');
      expect(consoleError.mock.calls).toEqual([['DELETE /threads/session-1 failed', failure]]);
    } finally {
      await broken.stop();
    }
  });
});

describe('Account History Session ownership', () => {
  it.each(['DELETED', 'CLAIM'])('denies a started Main Chat while its owner has a %s fence', async (fence) => {
    const isolated = await startInProcess();
    try {
      const owner = 'account-1';
      const sessionId = await isolated.sessionMetadata.mainChat(owner, `filed-${owner}`);
      await isolated.sessionMetadata.recordTurn(owner, sessionId, { filingUserId: 'filed-account-1', title: 'Main Chat' });
      await isolated.sessionMetadata.recordTurn(owner, 'ordinary-turn', { filingUserId: 'filed-account-1', title: 'Ordinary Turn' });
      expect(await isolated.history.owns(owner, sessionId)).toBe(true);
      expect(await isolated.history.owns(owner, 'ordinary-turn')).toBe(true);
      await DynamoDBDocumentClient.from(isolated.table.client).send(new PutCommand({
        TableName: isolated.table.name,
        Item: { pk: `SESSIONS#${owner}`, sk: fence, destination: 'claimed-account', deleted_at: '2026-10-07T00:00:00Z' },
      }));
      expect(await isolated.history.ownsMainChat(owner, sessionId)).toBe(false);
      expect(await isolated.history.owns(owner, sessionId)).toBe(false);
      expect(await isolated.history.owns(owner, 'ordinary-turn')).toBe(false);
    } finally {
      await isolated.stop();
    }
  });
});

it('logs one chat_turn_timing line for a relayed Turn, timed to its last token', async () => {
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const target = await startInProcess({ cartridge: {
    requester: async () => { now = 120; return { owner: 'account-1' }; },
    invocationPayload: async (input) => { now = 190; return { ...input, forwardedProps: { ...input.forwardedProps } }; },
  } });
  const record = target.sessionMetadata.prepareTurn.bind(target.sessionMetadata);
  vi.spyOn(target.sessionMetadata, 'prepareTurn').mockImplementation(async (...args) => {
    const result = await record(...args);
    now = 160;
    return result;
  });
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const runId = '44444444-4444-4444-8444-444444444444';
  target.agentcore.script(sessionId, { kind: 'stream', frames: () => { now = 240; return [
    'data: {"type":"RUN_STARTED"}',
    'data: {"type":"TEXT_MESSAGE_START","messageId":"first","role":"assistant"}',
    'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"first","delta":"private answer"}',
    'data: {"type":"RUN_FINISHED"}',
  ]; } });
  try {
    const response = await target.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: sessionId, runId, state: {}, messages: [{ id: 'earlier', role: 'assistant', content: 'hi' }, { id: 'user', role: 'user', content: 'private prompt' }], tools: [], context: [], forwardedProps: {} }) });
    expect(await response.text()).toContain('private answer');
    const timings = log.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('{"event":"chat_turn_timing"'));
    expect(timings).toHaveLength(1);
    expect(timings[0]).not.toContain('private');
    const timing = JSON.parse(timings[0] ?? '{}');
    expect(timing).toEqual({ event: 'chat_turn_timing', runId, sessionId, model: expect.any(String), status: 'finished', e2eMs: 140,
      chatMs: { requester: 20, model: 20, admitted: 60, payload: 90, identity: 90, liveView: 90, dispatch: 90, invoke: 90, firstFrame: 140, firstToken: 140, lastToken: 140, end: 140 } });
    expect(Object.keys(timing.chatMs)).toEqual(['requester', 'model', 'admitted', 'payload', 'identity', 'liveView', 'dispatch', 'invoke', 'firstFrame', 'firstToken', 'lastToken', 'end']);
  } finally { await target.stop(); }
});

it('logs one failed chat_turn_timing line for a Turn whose preparation fails', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const target = await startInProcess({ cartridge: { invocationPayload: async () => { throw new Error('payload failed'); } } });
  try {
    const response = await target.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: '33333333-3333-4333-8333-333333333333', runId: '44444444-4444-4444-8444-444444444444', state: {}, messages: [], tools: [], context: [], forwardedProps: {} }) });
    expect(response.status).toBe(500);
    const timings = log.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('{"event":"chat_turn_timing"'));
    expect(timings).toHaveLength(1);
    const timing = JSON.parse(timings[0] ?? '{}');
    expect(timing).toMatchObject({ status: 'failed', e2eMs: timing.chatMs.end });
    expect(Object.keys(timing.chatMs)).toEqual(['requester', 'model', 'admitted', 'end']);
  } finally { await target.stop(); }
});

it.each([false, true])('forwards only the registered snapshot epoch when the reuse gate is %s', async (ready) => {
  const target = await startInProcess({ config: { finishedSnapshotReuse: ready, turnIdentity: { issuer: 'https://chat.example.com', keys: [{ ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'test-proof' }] } } });
  try {
    const threadId = crypto.randomUUID();
    const request = turnPost(threadId, [{ id: 'user', role: 'user', content: 'hello' }]);
    request.body = JSON.stringify({ ...JSON.parse(request.body), forwardedProps: { sessionSnapshotEpoch: 'spoofed-epoch' } });
    const response = await target.app.request('/', request);
    expect(await response.text()).toContain('RUN_FINISHED');
    const forwarded = target.agentcore.invocationFor(threadId).payload.forwardedProps;
    if (ready) expect(forwarded.sessionSnapshotEpoch).toEqual({ epoch: expect.stringMatching(/^[0-9a-f-]{36}$/), turnId: decodeJwt(forwarded.turnIdentity as string).jti });
    else expect(forwarded).not.toHaveProperty('sessionSnapshotEpoch');
  } finally { await target.stop(); }
});

it.each([['1', true], ['0', false], [undefined, false]])('reads BOTCUBE_FINISHED_SNAPSHOT_REUSE=%s as %s and refuses any other value', (value, enabled) => {
  expect(finishedSnapshotReuseFromEnv(value === undefined ? {} : { BOTCUBE_FINISHED_SNAPSHOT_REUSE: value })).toBe(enabled);
  expect(() => finishedSnapshotReuseFromEnv({ BOTCUBE_FINISHED_SNAPSHOT_REUSE: 'true' })).toThrow('BOTCUBE_FINISHED_SNAPSHOT_REUSE must be 0 or 1');
});

// Milliseconds each external call is held, so calls made together overlap.
const ROUND_TRIP_MS = 20;

const turnPost = (threadId: string, messages: unknown[]) => ({ method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ threadId, runId: crypto.randomUUID(), state: {}, messages, tools: [], context: [], forwardedProps: {} }) });

/** The external calls a Turn on `threadId` waited for before its invoke went out, in the order they started. */
async function roundTripsToInvoke(target: InProcessStack, trips: RoundTrip[], threadId: string): Promise<RoundTrip[]> {
  const sent = performance.now();
  const response = await target.app.request('/', turnPost(threadId, [{ id: 'user', role: 'user', content: 'hello' }]));
  expect(await response.text()).toContain('RUN_FINISHED');
  const turn = trips.filter((trip) => trip.start >= sent).sort((a, b) => a.start - b.start);
  const invoke = turn.find((trip) => trip.name.endsWith('/invocations'));
  if (invoke === undefined) throw new Error('The Turn never invoked the Runtime');
  return turn.filter((trip) => trip.end <= invoke.start);
}

// Chat's share of Orchestration Overhead: each call a Turn waits for before its invoke is a round trip to AWS.
// Count the round trips it waits for one after another, not the wall time, which a busy CI host stretches.
describe("a Turn's round trips before its invoke", () => {
  it('are five, one after another, on a new thread', async () => {
    const target = await startInProcess();
    try {
      // Once the purge recovery the service starts with is done, only the Turn's calls are timed.
      expect((await target.app.request('/health')).status).toBe(200);
      const trips = recordRoundTrips(target.table.client, ROUND_TRIP_MS);

      const waited = await roundTripsToInvoke(target, trips, '77777777-7777-4777-8777-777777777777');

      expect(waited.map((trip) => trip.name)).toEqual([
        'DynamoDBSessionMetadata.admissionIdentity',
        'DynamoDBSessionMetadata.queryPartition',
        'DynamoDBSessionMetadata.prepareTurn',
        'DynamoDBAgentDocuments.get',
        'DynamoDBSessionMetadata.dispatchTurn',
      ]);
      expect(serialDepth(waited)).toBe(5);
    } finally { await target.stop(); }
  });

  it('are four, one after another, on a continuing thread', async () => {
    const target = await startInProcess();
    const threadId = '88888888-8888-4888-8888-888888888888';
    try {
      // A first Turn with no user message, so no Turn summary is still being written behind it.
      expect(await (await target.app.request('/', turnPost(threadId, []))).text()).toContain('RUN_FINISHED');
      const trips = recordRoundTrips(target.table.client, ROUND_TRIP_MS);

      const waited = await roundTripsToInvoke(target, trips, threadId);

      expect(waited.map((trip) => trip.name)).toEqual([
        'DynamoDBSessionMetadata.admissionIdentity',
        'DynamoDBSessionMetadata.prepareTurn',
        'DynamoDBAgentDocuments.get',
        'DynamoDBSessionMetadata.dispatchTurn',
      ]);
      expect(serialDepth(waited)).toBe(4);
    } finally { await target.stop(); }
  });
});

function admissionGate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const admissionInput = { threadId: '55555555-5555-4555-8555-555555555555', runId: '66666666-6666-4666-8666-666666666666', state: {}, messages: [], tools: [], context: [], forwardedProps: {} };
const admissionPost = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(admissionInput) };

describe('independent Turn admission', () => {
  it('reports a documents failure while payload preparation is pending', async () => {
    const { DynamoDBAgentDocuments } = await import('./agent-documents.js');
    const payload = admissionGate<{ forwardedProps: { token: string } }>();
    const constructing = vi.fn(async () => ({ ...admissionInput, ...await payload.promise }));
    const documents = admissionGate<never>();
    const reading = vi.spyOn(DynamoDBAgentDocuments.prototype, 'get').mockImplementation(() => documents.promise);
    const target = await startInProcess({ cartridge: { invocationPayload: constructing, credentialProps: ['token'] } });
    const ending = vi.spyOn(target.sessionMetadata, 'turnEnded');
    const response = target.app.request('/', admissionPost);
    try {
      await vi.waitFor(() => expect(constructing).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(1));
      documents.reject(new HttpError(503, 'Documents failed'));
      let answered = false;
      void Promise.resolve(response).then(() => { answered = true; });
      await vi.waitFor(() => expect(answered).toBe(true));
      expect((await response).status).toBe(503);
      payload.resolve({ forwardedProps: { token: 'private-issued-token' } });
      expect(ending).toHaveBeenCalledWith('account-1', admissionInput.threadId, expect.anything(), expect.objectContaining({ message: expect.not.stringContaining('private-issued-token') }));
      const admitted = await target.sessionMetadata.get('account-1', admissionInput.threadId);
      expect(admitted).not.toBeNull();
      await expect(target.sessionMetadata.assertNoDispatch(defined(admitted, 'admitted Session'))).resolves.toBeUndefined();
    } finally { payload.resolve({ forwardedProps: { token: 'private-issued-token' } }); documents.reject(new HttpError(503, 'failed')); await response; await target.stop(); }
  });
});

it('preserves the first classified failure and reports a second preparation failure', async () => {
  const { DynamoDBAgentDocuments } = await import('./agent-documents.js');
  const payload = admissionGate<never>();
  const documents = admissionGate<never>();
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const constructing = vi.fn(() => payload.promise);
  const reading = vi.spyOn(DynamoDBAgentDocuments.prototype, 'get').mockImplementation(() => documents.promise);
  const target = await startInProcess({ cartridge: { invocationPayload: constructing } });
  const ending = vi.spyOn(target.sessionMetadata, 'turnEnded');
  const response = target.app.request('/', admissionPost);
  const primary = new HttpError(503, 'Documents refused');
  const secondary = new HttpError(502, 'Payload refused');
  try {
    await vi.waitFor(() => expect(constructing).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(reading).toHaveBeenCalledTimes(1));
    documents.reject(primary);
    let answered = false;
    void Promise.resolve(response).then(() => { answered = true; });
    await vi.waitFor(() => expect(answered).toBe(true));
    const result = await response;
    payload.reject(secondary);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ detail: 'Documents refused' });
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith('Concurrent Turn preparation failed', secondary));
    expect(ending).toHaveBeenCalledTimes(1);
  } finally { payload.reject(secondary); documents.reject(primary); await response; await target.stop(); }
});

const openingPost = (threadId: string, runId: string) => ({ method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ threadId, runId, state: {}, messages: [], tools: [], context: [], forwardedProps: { opening: true, model: 'plan' } }) });

it('titles a Side Chat from the first user question after its opening', async () => {
  const target = await startInProcess();
  try {
    const greeting = await target.app.request('/', openingPost('opening-title', 'opening-title-run'));
    expect(await greeting.text()).toContain('RUN_FINISHED');
    const question = turnPost('opening-title', [{ id: 'question', role: 'user', content: 'Explain compound interest' }]);
    question.body = JSON.stringify({ ...JSON.parse(question.body), forwardedProps: { model: 'plan' } });
    expect(await (await target.app.request('/', question)).text()).toContain('RUN_FINISHED');
    const chats = await target.app.request('/threads');
    expect(await chats.json()).toMatchObject({ threads: [{ id: 'opening-title', title: 'Explain compound interest' }] });
  } finally { await target.stop(); }
});

it.each(['main', 'side'])('replays a recorded pre-dispatch opening failure in %s Chat and accepts a follow-up', async (kind) => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let fail = true;
  const target = await startInProcess({ cartridge: { invocationPayload: async (input) => {
    if (fail) throw new Error('opening payload failed');
    return { ...input, forwardedProps: { ...input.forwardedProps } };
  } } });
  try {
    const main = await (await target.app.request('/main-chat')).json() as { id: string };
    const id = kind === 'main' ? main.id : 'failed-opening-side';
    target.sessionApi.reply(id, 404, { error: `Session ${id} has no record`, code: 'SESSION_NOT_FOUND' });
    expect((await target.app.request('/', openingPost(id, 'failed-opening-run'))).status).toBe(500);
    const replay = await target.app.request(kind === 'main' ? '/main-chat' : `/threads/${id}`);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id, provider: 'openai', messages: [], running: false,
      failure: { runId: 'failed-opening-run', message: 'opening payload failed' } });
    expect(target.sessionApi.events()).toContainEqual({ operation: 'get', sessionId: id, userId: 'filed-account-1' });
    expect((await target.app.request('/', openingPost(id, 'duplicate'))).status).toBe(409);
    fail = false;
    const question = turnPost(id, [{ id: 'question', role: 'user', content: 'Hello again' }]);
    question.body = JSON.stringify({ ...JSON.parse(question.body), forwardedProps: { model: 'plan' } });
    expect(await (await target.app.request('/', question)).text()).toContain('RUN_FINISHED');
    expect((await target.app.request(kind === 'main' ? '/main-chat' : `/threads/${id}`)).status).toBe(404);
    expect(target.sessionApi.events()).toContainEqual({ operation: 'get', sessionId: id, userId: 'filed-account-1' });
  } finally { await target.stop(); }
});

it.each(['main', 'side'])('replays the successful opening in %s Chat and propagates checkpoint failures', async (kind) => {
  const target = await startInProcess();
  try {
    const main = await (await target.app.request('/main-chat')).json() as { id: string };
    const id = kind === 'main' ? main.id : 'successful-opening-side';
    expect(await (await target.app.request('/', openingPost(id, 'successful-opening-run'))).text()).toContain('RUN_FINISHED');
    const path = kind === 'main' ? '/main-chat' : `/threads/${id}`;
    target.sessionApi.reply(id, 200, { messages: [{ id: 'greeting', role: 'assistant', content: 'Hello Ada' }] });
    expect(await (await target.app.request(path)).json()).toMatchObject({ id, provider: 'openai',
      messages: [{ id: 'greeting', role: 'assistant', content: 'Hello Ada' }], running: false });
    target.sessionApi.reply(id, 404, { error: 'Missing checkpoint' });
    expect((await target.app.request(path)).status).toBe(404);
    target.sessionApi.reply(id, 503, { error: 'Storage unavailable' });
    expect((await target.app.request(path)).status).toBe(503);
    expect(target.sessionApi.events().filter((event) => 'sessionId' in event && event.sessionId === id)).toEqual([
      { operation: 'get', sessionId: id, userId: 'filed-account-1' },
      { operation: 'get', sessionId: id, userId: 'filed-account-1' },
      { operation: 'get', sessionId: id, userId: 'filed-account-1' },
    ]);
  } finally { await target.stop(); }
});

it.each([{ kind: 'main', failure: 'http' }, { kind: 'side', failure: 'http' }, { kind: 'main', failure: 'stream' }, { kind: 'side', failure: 'stream' }])('replays an unwritten post-dispatch $failure opening failure in $kind Chat', async ({ kind, failure }) => {
  const target = await startInProcess();
  try {
    const main = await (await target.app.request('/main-chat')).json() as { id: string };
    const id = kind === 'main' ? main.id : 'rejected-opening-side';
    target.agentcore.script(id, failure === 'http'
      ? { kind: 'error', status: 503, body: JSON.stringify({ message: 'Model service unavailable' }) }
      : { kind: 'stream', frames: ['data: {"type":"RUN_STARTED"}', 'data: {"type":"RUN_ERROR","code":"MODEL_FAILED","message":"Model service unavailable"}'] });
    target.sessionApi.reply(id, 404, { error: `Session ${id} has no record`, code: 'SESSION_NOT_FOUND' });
    const response = await target.app.request('/', openingPost(id, 'rejected-opening-run'));
    await response.text();
    const replay = await target.app.request(kind === 'main' ? '/main-chat' : `/threads/${id}`);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id, provider: 'openai', messages: [], running: false,
      failure: { runId: 'rejected-opening-run', message: expect.stringContaining('Model service unavailable') } });
    target.sessionApi.reply(id, 404, { error: 'The route is missing' });
    expect((await target.app.request(kind === 'main' ? '/main-chat' : `/threads/${id}`)).status).toBe(404);
    target.sessionApi.reply(id, 503, { error: 'Checkpoint storage failed' });
    expect((await target.app.request(kind === 'main' ? '/main-chat' : `/threads/${id}`)).status).toBe(503);
  } finally { await target.stop(); }
});

it.each([{ kind: 'main', opening: true }, { kind: 'side', opening: true }, { kind: 'main', opening: false }, { kind: 'side', opening: false }])('classifies an expired unwritten $kind Turn after process exit, opening=$opening', async ({ kind, opening }) => {
  const target = await startInProcess();
  try {
    const main = await (await target.app.request('/main-chat')).json() as { id: string };
    const id = kind === 'main' ? main.id : 'abandoned-side';
    const running = { runId: 'abandoned-run', startedAt: new Date(Date.now() - 3_600_001).toISOString() };
    await target.sessionMetadata.recordTurn('account-1', id, { filingUserId: 'filed-account-1', title: 'Lost question', provider: 'openai',
      opening, running, messageId: running.runId });
    target.sessionApi.reply(id, 404, { code: 'SESSION_NOT_FOUND', error: `Session ${id} has no record` });
    const path = kind === 'main' ? '/main-chat' : `/threads/${id}`;
    const replay = await target.app.request(path);
    if (!opening) {
      expect(replay.status).toBe(404);
      expect(await replay.json()).toEqual({ detail: `Session ${id} has no record` });
      return;
    }
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id, provider: 'openai', messages: [], running: false,
      failure: { runId: 'abandoned-run', code: 'TURN_INTERRUPTED', message: 'The Turn ended without a saved conversation. Send a message to continue.' } });
    expect(await (await target.app.request(path)).json()).toMatchObject({ running: false,
      failure: { runId: 'abandoned-run', code: 'TURN_INTERRUPTED' } });
    expect(await target.sessionMetadata.get('account-1', id)).not.toHaveProperty('turn_running_since');
    expect((await target.app.request('/', openingPost(id, 'duplicate-abandoned'))).status).toBe(409);
    target.sessionApi.reply(id, 404, { error: 'Route unavailable' });
    expect((await target.app.request(path)).status).toBe(404);
    target.sessionApi.reply(id, 503, { error: 'Storage failed' });
    expect((await target.app.request(path)).status).toBe(503);
    const next = turnPost(id, [{ id: 'next-question', role: 'user', content: 'Try again' }]);
    next.body = JSON.stringify({ ...JSON.parse(next.body), forwardedProps: { model: 'plan' } });
    expect(await (await target.app.request('/', next)).text()).toContain('RUN_FINISHED');
    target.sessionApi.reply(id, 404, { code: 'SESSION_NOT_FOUND', error: `Session ${id} has no record` });
    expect((await target.app.request(path)).status).toBe(404);
  } finally { await target.stop(); }
});

it('reports fresh unwritten admissions as running and keeps settled missing checkpoints loud', async () => {
  const target = await startInProcess();
  try {
    const id = 'fresh-unwritten';
    const running = { runId: 'fresh-run', startedAt: new Date().toISOString() };
    await target.sessionMetadata.recordTurn('account-1', id, { filingUserId: 'filed-account-1', title: '', provider: 'openai', opening: true,
      running, messageId: running.runId });
    target.sessionApi.reply(id, 404, { code: 'SESSION_NOT_FOUND', error: `Session ${id} has no record` });
    expect(await (await target.app.request(`/threads/${id}`)).json()).toMatchObject({ messages: [], provider: 'openai', running: true });
    await target.sessionMetadata.turnEnded('account-1', id, running, undefined);
    expect((await target.app.request(`/threads/${id}`)).status).toBe(404);
  } finally { await target.stop(); }
});

it('refuses stale interrupted replay when a newer Turn wins settlement', async () => {
  const target = await startInProcess();
  try {
    const id = 'settlement-race';
    const old = { runId: 'old-run', startedAt: new Date(Date.now() - 3_600_001).toISOString() };
    await target.sessionMetadata.recordTurn('account-1', id, { filingUserId: 'filed-account-1', title: '', provider: 'openai', opening: true,
      running: old, messageId: old.runId });
    target.sessionApi.reply(id, 404, { code: 'SESSION_NOT_FOUND', error: `Session ${id} has no record` });
    const end = target.sessionMetadata.turnEnded.bind(target.sessionMetadata);
    vi.spyOn(target.sessionMetadata, 'turnEnded').mockImplementationOnce(async (owner, sessionId, running, failure) => {
      await target.sessionMetadata.recordTurn(owner, sessionId, { filingUserId: 'filed-account-1', title: 'New question', provider: 'openai',
        running: { runId: 'new-run', startedAt: new Date().toISOString() }, messageId: 'new-run' });
      await end(owner, sessionId, running, failure);
    });
    const replay = await target.app.request(`/threads/${id}`);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ detail: 'The Session changed while its interrupted Turn was being settled. Reload the conversation.' });
    expect(await target.sessionMetadata.get('account-1', id)).toMatchObject({ title: 'New question', turn_run_id: 'new-run', turn_latest_run_id: 'new-run' });
    expect(await target.sessionMetadata.get('account-1', id)).not.toHaveProperty('turn_failure');
  } finally { await target.stop(); }
});

it.each(['main', 'side'])('reloads an admitted %s opening before its first delta as running without a checkpoint', async (kind) => {
  const target = await startInProcess();
  try {
    const { id: main } = await (await target.app.request('/main-chat')).json() as { id: string };
    const id = kind === 'main' ? main : 'opening-before-delta';
    const running = { runId: 'before-delta-run', startedAt: new Date().toISOString() };
    await target.sessionMetadata.recordTurn('account-1', id, { filingUserId: 'filed-account-1', title: '', provider: 'openai', opening: true,
      running, messageId: running.runId });
    target.sessionApi.reply(id, 404, { code: 'SESSION_NOT_FOUND', error: `Session ${id} has no record` });
    const path = kind === 'main' ? '/main-chat' : `/threads/${id}`;
    const replay = await target.app.request(path);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id, provider: 'openai', messages: [], running: true });
    expect(await target.sessionMetadata.get('account-1', id)).toMatchObject({ turn_preparing: true, turn_run_id: 'before-delta-run' });
    target.sessionApi.reply(id, 404, { error: 'Unknown route' });
    expect((await target.app.request(path)).status).toBe(404);
    target.sessionApi.reply(id, 503, { error: 'Storage failed' });
    expect((await target.app.request(path)).status).toBe(503);
  } finally { await target.stop(); }
});

it('lists admitted titleless Side Chats while keeping warmup-only rows hidden and first-question titles writable', async () => {
  const target = await startInProcess();
  try {
    await target.sessionMetadata.recordTurn('account-1', 'warmup-only', { filingUserId: 'filed-account-1', title: '', warmup: true });
    const running = { runId: 'listed-opening-run', startedAt: new Date().toISOString() };
    await target.sessionMetadata.recordTurn('account-1', 'listed-opening', { filingUserId: 'filed-account-1', title: '', provider: 'openai', opening: true,
      running, messageId: running.runId });
    expect(await (await target.app.request('/threads')).json()).toMatchObject({ threads: [{ id: 'listed-opening', title: 'Untitled conversation' }] });
    expect(await target.sessionMetadata.get('account-1', 'listed-opening')).not.toHaveProperty('title');
    await target.sessionMetadata.turnEnded('account-1', 'listed-opening', running, { code: 'PREPARATION_FAILED', message: 'Payload failed' });
    expect(await (await target.app.request('/threads')).json()).toMatchObject({ threads: [{ id: 'listed-opening', title: 'Untitled conversation' }] });
    const next = turnPost('listed-opening', [{ id: 'question', role: 'user', content: 'Explain compound interest' }]);
    next.body = JSON.stringify({ ...JSON.parse(next.body), forwardedProps: { model: 'plan' } });
    expect(await (await target.app.request('/', next)).text()).toContain('RUN_FINISHED');
    expect(await (await target.app.request('/threads')).json()).toMatchObject({ threads: [{ id: 'listed-opening', title: 'Explain compound interest' }] });
  } finally { await target.stop(); }
});
