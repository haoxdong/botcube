import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { backfillActivity } from './activity-backfill.js';
import type { SessionApi } from './session-api.js';

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess();
});
afterAll(() => stack.stop());

const T1 = '2026-09-01T09:00:00+00:00';
const T2 = '2026-09-01T10:00:00+00:00';

/** A session API whose `activity` answers each Session's Turns from `tasks`, or fails for a Session missing there. */
function sessionApiOf(tasks: Record<string, { messageId?: string; summary: string; completedAt: string }[]>): SessionApi {
  return async (request) => {
    const [session] = (request as { sessions: { sessionId: string }[] }).sessions;
    const answered = tasks[session?.sessionId ?? ''];
    if (answered === undefined) throw new Error('Session session-x has 2 Turns but 3 user messages');
    return { tasks: answered.map((task) => ({ sessionId: session?.sessionId, ...task })) };
  };
}

/** A Turn row saved before the Activity backfill: its summary alone. */
async function oldRow(filingUserId: string, sessionId: string, messageId: string) {
  await DynamoDBDocumentClient.from(stack.table.client).send(
    new PutCommand({
      TableName: stack.table.name,
      Item: {
        pk: `TURN_SUMMARIES#${filingUserId}`,
        sk: `SESSION#${sessionId}#TURN#${messageId}`,
        session_id: sessionId,
        message_id: messageId,
        title: `Title ${messageId}`,
        summary: `Summary of ${messageId}`,
      },
    }),
  );
}

describe('the Activity backfill', () => {
  it('fills old rows and creates missing ones, keeps summaries and saved entries, and changes nothing when run again', async () => {
    await stack.sessionMetadata.recordTurn('owner-1', 'session-1', { filingUserId: 'filed-1', title: 'One' });
    await oldRow('filed-1', 'session-1', 'summarized');
    await stack.sessionMetadata.saveTurnSummary(
      'owner-1',
      { sessionId: 'session-1', filingUserId: 'filed-1', messageId: 'saved' },
      { request: 'Saved request', completedAt: T2 },
    );
    const invoke = sessionApiOf({
      'session-1': [
        { messageId: 'summarized', summary: 'Summarize AAPL', completedAt: T1 },
        { messageId: 'unsummarized', summary: 'Chart the 10y', completedAt: T1 },
        { messageId: 'saved', summary: 'A different line', completedAt: T1 },
      ],
    });

    const dryRun = await backfillActivity(stack.sessionMetadata, invoke, { apply: false });
    const before = await stack.sessionMetadata.turnSummaries('filed-1');
    const applied = await backfillActivity(stack.sessionMetadata, invoke, { apply: true });
    const again = await backfillActivity(stack.sessionMetadata, invoke, { apply: true });

    expect(dryRun).toEqual({ sessions: 1, turns: 3, writes: 2, failed: [], unfilled: [] });
    expect(before).toHaveLength(2);
    expect(applied).toEqual(dryRun);
    expect(again).toEqual({ ...dryRun, writes: 0 });
    expect(await stack.sessionMetadata.turnSummaries('filed-1')).toEqual([
      { session_id: 'session-1', message_id: 'saved', request: 'Saved request', completed_at: T2 },
      {
        session_id: 'session-1',
        message_id: 'summarized',
        request: 'Summarize AAPL',
        completed_at: T1,
        title: 'Title summarized',
        summary: 'Summary of summarized',
      },
      { session_id: 'session-1', message_id: 'unsummarized', request: 'Chart the 10y', completed_at: T1 },
    ]);
  });

  it('reports a Session the session API cannot read, and its rows left without an entry', async () => {
    await stack.sessionMetadata.recordTurn('owner-2', 'unreadable', { filingUserId: 'filed-2', title: 'Two' });
    await oldRow('filed-2', 'unreadable', 'message-1');

    const report = await backfillActivity(stack.sessionMetadata, sessionApiOf({}), { apply: true });

    expect(report.failed).toContain('unreadable: Session session-x has 2 Turns but 3 user messages');
    expect(report.unfilled).toEqual(['unreadable Turn message-1']);
  });

  it('reports a Turn the session API answers without a request message ID', async () => {
    await stack.sessionMetadata.recordTurn('owner-3', 'anonymous', { filingUserId: 'filed-3', title: 'Three' });

    const report = await backfillActivity(
      stack.sessionMetadata,
      sessionApiOf({ anonymous: [{ summary: 'No ID', completedAt: T1 }] }),
      { apply: false },
    );

    expect(report.failed).toContain(`anonymous: a Turn finished at ${T1} has no request message ID`);
  });
});
