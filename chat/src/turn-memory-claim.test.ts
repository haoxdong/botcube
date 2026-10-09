import { defined } from '../test/defined.js';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import { SessionDispatchPendingError } from './session-metadata.js';
import { TurnMemory, turnMemoryRoutes } from './turn-memory.js';

it.each([false, true])('preserves an authorized checkpoint across Claim unless its destination is deleted (deleted: %s)', async (deleted) => {
  const stack = await startInProcess();
  const session = { session_id: 'claim-checkpoint', filing_user_id: 'filed-source' };
  const running = { runId: 'accepted-turn', startedAt: new Date().toISOString() };
  let releaseAdmission!: () => void;
  let admissionEntered!: () => void;
  let releaseWrite!: () => void;
  let writeEntered!: () => void;
  const admission = new Promise<void>((resolve) => { admissionEntered = resolve; });
  const admissionRelease = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  const writing = new Promise<void>((resolve) => { writeEntered = resolve; });
  const writeRelease = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const backend = { call: vi.fn(async (_operation: string, params: Record<string, unknown>) => {
    writeEntered();
    await writeRelease;
    return { actorId: params.actorId, sessionId: params.sessionId, eventId: 'checkpoint' };
  }) };
  const beginDispatch = stack.sessionMetadata.beginDispatch.bind(stack.sessionMetadata);
  vi.spyOn(stack.sessionMetadata, 'beginDispatch').mockImplementation(async (...args) => {
    admissionEntered();
    await admissionRelease;
    return beginDispatch(...args);
  });
  let request: Promise<Response> | undefined;
  try {
    await stack.sessionMetadata.recordTurn('claim-source', session.session_id, { filingUserId: session.filing_user_id, title: 'Accepted checkpoint', running });
    const registered = defined(await stack.sessionMetadata.get('claim-source', session.session_id), 'registered Session');
    const memory = new TurnMemory(stack.sessionMetadata, 'shared-chat-service-signing-secret-for-tests', 'memory', backend);
    const { token } = await memory.start({ owner: 'claim-source', accountActorId: 'filed-source', filingUserId: session.filing_user_id, sessionId: session.session_id, ...running });
    const app = new Hono().route('/memory', turnMemoryRoutes(memory));
    request = Promise.resolve(app.request('/memory', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'create_event', params: { memoryId: 'memory', actorId: session.filing_user_id, sessionId: session.session_id, eventTimestamp: running.startedAt, payload: [{ blob: 'checkpoint' }] } }),
    }));
    await admission;
    await stack.history.transfer('claim-source', 'claim-destination');
    expect(await stack.sessionMetadata.get('claim-source', session.session_id)).toBeNull();
    expect(await stack.sessionMetadata.get('claim-destination', session.session_id)).toMatchObject({ filing_user_id: session.filing_user_id, turn_run_id: running.runId });
    if (deleted) await stack.sessionMetadata.fenceOwner('claim-destination');
    releaseAdmission();
    if (deleted) {
      expect((await request).status).toBe(500);
      expect(backend.call).not.toHaveBeenCalled();
      await expect(stack.sessionMetadata.assertNoDispatch(registered)).resolves.toBeUndefined();
    } else {
      const earlyResponse = await Promise.race([writing.then(() => null), request]);
      expect(earlyResponse).toBeNull();
      await expect(stack.sessionMetadata.assertNoDispatch(registered)).rejects.toBeInstanceOf(SessionDispatchPendingError);
      releaseWrite();
      const response = await request;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ actorId: session.filing_user_id, sessionId: session.session_id, eventId: 'checkpoint' });
      await expect(stack.sessionMetadata.assertNoDispatch(registered)).resolves.toBeUndefined();
    }
  } finally {
    releaseAdmission();
    releaseWrite();
    await request;
    await stack.stop();
  }
}, 15_000);
