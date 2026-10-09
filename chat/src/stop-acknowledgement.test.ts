import { defined } from '../test/defined.js';
import { setImmediate } from 'node:timers/promises';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import { SessionDispatchPendingError } from './session-metadata.js';

it.each([false, true])('waits for Stop dispatch acknowledgement and classifies its failure (delete fails: %s)', async (deleteFails) => {
  const stack = await startInProcess();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const deleting = new Promise<void>((resolve) => { entered = resolve; });
  const documents: unknown = Reflect.get(stack.sessionMetadata, 'documents');
  if (!(documents instanceof DynamoDBDocumentClient)) throw new Error('Session Metadata has no DynamoDB document client');
  documents.middlewareStack.add((next, context) => async (args) => {
    if (['DeleteCommand', 'DeleteItemCommand'].includes(context.commandName ?? '')) {
      entered();
      await held;
      if (deleteFails) throw new Error('dispatch registration delete failed');
    }
    return next(args);
  }, { step: 'initialize', name: 'holdDispatchDelete' });
  const session = { session_id: 'stop-session', filing_user_id: 'filed-account-1' };
  let request: Promise<Response> | undefined;
  try {
    await stack.sessionMetadata.recordTurn('account-1', session.session_id, { filingUserId: session.filing_user_id, title: 'Stop acknowledgement' });
    const registered = defined(await stack.sessionMetadata.get('account-1', session.session_id), 'registered Session');
    const answered = vi.fn();
    request = Promise.resolve(stack.app.request(`/threads/${session.session_id}/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'run-1' }),
    })).then((response) => { answered(); return response; });
    await Promise.race([deleting, request.then((response) => { throw new Error(`Stop answered before acknowledgement: HTTP ${response.status}`); })]);
    await setImmediate();
    expect(answered).not.toHaveBeenCalled();
    await expect(stack.sessionMetadata.assertNoDispatch(registered)).rejects.toBeInstanceOf(SessionDispatchPendingError);
    release();
    const response = await request;
    expect(response.status).toBe(deleteFails ? 502 : 204);
    if (deleteFails) {
      expect(await response.json()).toMatchObject({ detail: 'The Turn could not be stopped: dispatch registration delete failed' });
      await expect(stack.sessionMetadata.assertNoDispatch(registered)).rejects.toBeInstanceOf(SessionDispatchPendingError);
    } else await expect(stack.sessionMetadata.assertNoDispatch(registered)).resolves.toBeUndefined();
  } finally {
    release();
    await request;
    await stack.stop();
  }
}, 15_000);
