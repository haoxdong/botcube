import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import { TurnMemory, turnMemoryRoutes } from './turn-memory.js';

it('serves the deployed Harness startup snapshot under a registered opaque Session', async () => {
  const stack = await startInProcess();
  const now = Date.parse('2026-10-06T12:00:00.000Z');
  const namespace = '/strategies/UserPreference/actors/filed-account-1/';
  const call = vi.fn(async (operation: string) => {
    if (operation === 'get_memory') return { memory: { strategies: [{ strategyId: 'UserPreference' }] } };
    if (operation === 'list_memory_records') return { memoryRecordSummaries: [{ memoryRecordId: 'preference', namespaces: [namespace], content: { text: 'Prefers tea' } }] };
    return { events: [{ eventId: 'save' }] };
  });
  const memory = new TurnMemory(stack.sessionMetadata, 'shared-chat-service-signing-secret-for-tests', 'memory', { call }, () => now);
  const app = new Hono().route('/memory', turnMemoryRoutes(memory));
  try {
    await stack.sessionMetadata.recordTurn('account-1', 'logical-history', { filingUserId: 'filed-account-1', title: 'Original history' });
    const identity = await stack.sessionMetadata.get('account-1', 'logical-history');
    expect(identity).toMatchObject({ session_id: 'logical-history', filing_user_id: 'filed-account-1', runtime_generation: 'tracked-v1', runtime_binding: expect.stringMatching(/^runtime-/) });
    const { token } = await memory.start({ owner: 'account-1', accountActorId: 'filed-account-1', filingUserId: 'filed-account-1', sessionId: 'logical-history', runId: 'run-1', startedAt: new Date(now).toISOString() });
    const response = await app.request('/memory', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'startup_snapshot', params: { memoryId: 'memory', actorId: 'filed-account-1', sessionIds: ['memory-saves-5970960', 'pending-memory-20261006'] } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      memoryRecordSummaries: [{ memoryRecordId: 'preference', namespaces: [namespace], content: { text: 'Prefers tea' } }],
      eventsBySession: { 'memory-saves-5970960': [{ eventId: 'save' }], 'pending-memory-20261006': [{ eventId: 'save' }] },
    });
    expect(await stack.sessionMetadata.get('account-1', 'logical-history')).toEqual(identity);
  } finally { await stack.stop(); }
});
