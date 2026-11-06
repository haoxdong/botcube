import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { DynamoDBSessionMetadata } from './session-metadata.js';
import { defined } from '../test/defined.js';
import { startInProcess } from '../test/in-process.js';

it.each(['thread', 'account'] as const)('finishes deleting an empty pre-cutover Session through %s deletion', async (deletion) => {
  const stack = await startInProcess();
  const documents = DynamoDBDocumentClient.from(stack.table.client);
  const sessionId = 'untracked-empty';
  try {
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: {
      pk: 'SESSIONS#account-1', sk: `SESSION#${sessionId}`, session_id: sessionId,
      filing_user_id: 'filed-account-1', record_state: 'empty', startup_required: true, read_only: true,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    } }));
    expect(await stack.sessionMetadata.get('account-1', sessionId)).toMatchObject({
      session_id: sessionId, record_state: 'empty', startup_required: true,
    });
    if (deletion === 'thread') {
      const response = await stack.app.request(`/threads/${sessionId}`, { method: 'DELETE' });
      expect(response.status).toBe(204);
    } else {
      await stack.history.delete('account-1');
    }
    await expect.poll(() => stack.sessionApi.events().filter(({ operation }) => operation === 'purge'), { timeout: 1_000 }).toContainEqual({
      operation: 'purge', sessionId, userId: 'filed-account-1',
    });
    await expect.poll(() => stack.sessionMetadata.pendingPurges(), { timeout: 1_000 }).toEqual([]);
    expect(await stack.sessionMetadata.get('account-1', sessionId)).toBeNull();
  } finally {
    await stack.stop();
  }
});

const preCutoverHistories = [
  { title: 'Historical Turn' },
  { latest_message_id: 'message' },
  { turn_running_since: '2026-01-01T00:00:00Z', turn_run_id: 'run' },
];

it.each(preCutoverHistories)('finishes deleting a pre-cutover chat with history %j', async (extra) => {
  const stack = await startInProcess();
  const documents = DynamoDBDocumentClient.from(stack.table.client);
  try {
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: {
      pk: 'SESSIONS#account-1', sk: 'SESSION#stale-history', session_id: 'stale-history',
      filing_user_id: 'filed-account-1', record_state: 'saved', read_only: true,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra,
    } }));
    await stack.history.delete('account-1');
    await expect.poll(() => stack.sessionApi.events().filter(({ operation }) => operation === 'purge'), { timeout: 1_000 }).toEqual([
      { operation: 'purge', sessionId: 'stale-history', userId: 'filed-account-1' },
    ]);
    await expect.poll(() => stack.sessionMetadata.pendingPurges(), { timeout: 1_000 }).toEqual([]);
    expect(await stack.sessionMetadata.get('account-1', 'stale-history')).toBeNull();
  } finally {
    await stack.stop();
  }
});

it.each(['namespaced', 'legacy'])('retains the %s writer gate across replacement-task recovery', async (registry) => {
  const stack = await startInProcess();
  const documents = DynamoDBDocumentClient.from(stack.table.client);
  const sessionId = 'empty-with-writer';
  try {
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: {
      pk: 'SESSIONS#account-1', sk: `SESSION#${sessionId}`, session_id: sessionId,
      filing_user_id: 'filed-account-1', record_state: 'empty', startup_required: true, read_only: true,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    } }));
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: {
      pk: registry === 'legacy' ? `DISPATCH#${sessionId}` : `DISPATCH#${JSON.stringify(['filed-account-1', sessionId])}`,
      sk: 'pending-writer', dispatcher: 'old-task',
    } }));
    await expect(stack.history.delete('account-1')).rejects.toMatchObject({ status: 503 });
    const replacement = new DynamoDBSessionMetadata(stack.table.name, stack.table.client);
    const job = defined((await replacement.pendingPurges()).find((row) => row.session_id === sessionId), 'recovered purge');
    await expect(replacement.assertNoDispatch(job)).rejects.toThrow('still registered');
    expect(stack.sessionApi.events().filter(({ operation }) => operation === 'purge')).toEqual([]);
    await documents.send(new DeleteCommand({ TableName: stack.table.name, Key: {
      pk: registry === 'legacy' ? `DISPATCH#${sessionId}` : `DISPATCH#${JSON.stringify(['filed-account-1', sessionId])}`,
      sk: 'pending-writer',
    } }));
    await expect(replacement.assertNoDispatch(job)).resolves.toBeUndefined();
    await stack.history.delete('account-1');
    expect(stack.sessionApi.events()).toContainEqual({ operation: 'purge', sessionId, userId: 'filed-account-1' });
    expect(await replacement.pendingPurges()).toEqual([]);
  } finally {
    await stack.stop();
  }
});
