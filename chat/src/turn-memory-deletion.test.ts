import { defined } from '../test/defined.js';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import { TurnMemory, turnMemoryRoutes } from './turn-memory.js';
import { SessionDispatchPendingError } from './session-metadata.js';

it.each(['thread', 'account'])('waits for admitted broker checkpoint and snapshot writes before completing %s deletion', async (deletion) => {
  const events = ['old checkpoint'];
  const stack = await startInProcess({ invokeSessionApi: async (request) => {
    if (request.operation === 'purge') events.splice(0);
    return {};
  } });
  let releaseWrite!: () => void;
  let enteredWrite!: () => void;
  const writeStarted = new Promise<void>((resolve) => { enteredWrite = resolve; });
  const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let admittedWrites = 0;
  const memory = new TurnMemory(stack.sessionMetadata, 'shared-chat-service-signing-secret-for-tests', 'memory', {
    async call(_operation, params) {
      admittedWrites += 1;
      if (admittedWrites === 2) enteredWrite();
      await writeRelease;
      events.push(String(params.sessionId));
      return { eventId: 'late-checkpoint' };
    },
  });
  const app = new Hono().route('/memory', turnMemoryRoutes(memory));
  const completed = vi.spyOn(stack.sessionMetadata, 'completePurge');
  let write: Promise<Response> | undefined;
  try {
    const startedAt = new Date().toISOString();
    await stack.sessionMetadata.recordTurn('account-1', 'broker-session', { filingUserId: 'filed-account-1', title: 'Broker race' });
    const registered = defined(await stack.sessionMetadata.get('account-1', 'broker-session'), 'registered Session');
    const { token } = await memory.start({ owner: 'account-1', accountActorId: 'filed-account-1', filingUserId: 'filed-account-1', sessionId: 'broker-session', runId: 'run-1', startedAt });
    const request = (sessionId: string) => app.request('/memory', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'create_event', params: { memoryId: 'memory', actorId: 'filed-account-1', sessionId, eventTimestamp: startedAt, payload: [{ blob: 'checkpoint' }] } }),
    });
    write = Promise.all([request('broker-session'), request('broker-session-messages')]).then((responses) => {
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      return responses[0];
    });
    await writeStarted;
    if (deletion === 'thread') expect((await stack.app.request('/threads/broker-session', { method: 'DELETE' })).status).toBe(204);
    else await expect(stack.history.delete('account-1')).rejects.toMatchObject({ status: 503, detail: expect.stringContaining('deletion remains pending') });
    await expect(stack.sessionMetadata.assertNoDispatch(registered)).rejects.toBeInstanceOf(SessionDispatchPendingError);
    expect(completed).not.toHaveBeenCalled();
    expect(events).toEqual(['old checkpoint']);
    releaseWrite();
    await write;
    expect(events.toSorted()).toEqual(['broker-session', 'broker-session-messages', 'old checkpoint']);
    if (deletion === 'account') await stack.history.delete('account-1');
    await vi.waitFor(() => expect(completed).toHaveBeenCalled(), { timeout: 10_000 });
    expect(events).toEqual([]);
  } finally {
    releaseWrite();
    if (write) expect((await write).status).toBe(200);
    await stack.stop();
  }
}, 15_000);
