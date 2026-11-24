import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from './browser.js';
import { startStack, type Stack } from './stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

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
      { title: 'about activity-rates', completedAt: expect.any(String) },
      { title: 'about activity-earnings', completedAt: expect.any(String) },
    ]);
    expect(tasks.map(({ completedAt }) => completedAt)).toEqual(tasks.map(({ completedAt }) => completedAt).sort().reverse());
  });

  it('is empty for an account with no Sessions', async () => {
    const { browser } = await chattingBrowser();

    const response = await browser.get('/activity');

    expect(await response.json()).toEqual({ tasks: [] });
  });

  it('refuses a request without a Account', async () => {
    const response = await stack.browser().get('/activity');

    expect(response.status).toBe(401);
  });
});
