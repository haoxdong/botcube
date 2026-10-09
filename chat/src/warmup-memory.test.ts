import { PutCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { Hono } from 'hono';
import { TurnMemory, turnMemoryRoutes } from './turn-memory.js';
import { afterEach, expect, it, vi } from 'vitest';
import { defined } from '../test/defined.js';
import { HttpFake, sendJson } from '../test/fakes/http-fake.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

const secret = 'shared-chat-service-signing-secret-for-tests';
afterEach(() => vi.restoreAllMocks());

it.each(['tracked', 'legacy', 'main'] as const)('warms a named %s Session with the configured broker Harness', async (generation) => {
  let stack: InProcessStack | undefined;
  let capability: { token: string; url: string } | undefined;
  let acknowledged!: () => void;
  const admission = new Promise<void>((resolve) => { acknowledged = resolve; });
  const harness = await new HttpFake(async (request, response) => {
    const input = JSON.parse(request.body) as { forwardedProps: { turnMemory?: { token: string; url: string }; sessionUserId: string } };
    capability = input.forwardedProps.turnMemory;
    if (capability === undefined) { sendJson(response, 400, { error: 'Turn Memory broker configuration is required' }); return; }
    response.writeHead(200, { 'x-amzn-bedrock-agentcore-runtime-session-id': request.headers['x-amzn-bedrock-agentcore-runtime-session-id'] });
    response.flushHeaders();
    await admission;
    const broker = await defined(stack, 'registered stack').app.request('/internal/turn-memory', {
      method: 'POST', headers: { Authorization: `Bearer ${capability.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'startup_snapshot', params: { memoryId: 'memory', actorId: 'filed-account-1', sessionIds: [] } }),
    });
    if (broker.status !== 200) { response.end(`data: ${JSON.stringify({ type: 'RUN_ERROR', message: `Startup broker read failed: ${broker.status}` })}\n\n`); return; }
    response.end();
  }).listen();
  vi.spyOn(BedrockAgentCoreControlClient.prototype, 'send').mockResolvedValue({ memory: { strategies: [] } } as never);
  try {
    stack = await startInProcess({ config: { agentCoreEndpoint: harness.url, agentCore: { arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-fixture', region: 'us-east-1', endpoint: harness.url }, turnMemory: { secret, memoryId: 'memory', url: 'https://chat.fixture/internal/turn-memory' } } });
    if (generation === 'legacy') await DynamoDBDocumentClient.from(stack.table.client).send(new PutCommand({ TableName: stack.table.name, Item: { pk: 'SESSIONS#account-1', sk: 'SESSION#warm-history', session_id: 'warm-history', filing_user_id: 'filed-account-1', title: 'Original history', last_activity: '2026-10-06T12:00:00.000Z' } }));
    else await stack.sessionMetadata.recordTurn('account-1', 'warm-history', { filingUserId: 'filed-account-1', title: 'Original history' });
    if (generation === 'main') await DynamoDBDocumentClient.from(stack.table.client).send(new PutCommand({ TableName: stack.table.name, Item: { pk: 'SESSIONS#account-1', sk: 'MAIN', session_id: 'warm-history', filing_user_id: 'filed-account-1' } }));
    const before = defined(await stack.sessionMetadata.get('account-1', 'warm-history'), 'original Session');
    const beginDispatch = stack.sessionMetadata.beginDispatch.bind(stack.sessionMetadata);
    vi.spyOn(stack.sessionMetadata, 'beginDispatch').mockImplementation(async (...args) => {
      const complete = await beginDispatch(...args);
      return Object.assign(async () => { await complete(); acknowledged(); }, complete);
    });
    const response = await stack.app.request('/warmup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: generation === 'main' ? '{"mainChat":true}' : '{"threadId":"warm-history"}' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(capability).toMatchObject({ token: expect.any(String), url: 'https://chat.fixture/internal/turn-memory' });
    const after = defined(await stack.sessionMetadata.get('account-1', 'warm-history'), 'continued Session');
    expect(after).toMatchObject({ session_id: before.session_id, filing_user_id: before.filing_user_id, title: before.title, runtime_generation: generation === 'legacy' ? 'continuation-v1' : 'tracked-v1' });
    if (generation !== 'legacy') expect(after.runtime_binding).toBe(before.runtime_binding);
    else expect(after).toMatchObject({ runtime_binding: expect.stringMatching(/^runtime-/), legacy_settlement_unproved: true });
    expect(after.turn_run_id).toBeUndefined();
    if (generation === 'main') expect(await stack.sessionMetadata.mainChat('account-1', 'filed-account-1')).toBe('warm-history');
    const revoked = await stack.app.request('/internal/turn-memory', { method: 'POST', headers: { Authorization: `Bearer ${defined(capability, 'warmup broker capability').token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'startup_snapshot', params: { memoryId: 'memory', actorId: 'filed-account-1', sessionIds: [] } }) });
    expect(revoked.status).toBe(403);
  } finally { await stack?.stop(); await harness.close(); }
});


it('limits warmup to startup and original filing history without disturbing an overlapping Turn', async () => {
  const stack = await startInProcess();
  const running = { runId: 'ordinary-run', startedAt: new Date().toISOString() };
  const call = vi.fn(async (operation: string) => operation === 'get_memory' ? { memory: { strategies: [] } } : { events: [{ eventId: 'original' }] });
  const memory = new TurnMemory(stack.sessionMetadata, secret, 'memory', { call });
  const app = new Hono().route('/memory', turnMemoryRoutes(memory));
  const request = (token: string, operation: string, params: Record<string, unknown>) => app.request('/memory', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, params: { memoryId: 'memory', ...params } }) });
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'claimed-history', { filingUserId: 'filed-original', title: 'Original', running });
    const identity = { owner: 'account-1', accountActorId: 'filed-account-1', filingUserId: 'filed-original', sessionId: 'claimed-history', ...running };
    const ordinary = await memory.start(identity);
    const warmup = await memory.start({ ...identity, runId: '__warmup__', purpose: 'warmup' });
    await Promise.all(['claimed-history', 'claimed-history-messages'].map(async (sessionId) => {
      expect((await request(warmup.token, 'list_events', { actorId: 'filed-original', sessionId })).status).toBe(200);
      expect((await request(warmup.token, 'get_event', { actorId: 'filed-original', sessionId, eventId: 'original' })).status).toBe(200);
    }));
    call.mockClear();
    await Promise.all(([
      ['create_event', { actorId: 'filed-original', sessionId: 'claimed-history', eventTimestamp: running.startedAt, payload: [{ blob: 'write' }] }],
      ['delete_event', { actorId: 'filed-original', sessionId: 'claimed-history', eventId: 'original' }],
      ['list_events', { actorId: 'filed-account-1', sessionId: 'claimed-history' }],
      ['list_events', { actorId: 'filed-original', sessionId: 'another-history' }],
      ['actor_namespaces', { actorId: 'filed-account-1' }],
      ['delete_memory_record', { memoryRecordId: 'original' }],
    ] as const).map(async ([operation, params]) => { expect((await request(warmup.token, operation, params)).status).toBe(403); }));
    expect(call).not.toHaveBeenCalled();
    const storedOrdinary = defined(await stack.sessionMetadata.memoryLease(ordinary.lease.owner, ordinary.lease.jti), 'ordinary durable lease');
    vi.spyOn(stack.sessionMetadata, 'memoryLease').mockResolvedValueOnce({ ...storedOrdinary, purpose: 'warmup' });
    expect((await request(ordinary.token, 'list_events', { actorId: 'filed-original', sessionId: 'claimed-history' })).status).toBe(403);
    expect(call).not.toHaveBeenCalled();
    await memory.revoke(warmup.lease);
    expect((await request(warmup.token, 'list_events', { actorId: 'filed-original', sessionId: 'claimed-history' })).status).toBe(403);
    expect((await request(ordinary.token, 'list_events', { actorId: 'filed-original', sessionId: 'claimed-history' })).status).toBe(200);
    expect(await stack.sessionMetadata.get('account-1', 'claimed-history')).toMatchObject({ turn_run_id: running.runId });
    const fenced = await memory.start({ ...identity, purpose: 'warmup' });
    await stack.sessionMetadata.fenceOwner('account-1');
    call.mockClear();
    expect((await request(fenced.token, 'list_events', { actorId: 'filed-original', sessionId: 'claimed-history' })).status).toBe(403);
    expect(call).not.toHaveBeenCalled();
  } finally { await stack.stop(); }
});

