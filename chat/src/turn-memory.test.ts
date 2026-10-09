import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { SessionDeletedError, type SessionMetadata, type TurnMemoryLease } from './session-metadata.js';
import { TurnMemory, turnMemoryRoutes, type MemoryBackend } from './turn-memory.js';

const secret = 'shared-chat-service-signing-secret-for-tests';
const startedAt = '2026-10-06T12:00:00.000Z';
const ownNamespace = '/strategies/preferences/actors/account_a/';
const otherNamespace = '/strategies/preferences/actors/account_b/';

function fixture() {
  let now = Date.parse(startedAt);
  const leases = new Map<string, TurnMemoryLease>();
  const dispatches = new Set<symbol>();
  const sessions = new Map<string, { owner: string; filingUserId: string; fenced: boolean; latestRunId?: string }>();
  sessions.set('session_a', { owner: 'owner_a', filingUserId: 'filing_a', fenced: false });
  sessions.set('session_b', { owner: 'owner_a', filingUserId: 'filing_a', fenced: false });
  const metadata = {
    async beginDispatch(owner: string, sessionId: string) {
      const session = sessions.get(sessionId);
      if (session?.owner !== owner || session.fenced) throw new SessionDeletedError(sessionId);
      const registration = Symbol(sessionId);
      dispatches.add(registration);
      return Object.assign(async () => { dispatches.delete(registration); }, { markSucceeded: async () => undefined });
    },
    async createMemoryLease(lease: TurnMemoryLease) {
      leases.set(lease.jti, lease);
      const session = sessions.get(lease.sessionId);
      if (session) session.latestRunId = lease.runId;
    },
    async memoryLease(owner: string, jti: string) {
      const lease = leases.get(jti);
      return lease?.owner === owner ? lease : null;
    },
    async endMemoryLease(_owner: string, jti: string) { leases.delete(jti); },
    async memorySessionActive(owner: string, sessionId: string, filingUserId: string) {
      const session = sessions.get(sessionId);
      return session?.owner === owner && session.filingUserId === filingUserId && !session.fenced;
    },
    async turnEnded(_owner: string, sessionId: string) {
      const session = sessions.get(sessionId);
      if (session) delete session.latestRunId;
    },
  } as unknown as SessionMetadata;
  let mutations = 0;
  const backend: MemoryBackend = {
    async call(operation, params) {
      if (params.memoryRecordId === 'missing') throw Object.assign(new Error('Missing record'), { name: 'ResourceNotFoundException', $metadata: { httpStatusCode: 404 } });
      if (operation === 'get_memory') return { memory: { strategies: [{ strategyId: 'preferences' }] } };
      if (operation === 'get_memory_record') return {
        memoryRecord: { memoryRecordId: params.memoryRecordId, namespaces: [params.memoryRecordId === 'own' ? ownNamespace : otherNamespace], content: { text: 'Prefers tea' } },
      };
      if (operation === 'list_memory_records' || operation === 'retrieve_memory_records') return {
        memoryRecordSummaries: [
          { memoryRecordId: 'own', namespaces: [ownNamespace], content: { text: 'Prefers tea' } },
          { memoryRecordId: 'other', namespaces: [otherNamespace], content: { text: 'Prefers coffee' } },
          { memoryRecordId: 'mixed', namespaces: [ownNamespace, otherNamespace], content: { text: 'Private' } },
        ],
      };
      if (operation.startsWith('delete') || operation.startsWith('batch') || operation === 'create_event') mutations += 1;
      return { accepted: operation, actorId: params.actorId, sessionId: params.sessionId };
    },
  };
  const instance = () => new TurnMemory(metadata, secret, 'memory', backend, () => now);
  const memory = instance();
  const identity = (sessionId = 'session_a') => ({ owner: 'owner_a', accountActorId: 'account_a', filingUserId: 'filing_a', sessionId, runId: sessionId, startedAt });
  const app = (service = memory) => new Hono().route('/memory', turnMemoryRoutes(service));
  const request = (token: string, operation: string, params: Record<string, unknown>, service = memory) => app(service).request('/memory', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, params: { memoryId: 'memory', ...params } }),
  });
  return { app, memory, metadata, backend, dispatches, instance, identity, request, sessions, mutations: () => mutations, advance: () => { now += 3_600_000; } };
}

