import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { RunAgentInput } from '@ag-ui/client';
import { runScheduledTask, type ScheduledRunDeps } from './scheduled-runs.js';
import type { SessionMetadata, TurnMemoryLease } from './session-metadata.js';
import { TurnMemory, turnMemoryRoutes } from './turn-memory.js';
import { sessionLifecycle } from './session-lifecycle.js';
import type { ScheduledDelivery } from './scheduled-run-store.js';

function scheduledFixture(fail: boolean) {
  const leases = new Map<string, TurnMemoryLease>();
  const sessions = new Set<string>();
  const posts: string[] = [];
  let invokedToken = '';
  let invokedUrl = '';
  let duringTurn: unknown;
  const metadata = {
    scheduledRuns: {
      async get() { return null; },
      async claim(owner: string, taskId: string, deliveryId: string, filingUserId: string, mainChat: string): Promise<ScheduledDelivery> {
        return { owner, taskId, deliveryId, filingUserId, mainChat, sideChat: 'scheduled-side', runId: 'scheduled-run', inputMessageId: 'scheduled-input', postMessageId: 'scheduled-post', startedAt: new Date().toISOString(), attempt: 'scheduled-attempt', phase: 'reserved' };
      },
      async admit() {},
      async posting(record: ScheduledDelivery, registration: { session: ScheduledDelivery['postSession']; token: string }, failed: boolean) { return { ...record, phase: 'posting', postSession: registration.session, postToken: registration.token, failed }; },
      postedTransaction() { return {}; },
      async complete() {},
      async retryFailed() {},
    },
    async beginDispatch(_owner: string, sessionId: string) { return Object.assign(async () => undefined, { token: '00000000-0000-4000-8000-000000000002', markSucceeded: async () => undefined, session: { session_id: sessionId, filing_user_id: 'account_actor', runtime_generation: 'tracked-v1', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000001' } }); },
    async createMemoryLease(lease: TurnMemoryLease) { leases.set(lease.jti, lease); },
    async memoryLease(owner: string, jti: string) { const lease = leases.get(jti); return lease?.owner === owner ? lease : null; },
    async endMemoryLease(_owner: string, jti: string) { leases.delete(jti); },
    async memorySessionActive(owner: string, sessionId: string, filingUserId: string) { return owner === 'owner' && filingUserId === 'account_actor' && sessions.has(sessionId); },
    async recordTurn(_owner: string, sessionId: string) { sessions.add(sessionId); return 'account_actor'; },
    async turnEnded() {},
    async mainChat() { return 'main_chat'; },
    async saveTurnSummary() {},
  } as unknown as SessionMetadata;
  const memory = new TurnMemory(metadata, 'scheduled-shared-secret-at-least-thirty-two-chars', 'memory', {
    async call() { return { memory: { strategies: [{ strategyId: 'preferences' }] } }; },
  });
  const app = new Hono().route('/memory', turnMemoryRoutes(memory));
  const request = () => app.request('/memory', { method: 'POST', headers: { Authorization: `Bearer ${invokedToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'actor_namespaces', params: { memoryId: 'memory', actorId: 'account_actor' } }) });
  const deps = {
    runtimeNamespaceRequired: false,
    turnMemory: memory,
    turnMemoryUrl: 'https://chat.example/internal/turn-memory',
    sessionMetadata: metadata,
    cartridge: {
      models: [],
      filingUserId: () => 'account_actor',
      scheduledRequester: async () => ({ owner: 'owner' }),
      accountModels: async () => [{ key: 'test', label: 'Test', provider: 'openai' }],
      invocationPayload: async (input: RunAgentInput) => input,
      credentialProps: [],
      signInNeeded: async () => null,
    },
    agentDocuments: { get: async () => ({ agentIdentity: 'Helper', soul: 'Be helpful' }) },
    scheduledTasks: { get: async () => ({ title: 'Morning brief', prompt: 'Recall my preference', paused: false }) },
    invokeSessionApi: async (event: { content: string }) => { posts.push(event.content); return {}; },
    summarizeTurn: async () => ({ title: 'Recalled preference', summary: 'Recalled tea preference.' }),
    upstream: sessionLifecycle({
      label: 'Fake AgentCore',
      invoke: async (wire: string) => {
        const payload = JSON.parse(wire) as { forwardedProps: { turnMemory: { token: string; url: string } } };
        invokedToken = payload.forwardedProps.turnMemory.token;
        invokedUrl = payload.forwardedProps.turnMemory.url;
        const response = await request();
        duringTurn = { status: response.status, body: await response.json() };
        if (fail) throw new Error('Upstream disconnected');
        return new Response('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"answer","delta":"You prefer tea."}\n\ndata: {"type":"RUN_FINISHED"}\n\n');
      },
    }, async () => undefined),
  } as unknown as ScheduledRunDeps;
  return { deps, metadata, request, posts, during: () => duringTurn, url: () => invokedUrl };
}

describe('scheduled Turn Memory lifecycle', () => {
  it('leaves the Turn running when scheduled cleanup cannot revoke its capability', async () => {
    const f = scheduledFixture(false);
    const failure = new Error('DynamoDB lease deletion failed');
    vi.spyOn(f.metadata, 'endMemoryLease').mockRejectedValue(failure);
    const ended = vi.spyOn(f.metadata, 'turnEnded');
    await expect(runScheduledTask(f.deps, { owner: 'owner', taskId: 'task', deliveryId: 'scheduled-lease-failure' })).rejects.toBe(failure);
    expect(ended).not.toHaveBeenCalled();
    expect((await f.request()).status).toBe(200);
    expect(f.posts).toEqual(['Scheduled task "Morning brief" failed: DynamoDB lease deletion failed']);
  });

  it.each([false, true])('passes an account capability and revokes it after upstream failure=%s', async (fail) => {
    const f = scheduledFixture(fail);
    const run = runScheduledTask(f.deps, { owner: 'owner', taskId: 'task', deliveryId: 'scheduled-memory' });
    if (fail) await expect(run).rejects.toThrow('Upstream disconnected');
    else await run;
    expect(f.url()).toBe('https://chat.example/internal/turn-memory');
    expect(f.during()).toEqual({ status: 200, body: { namespaces: ['/strategies/preferences/actors/account_actor/'] } });
    const ended = await f.request();
    expect(ended.status).toBe(403);
    expect(await ended.json()).toEqual({ detail: 'Memory access is outside this Turn' });
    expect(f.posts).toEqual([fail ? 'Scheduled task "Morning brief" failed: Upstream disconnected' : 'Scheduled task "Morning brief": You prefer tea.']);
  });
});