it.each(['issuance', 'revocation'] as const)('reports failed durable warmup %s with truthful dispatch settlement', async (stage) => {
  const stack = await startInProcess({ config: { turnMemory: { secret, memoryId: 'memory', url: 'https://chat.fixture/internal/turn-memory' } } });
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'warm-failure', { filingUserId: 'filed-account-1', title: 'Original history' });
    const session = defined(await stack.sessionMetadata.get('account-1', 'warm-failure'), 'tracked Session');
    const failure = new Error(`Durable ${stage} unavailable`);
    const method = stage === 'issuance' ? 'createMemoryLease' : 'endMemoryLease';
    const mutation = vi.spyOn(stack.sessionMetadata, method).mockRejectedValue(failure);
    const response = await stack.app.request('/warmup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"threadId":"warm-failure"}' });
    expect(response.status).toBe(502);
    expect(mutation).toHaveBeenCalledTimes(1);
    if (stage === 'issuance') {
      expect(stack.agentcore.invocations()).toHaveLength(0);
      await expect(stack.sessionMetadata.assertNoDispatch(session)).resolves.toBeUndefined();
    } else {
      expect(stack.agentcore.invocations()).toHaveLength(1);
      await expect(stack.sessionMetadata.assertNoDispatch(session)).resolves.toBeUndefined();
      const invocation = stack.agentcore.invocationFor('warm-failure');
      const capability = invocation.payload.forwardedProps.turnMemory as { token: string };
      const memory = new TurnMemory(stack.sessionMetadata, secret, 'memory', { call: async () => ({ events: [] }) });
      await expect(memory.authorize(capability.token)).resolves.toMatchObject({ purpose: 'warmup' });
      await stack.sessionMetadata.fenceOwner('account-1');
      await expect(memory.authorize(capability.token)).rejects.toMatchObject({ status: 403 });
    }
  } finally { await stack.stop(); }
});