describe('Turn Memory HTTP account boundary', () => {
  it('settles event writes before releasing their deletion barrier', async () => {
    const f = fixture();
    const { token } = await f.memory.start(f.identity());
    const call = f.backend.call.bind(f.backend);
    vi.spyOn(f.backend, 'call').mockImplementation(async (operation, params) => {
      expect(f.dispatches.size).toBe(1);
      return call(operation, params);
    });
    const response = await f.request(token, 'create_event', { actorId: 'filing_a', sessionId: 'session_a', eventTimestamp: startedAt, payload: [{ blob: 'checkpoint' }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 'create_event', actorId: 'filing_a', sessionId: 'session_a' });
    expect(f.dispatches.size).toBe(0);
    expect(f.mutations()).toBe(1);
  });

  it('keeps deletion blocked and reports an uncertain event write failure', async () => {
    const f = fixture();
    const { token } = await f.memory.start(f.identity());
    vi.spyOn(f.backend, 'call').mockRejectedValue(Object.assign(new Error('Connection interrupted'), { name: 'TimeoutError', $metadata: { httpStatusCode: 504 } }));
    const response = await f.request(token, 'create_event', { actorId: 'filing_a', sessionId: 'session_a', eventTimestamp: startedAt, payload: [{ blob: 'checkpoint' }] });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ code: 'TimeoutError', detail: 'AgentCore Memory request failed' });
    expect(f.dispatches.size).toBe(1);
  });

  it('does not submit an event write when durable admission fails', async () => {
    const f = fixture();
    const { token } = await f.memory.start(f.identity());
    const failure = new Error('DynamoDB admission failed');
    vi.spyOn(f.metadata, 'beginDispatch').mockRejectedValue(failure);
    await expect(f.memory.request(token, { operation: 'create_event', params: { memoryId: 'memory', actorId: 'filing_a', sessionId: 'session_a', eventTimestamp: startedAt, payload: [{ blob: 'checkpoint' }] } })).rejects.toBe(failure);
    expect(f.mutations()).toBe(0);
    expect(f.dispatches.size).toBe(0);
  });

  it('reports failed durable settlement after an event write succeeds', async () => {
    const f = fixture();
    const { token } = await f.memory.start(f.identity());
    const beginDispatch = f.metadata.beginDispatch.bind(f.metadata);
    const failure = new Error('DynamoDB settlement failed');
    vi.spyOn(f.metadata, 'beginDispatch').mockImplementation(async (...args) => {
      await beginDispatch(...args);
      return Object.assign(async () => { throw failure; }, { markSucceeded: async () => undefined });
    });
    await expect(f.memory.request(token, { operation: 'create_event', params: { memoryId: 'memory', actorId: 'filing_a', sessionId: 'session_a', eventTimestamp: startedAt, payload: [{ blob: 'checkpoint' }] } })).rejects.toBe(failure);
    expect(f.mutations()).toBe(1);
    expect(f.dispatches.size).toBe(1);
  });

  it('preserves the running Turn and fails loudly when durable revocation fails', async () => {
    const f = fixture();
    const { token, lease } = await f.memory.start(f.identity());
    const failure = new Error('DynamoDB lease deletion failed');
    vi.spyOn(f.metadata, 'endMemoryLease').mockRejectedValue(failure);
    const ended = vi.spyOn(f.metadata, 'turnEnded');
    await expect(f.memory.end(lease, lease.owner, lease.sessionId, { startedAt, runId: lease.runId }, undefined)).rejects.toBe(failure);
    expect(ended).not.toHaveBeenCalled();
    expect(f.sessions.get(lease.sessionId)?.latestRunId).toBe(lease.runId);
    expect((await f.request(token, 'actor_namespaces', { actorId: 'account_a' })).status).toBe(200);
  });

  it('revokes the capability before clearing the running Turn', async () => {
    const f = fixture();
    const { token, lease } = await f.memory.start(f.identity());
    const end = f.metadata.turnEnded.bind(f.metadata);
    vi.spyOn(f.metadata, 'turnEnded').mockImplementation(async (...args) => {
      expect((await f.request(token, 'actor_namespaces', { actorId: 'account_a' })).status).toBe(403);
      await end(...args);
    });
    await f.memory.end(lease, lease.owner, lease.sessionId, { startedAt, runId: lease.runId }, undefined);
    expect(f.sessions.get(lease.sessionId)?.latestRunId).toBeUndefined();
  });

  it('rejects missing authorization and malformed JSON at the production route', async () => {
    const f = fixture();
    const missing = await f.app().request('/memory', { method: 'POST', body: '{}' });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ detail: 'Turn Memory token required' });
    const { token } = await f.memory.start(f.identity());
    const malformed = await f.app().request('/memory', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ detail: 'Invalid Turn Memory JSON' });
  });

  it('preserves a modeled AWS missing-record error without exposing SDK details', async () => {
    const f = fixture();
    const { token } = await f.memory.start(f.identity());
    const response = await f.request(token, 'get_memory_record', { memoryRecordId: 'missing' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'ResourceNotFoundException', detail: 'AgentCore Memory request failed' });
  });
  it('returns only owned records and actor namespaces', async () => {
    const f = fixture();
    const { token } = await f.memory.start(f.identity());
    const record = await f.request(token, 'get_memory_record', { memoryRecordId: 'own' });
    expect(record.status).toBe(200);
    expect(await record.json()).toEqual({ memoryRecord: { memoryRecordId: 'own', namespaces: [ownNamespace], content: { text: 'Prefers tea' } } });
    const namespaces = await f.request(token, 'actor_namespaces', { actorId: 'account_a' });
    expect(await namespaces.json()).toEqual({ namespaces: [ownNamespace] });
    await Promise.all(['list_memory_records', 'retrieve_memory_records'].map(async (operation) => {
      const response = await f.request(token, operation, { namespacePath: ownNamespace, ...(operation === 'retrieve_memory_records' ? { searchCriteria: { searchQuery: 'preference' } } : {}) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ memoryRecordSummaries: [{ memoryRecordId: 'own', namespaces: [ownNamespace], content: { text: 'Prefers tea' } }] });
    }));
  });

  it('rejects forged, expired and ended tokens', async () => {
    const f = fixture();
    const { token, lease } = await f.memory.start(f.identity());
    expect((await f.request(`${token.slice(0, token.lastIndexOf('.') + 1)}forged`, 'actor_namespaces', { actorId: 'account_a' })).status).toBe(401);
    await f.memory.end(lease, lease.owner, lease.sessionId, { startedAt, runId: lease.runId }, undefined);
    expect((await f.request(token, 'actor_namespaces', { actorId: 'account_a' })).status).toBe(403);
    const expired = await f.memory.start(f.identity());
    f.advance();
    expect((await f.request(expired.token, 'actor_namespaces', { actorId: 'account_a' })).status).toBe(401);
  });

  it('rejects other accounts, sessions, memory IDs and root namespaces', async () => {
    const f = fixture();
    const { token } = await f.memory.start(f.identity());
    const otherAccount = await f.memory.start({ ...f.identity('session_b'), accountActorId: 'account_b' });
    expect((await f.request(otherAccount.token, 'list_memory_records', { namespacePath: ownNamespace })).status).toBe(403);
    await Promise.all(([
      ['actor_namespaces', { actorId: 'account_b' }],
      ['list_events', { actorId: 'account_b', sessionId: 'session_a' }],
      ['list_events', { actorId: 'account_a', sessionId: 'session_b' }],
      ['actor_namespaces', { actorId: 'account_a', memoryId: 'other_memory' }],
      ['list_memory_records', { namespacePath: '/strategies/' }],
      ['list_memory_records', { namespacePath: otherNamespace }],
    ] as const).map(async ([operation, params]) => {
      expect((await f.request(token, operation, params)).status).toBe(403);
    }));
  });

  it('allows current-session checkpoint and snapshot events only for the filing actor', async () => {
    const f = fixture();
    const { token } = await f.memory.start(f.identity());
    await Promise.all(['session_a', 'session_a-messages'].map(async (sessionId) => {
      const response = await f.request(token, 'create_event', { actorId: 'filing_a', sessionId, eventTimestamp: startedAt, payload: [{ blob: 'checkpoint' }] });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: 'create_event', actorId: 'filing_a', sessionId });
    }));
    await Promise.all([{ actorId: 'filing_b', sessionId: 'session_a' }, { actorId: 'filing_a', sessionId: 'session_b' }, { actorId: 'filing_a', sessionId: 'pending-memory-20261006' }].map(async (params) => {
      expect((await f.request(token, 'create_event', { ...params, eventTimestamp: startedAt, payload: [{ blob: 'checkpoint' }] })).status).toBe(403);
    }));
    expect(f.mutations()).toBe(2);
  });

  it('rejects foreign record reads, deletes and mixed batches before mutating', async () => {
    const f = fixture();
    const { token } = await f.memory.start(f.identity());
    expect((await f.request(token, 'get_memory_record', { memoryRecordId: 'other' })).status).toBe(403);
    expect((await f.request(token, 'delete_memory_record', { memoryRecordId: 'other' })).status).toBe(403);
    expect((await f.request(token, 'batch_update_memory_records', { records: [
      { memoryRecordId: 'own', timestamp: startedAt, content: { text: 'Tea' } },
      { memoryRecordId: 'other', timestamp: startedAt, content: { text: 'Coffee' } },
    ] })).status).toBe(403);
    expect(f.mutations()).toBe(0);
    const response = await f.request(token, 'delete_memory_record', { memoryRecordId: 'own' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 'delete_memory_record' });
    expect(f.mutations()).toBe(1);
  });

  it('shares leases across Chat Service instances without revoking overlapping Turns', async () => {
    const f = fixture();
    const second = f.instance();
    const firstTurn = await f.memory.start(f.identity());
    const secondTurn = await second.start({ ...f.identity(), runId: 'second_run' });
    expect((await f.request(firstTurn.token, 'actor_namespaces', { actorId: 'account_a' }, second)).status).toBe(200);
    await second.end(firstTurn.lease, firstTurn.lease.owner, firstTurn.lease.sessionId, { startedAt, runId: firstTurn.lease.runId }, undefined);
    expect((await f.request(firstTurn.token, 'actor_namespaces', { actorId: 'account_a' })).status).toBe(403);
    const response = await f.request(secondTurn.token, 'actor_namespaces', { actorId: 'account_a' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ namespaces: [ownNamespace] });
    const thirdTurn = await f.memory.start({ ...f.identity(), runId: 'third_run' });
    await f.memory.end(secondTurn.lease, secondTurn.lease.owner, secondTurn.lease.sessionId, { startedAt, runId: secondTurn.lease.runId }, undefined);
    expect((await f.request(secondTurn.token, 'actor_namespaces', { actorId: 'account_a' }, second)).status).toBe(403);
    const remaining = await f.request(thirdTurn.token, 'actor_namespaces', { actorId: 'account_a' }, second);
    expect(remaining.status).toBe(200);
    expect(await remaining.json()).toEqual({ namespaces: [ownNamespace] });
  });

  it.each(['claim', 'fence'])('invalidates a token after a session %s', async (change) => {
    const f = fixture();
    const { token } = await f.memory.start(f.identity());
    f.sessions.set('session_a', { owner: change === 'claim' ? 'new_owner' : 'owner_a', filingUserId: 'filing_a', fenced: change === 'fence' });
    const response = await f.request(token, 'actor_namespaces', { actorId: 'account_a' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ detail: 'Memory access is outside this Turn' });
  });
});
