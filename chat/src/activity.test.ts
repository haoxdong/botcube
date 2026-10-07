import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';

// Each request acts as the account its x-account header names.
let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess({ cartridge: { requester: async (c) => ({ owner: defined(c.req.header('x-account'), 'an x-account header') }) } });
});
afterAll(() => stack.stop());

const activity = (account: string) => stack.app.request('/activity', { headers: { 'x-account': account } });

afterEach(() => {
  vi.useRealTimers();
});

const rows = async (account: string) => ((await (await activity(account)).json()) as { tasks: unknown[] }).tasks.length;

/**
 * Finish one Turn in each thread, the first at `at` and each next an hour later, each once its Activity row is saved:
 * that happens after its stream closed.
 */
async function chat(account: string, at: string, ...threadIds: string[]): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  let saved = await rows(account);
  for (const [index, threadId] of threadIds.entries()) {
    vi.setSystemTime(Date.parse(at) + index * 3_600_000);
    // eslint-disable-next-line no-await-in-loop -- turns are sent in thread order
    const response = await stack.app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-account': account },
      body: JSON.stringify({
        threadId,
        runId: 'run-1',
        state: {},
        messages: [{ id: 'm1', role: 'user', content: `about ${threadId}` }],
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    });
    expect(response.status).toBe(200);
    // eslint-disable-next-line no-await-in-loop -- turns are sent in thread order
    await response.text();
    saved += 1;
    // eslint-disable-next-line no-await-in-loop -- each Turn's row is saved before the next Turn starts
    await vi.waitFor(async () => expect(await rows(account)).toBe(saved));
  }
}

describe('GET /activity', () => {
  it("lists the finished Turns of the account's Sessions, under each filing user, most recent first", async () => {
    await chat('worker', '2026-10-01T09:00:00.000Z', 'earnings', 'rates');

    const response = await activity('worker');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tasks: [
        { title: 'Answered a question', summary: 'Replied to the user', completedAt: '2026-10-01T10:00:00.000Z' },
        { title: 'Answered a question', summary: 'Replied to the user', completedAt: '2026-10-01T09:00:00.000Z' },
      ],
    });
  });

  it("shows each summarized Turn's title and summary, and the request's first line, failed on why, for the rest", async () => {
    onTestFinished(() => {
      stack.bedrock.turnSummary = { title: 'Answered a question', summary: 'Replied to the user' };
    });
    stack.bedrock.turnSummary = 'fail';
    await chat('summarized', '2026-10-02T01:00:00.000Z', 'unsummarized');
    stack.bedrock.turnSummary = { title: 'Chart the 10y', summary: 'Charted the 10y yield since January' };
    await chat('summarized', '2026-10-02T02:00:00.000Z', 'yields');

    expect(await (await activity('summarized')).json()).toEqual({
      tasks: [
        { title: 'Chart the 10y', summary: 'Charted the 10y yield since January', completedAt: '2026-10-02T02:00:00.000Z' },
        {
          summary: 'about unsummarized',
          completedAt: '2026-10-02T01:00:00.000Z',
          failed: 'The Turn summary could not be made: The summary model answered HTTP 500',
        },
      ],
    });
  });

  it('lists a Turn that ended in a run error as failed, with its request line, its error line and no summary', async () => {
    stack.agentcore.script('broken', {
      kind: 'stream',
      frames: [{ type: 'RUN_STARTED' }, { type: 'RUN_ERROR', message: 'Model overloaded\nRetry in a minute', code: 'INTERNAL_ERROR' }].map(
        (frame) => `data: ${JSON.stringify(frame)}`,
      ),
    });
    await chat('failing', '2026-10-06T01:00:00.000Z', 'broken');

    expect(await (await activity('failing')).json()).toEqual({
      tasks: [{ summary: 'about broken', failed: 'Model overloaded', completedAt: '2026-10-06T01:00:00.000Z' }],
    });
    expect(stack.bedrock.summarizedTurns()).not.toContainEqual(expect.objectContaining({ request: 'about broken' }));
  });

  it('reads Session Metadata alone, with no session API call', async () => {
    const sessions = Array.from({ length: 12 }, (_, index) => `quick-${index}`);
    await chat('quick', '2026-10-03T00:00:00.000Z', ...sessions);
    const before = stack.sessionApi.events().length;

    const response = await activity('quick');

    expect(((await response.json()) as { tasks: unknown[] }).tasks).toHaveLength(12);
    expect(stack.sessionApi.events().slice(before)).toEqual([]);
  });

  it("leaves out another account's Turns and a deleted Session's", async () => {
    await chat('keeper', '2026-10-04T01:00:00.000Z', 'kept', 'deleted');
    await chat('stranger', '2026-10-04T03:00:00.000Z', 'theirs');
    expect((await stack.app.request('/threads/deleted', { method: 'DELETE', headers: { 'x-account': 'keeper' } })).ok).toBe(true);

    expect(await (await activity('keeper')).json()).toEqual({
      tasks: [{ title: 'Answered a question', summary: 'Replied to the user', completedAt: '2026-10-04T01:00:00.000Z' }],
    });
  });

  it('fails loudly with a 500 on a Turn saved before Activity entries, until the Activity backfill runs', async () => {
    await chat('unfilled', '2026-10-05T01:00:00.000Z', 'old');
    await DynamoDBDocumentClient.from(stack.table.client).send(
      new PutCommand({
        TableName: stack.table.name,
        Item: {
          pk: 'TURN_SUMMARIES#filed-unfilled',
          sk: 'SESSION#old#TURN#before-3226',
          session_id: 'old',
          message_id: 'before-3226',
          title: 'Old title',
          summary: 'Old summary',
        },
      }),
    );

    const response = await activity('unfilled');

    expect(response.status).toBe(500);
  });
});
