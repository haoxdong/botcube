import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from './browser.js';
import { startStack, type Stack } from './stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

/** A Turn the agent answers with this text. */
const answer = (text: string) => ({
  kind: 'stream' as const,
  frames: [
    { type: 'RUN_STARTED' },
    { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: text },
    { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
    { type: 'RUN_FINISHED' },
  ].map((frame) => `data: ${JSON.stringify(frame)}`),
});

async function chattingBrowser(...topics: string[]): Promise<{ browser: Browser }> {
  const browser = stack.browser();
  await browser.openAccountSession();
  for (const topic of topics) {
    // eslint-disable-next-line no-await-in-loop -- turns are sent in thread order
    const response = await browser.sendTurn(await browser.newSideChat(), { text: `about ${topic}` });
    expect(response.status).toBe(200);
    // eslint-disable-next-line no-await-in-loop -- turns are sent in thread order
    await response.text();
  }
  return { browser };
}

/** The account's Activity once it lists at least this many Turns: each is saved after its stream closed. */
async function activityOf(browser: Browser, count: number): Promise<{ completedAt: string }[]> {
  let tasks: { completedAt: string }[] = [];
  await expect.poll(async () => {
    ({ tasks } = (await (await browser.get('/activity')).json()) as { tasks: { completedAt: string }[] });
    return tasks.length;
  }).toBeGreaterThanOrEqual(count);
  return tasks;
}

describe('GET /activity', () => {
  it("lists the finished Turns of every one of the account's Sessions, most recent first", async () => {
    const { browser } = await chattingBrowser('activity-earnings', 'activity-rates');

    const tasks = await activityOf(browser, 2);

    expect(tasks).toEqual([
      { title: 'Answered a question', summary: 'Replied to the user', completedAt: expect.any(String) },
      { title: 'Answered a question', summary: 'Replied to the user', completedAt: expect.any(String) },
    ]);
    expect(tasks.map(({ completedAt }) => completedAt)).toEqual(tasks.map(({ completedAt }) => completedAt).sort().reverse());
  });

  it('is empty for an account with no Sessions', async () => {
    const { browser } = await chattingBrowser();

    const response = await browser.get('/activity');

    expect(await response.json()).toEqual({ tasks: [] });
  });

  it('says what the agent did in each finished Turn: a title and a one-line summary', async () => {
    const { browser } = await chattingBrowser();
    const threadId = await browser.newSideChat();
    stack.agentcore.script(threadId, answer('Apple beat on revenue; services grew 12%.'));
    stack.bedrock.turnSummary = { title: 'Summarize AAPL earnings', summary: 'Found Apple beat on revenue' };
    await (await browser.sendTurn(threadId, { text: 'about activity-summarized' })).text();

    expect(await activityOf(browser, 1)).toEqual([
      { title: 'Summarize AAPL earnings', summary: 'Found Apple beat on revenue', completedAt: expect.any(String) },
    ]);
    expect(stack.bedrock.summarizedTurns()).toContainEqual({
      request: 'about activity-summarized',
      answer: 'Apple beat on revenue; services grew 12%.',
    });
  });

  it.each([
    ['an upstream error', 'fail', 'The summary model answered HTTP 500'],
    ['a malformed result', { title: '', summary: 'Missing title' }, 'The summary model answered without a title and summary'],
  ] as const)('finishes the answer, and shows %s from the summary model in the Activity, and logs it', async (_label, result, detail) => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();
    stack.agentcore.script(threadId, answer('Done.'));
    stack.bedrock.turnSummary = result;
    try {
      const response = await browser.sendTurn(threadId, { text: 'Summarize this task' });
      expect(response.status).toBe(200);
      const frames = (await response.text()).split('\n\n').filter((frame) => frame.startsWith('data:'))
        .map((frame) => JSON.parse(frame.slice(5)) as { type: string });
      expect(frames.map(({ type }) => type)).not.toContain('RUN_ERROR');
      expect(frames.at(-1)).toEqual({ type: 'RUN_FINISHED' });

      await expect.poll(() => stack.logs()).toContain(`Turn summary failed session_id=${threadId}`);
      expect(await activityOf(browser, 1)).toContainEqual({
        summary: 'Summarize this task',
        completedAt: expect.any(String),
        failed: `The Turn summary could not be made: ${detail}`,
      });
    } finally {
      stack.bedrock.turnSummary = { title: 'Answered a question', summary: 'Replied to the user' };
    }
  });

  it('refuses a request without a Account', async () => {
    const response = await stack.browser().get('/activity');

    expect(response.status).toBe(401);
  });
});
