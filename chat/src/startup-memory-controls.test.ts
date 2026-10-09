import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { defined } from '../test/defined.js';
import type { SessionMetadata, TurnMemoryLease } from './session-metadata.js';
import { TurnMemory, turnMemoryRoutes } from './turn-memory.js';

const startedAt = '2026-10-06T12:00:00.000Z';
const own = '/strategies/UserPreference/actors/account_a/';
const foreign = '/strategies/UserPreference/actors/account_b/';
const sessions = ['memory-saves-5970960', 'pending-memory-20261006'];
function fixture() {
  let lease: TurnMemoryLease | null = null;
  let active = true;
  const call = vi.fn(async (operation: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (operation === 'get_memory') return { memory: { strategies: [{ strategyId: 'UserPreference' }, { strategyId: 'Semantic' }, { strategyId: 'Other' }] } };
    if (operation === 'list_memory_records') return { memoryRecordSummaries: [{ memoryRecordId: params.nextToken ? 'second' : 'first', namespaces: [params.namespacePath] }], ...(params.nextToken ? {} : { nextToken: 'record-next' }) };
    return { events: [{ eventId: params.nextToken ? 'second' : 'first' }], ...(params.nextToken ? {} : { nextToken: 'event-next' }) };
  });
  const metadata = {
    async createMemoryLease(value: TurnMemoryLease) { lease = value; },
    async memoryLease() { return lease; },
    async memorySessionActive() { return active; },
  } as unknown as SessionMetadata;
  const memory = new TurnMemory(metadata, 'shared-chat-service-signing-secret-for-tests', 'memory', { call }, () => Date.parse(startedAt));
  const app = new Hono().route('/memory', turnMemoryRoutes(memory));
  const request = (token: string, params: unknown = { memoryId: 'memory', actorId: 'account_a', sessionIds: sessions }) => app.request('/memory', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'startup_snapshot', params }),
  });
  const start = () => memory.start({ owner: 'owner_a', accountActorId: 'account_a', filingUserId: 'filing_a', sessionId: 'logical', runId: 'run', startedAt });
  return { memory, call, request, start, revoke: () => { lease = null; }, fence: () => { active = false; } };
}

describe('registered Turn startup snapshot controls', () => {
  it('collects every independent record and event stream in page order and excludes foreign and mixed records', async () => {
    const f = fixture();
    const backend = defined(f.call.getMockImplementation(), 'Memory backend mock implementation');
    f.call.mockImplementation(async (operation, params) => {
      const response = await backend(operation, params);
      if (operation === 'list_memory_records') (response.memoryRecordSummaries as unknown[]).push({ namespaces: [foreign] }, { namespaces: [own, foreign] });
      return response;
    });
    const { token } = await f.start();
    const response = await f.request(token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ memoryRecordSummaries: [
      { memoryRecordId: 'first', namespaces: [own] }, { memoryRecordId: 'second', namespaces: [own] },
      { memoryRecordId: 'first', namespaces: ['/strategies/Semantic/actors/account_a/'] }, { memoryRecordId: 'second', namespaces: ['/strategies/Semantic/actors/account_a/'] },
    ], eventsBySession: { 'memory-saves-5970960': [{ eventId: 'first' }, { eventId: 'second' }], 'pending-memory-20261006': [{ eventId: 'first' }, { eventId: 'second' }] } });
    expect(f.call).toHaveBeenCalledTimes(9);
    expect(f.call.mock.calls.filter(([op]) => op === 'list_memory_records').map(([, params]) => params.nextToken)).toEqual([undefined, undefined, 'record-next', 'record-next']);
  });

  it('starts independent event streams while namespace discovery is still pending', async () => {
    const f = fixture();
    const backend = defined(f.call.getMockImplementation(), 'Memory backend mock implementation');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    const seen = new Set<unknown>();
    f.call.mockImplementation(async (operation, params) => {
      if (operation === 'get_memory') await blocked;
      if (operation === 'list_events') {
        seen.add(params.sessionId);
        if (seen.size === 2) bothStarted();
      }
      return backend(operation, params);
    });
    const { token } = await f.start();
    const response = f.request(token);
    try {
      await started;
      expect(seen).toEqual(new Set(['memory-saves-5970960', 'pending-memory-20261006']));
    } finally { release(); }
    expect((await response).status).toBe(200);
  });

  it.each([
    [{ memoryId: 'memory', actorId: 'account_a', sessionIds: Array(6).fill(sessions[0]) }, 400],
    [{ memoryId: 'memory', actorId: 'account_a', sessionIds: [42] }, 400],
    [{ memoryId: 'memory', actorId: 'account_b', sessionIds: sessions }, 403],
    [{ memoryId: 'other', actorId: 'account_a', sessionIds: sessions }, 403],
    [{ memoryId: 'memory', actorId: 'account_a', sessionIds: [sessions[0], 'memory-saves-1'] }, 403],
    [{ memoryId: 'memory', actorId: 'account_a', sessionIds: ['logical'] }, 403],
  ])('refuses invalid startup addresses before backend calls (%j)', async (params, status) => {
    const f = fixture(); const { token } = await f.start();
    expect((await f.request(token, params)).status).toBe(status);
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(['revoke', 'fence'] as const)('rejects a %s capability without backend access', async (change) => {
    const f = fixture(); const { token } = await f.start(); f[change]();
    expect((await f.request(token)).status).toBe(403); expect(f.call).not.toHaveBeenCalled();
  });

  it.each([['pending-memory-20261006', 'ResourceNotFoundException', 200], ['memory-saves-5970960', 'ResourceNotFoundException', 404], ['pending-memory-20261006', 'AccessDeniedException', 403]] as const)('classifies %s %s without hiding other errors', async (sessionId, name, status) => {
    const f = fixture(); const backend = defined(f.call.getMockImplementation(), 'Memory backend mock implementation');
    f.call.mockImplementation(async (operation, params) => {
      if (operation === 'list_events') throw Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status === 200 ? 404 : status } });
      return backend(operation, params);
    });
    const { token } = await f.start(); const response = await f.request(token, { memoryId: 'memory', actorId: 'account_a', sessionIds: [sessionId] });
    expect(response.status).toBe(status);
    if (status === 200) expect(await response.json()).toMatchObject({ eventsBySession: { [sessionId]: [] } });
    else expect(await response.json()).toEqual({ code: name, detail: 'AgentCore Memory request failed' });
  });

  it('propagates later-page failure instead of returning a partial snapshot', async () => {
    const f = fixture(); const backend = defined(f.call.getMockImplementation(), 'Memory backend mock implementation');
    f.call.mockImplementation(async (operation, params) => {
      if (operation === 'list_memory_records' && params.nextToken) throw Object.assign(new Error('Unavailable'), { name: 'ServiceUnavailableException', $metadata: { httpStatusCode: 503 } });
      return backend(operation, params);
    });
    const { token } = await f.start(); const response = await f.request(token);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: 'ServiceUnavailableException', detail: 'AgentCore Memory request failed' });
  });

  it('fails loudly on malformed backend pages', async () => {
    const f = fixture(); const failure = { memoryRecordSummaries: [{ namespaces: [] }] };
    const backend = defined(f.call.getMockImplementation(), 'Memory backend mock implementation');
    f.call.mockImplementation(async (operation, params) => operation === 'list_memory_records' ? failure : backend(operation, params));
    const { token } = await f.start();
    await expect(f.memory.request(token, { operation: 'startup_snapshot', params: { memoryId: 'memory', actorId: 'account_a', sessionIds: sessions } })).rejects.toThrow();
  });
});
