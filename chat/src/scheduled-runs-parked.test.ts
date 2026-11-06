import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defined } from '../test/defined.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import type { ParkHistory } from './park-history.js';

let stack: InProcessStack;
const asked: Date[] = [];
let parkedUntil = 0;
const parkHistory: ParkHistory = {
  productName: 'BotCube',
  parkedAt: async (time) => {
    asked.push(time);
    return time.getTime() <= parkedUntil;
  },
};

beforeAll(async () => {
  stack = await startInProcess({ scheduled: true, parkHistory });
});
afterAll(() => stack.stop());

const owner = () => `owner-${Math.random().toString(36).slice(2)}`;
const request = (account: string, path: string, body?: unknown) =>
  stack.app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-test-owner': account },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function fireTask(account: string, prompt: string): Promise<void> {
  stack.agentcore.scriptPrompt(prompt, {
    kind: 'stream',
    frames: () => [{ type: 'RUN_STARTED' }, { type: 'TEXT_MESSAGE_CHUNK', messageId: 'brief', role: 'assistant', delta: 'Payrolls beat.' }, { type: 'RUN_FINISHED' }]
      .map((frame) => `data: ${JSON.stringify(frame)}`),
  });
  const { id } = (await (await request(account, '/scheduled-tasks', {
    title: 'Payrolls', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt,
  })).json()) as { id: string };
  await defined(stack.scheduler, 'the stack schedules tasks').fire(id);
}

async function mainChatPosts(account: string): Promise<string[]> {
  const { id } = (await (await request(account, '/main-chat')).json()) as { id: string };
  for (;;) {
    const posts = stack.sessionApi.events().flatMap((event) => (event.operation === 'post' && event.sessionId === id ? [event.content ?? ''] : []));
    if (posts.length > 0) return posts;
    // eslint-disable-next-line no-await-in-loop -- polls until the queued run is done
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('a scheduled run due while production was Parked', () => {
  it('is skipped, not run late, and the Main Chat says it was due while paused', async () => {
    parkedUntil = Number.POSITIVE_INFINITY;
    const account = owner();
    const prompt = `Parked ${Math.random().toString(36).slice(2)}`;
    const sent = Date.now();

    await fireTask(account, prompt);

    expect(await mainChatPosts(account)).toEqual(['Scheduled task "Payrolls" skipped: it was due while BotCube was paused']);
    expect(stack.agentcore.invocations().some(({ body }) => body.includes(prompt))).toBe(false);
    expect(defined(asked.at(-1), 'the checked fire time').getTime()).toBeGreaterThanOrEqual(Math.floor(sent / 1000) * 1000);
  });

  it('runs when it was due while Live', async () => {
    parkedUntil = 0;
    const account = owner();

    await fireTask(account, `Live ${Math.random().toString(36).slice(2)}`);

    expect(await mainChatPosts(account)).toEqual(['Scheduled task "Payrolls": Payrolls beat.']);
  });
});
