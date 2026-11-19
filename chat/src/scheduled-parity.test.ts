import { format } from 'node:util';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AWS_ACCESS_KEY_ID } from '../test/fakes/credentials.js';
import { motoEndpoint } from '../test/fakes/moto.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inProcessBrowser } from '../test/in-process-browser.js';
import { defined } from '../test/defined.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
type Browser = ReturnType<typeof inProcessBrowser>;

let stack: InProcessStack;
let scheduler: NonNullable<InProcessStack['scheduler']>;
beforeEach(async () => {
  stack = await startInProcess({ scheduled: true });
  scheduler = defined(stack.scheduler, 'scheduled fixture');
});
afterEach(async () => { vi.restoreAllMocks(); await stack.stop(); });

/** What the user confirms: the agent's proposal, in the user's timezone. */
const MORNING_BRIEF = {
  title: 'Morning brief',
  prompt: 'Summarize overnight moves in US rates',
  schedule: 'cron(0 8 ? * MON-FRI *)',
  timezone: 'America/New_York',
};

interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  schedule: string;
  timezone: string;
  startDate?: string;
  paused: boolean;
  proposalId: string;
  nextRun?: string;
  ended: boolean;
  sideChat: string | null;
}

async function visitor(): Promise<Browser> {
  const browser = inProcessBrowser(stack);
  await browser.openAccountSession();
  return browser;
}

async function confirm(browser: Browser, proposal: object = MORNING_BRIEF, proposalId: string = randomUUID()): Promise<ScheduledTask> {
  const response = await browser.post('/scheduled-tasks', { ...proposal, proposalId });
  expect(response.status).toBe(201);
  return (await response.json()) as ScheduledTask;
}

async function scheduled(browser: Browser): Promise<ScheduledTask[]> {
  const response = await browser.get('/scheduled-tasks');
  expect(response.status).toBe(200);
  return ((await response.json()) as { tasks: ScheduledTask[] }).tasks;
}

describe('POST /scheduled-tasks', () => {
  it('confirms a proposal without adding a start bound and schedules it', async () => {
    const browser = await visitor();

    const task = await confirm(browser, MORNING_BRIEF, 'call-1');

    expect(task).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), ...MORNING_BRIEF, paused: false, proposalId: 'call-1', nextRun: expect.any(String), ended: false, sideChat: null });
    expect(await scheduled(browser)).toEqual([task]);
    expect(await scheduler.schedule(task.id)).toMatchObject({
      ScheduleExpression: 'cron(0 8 ? * MON-FRI *)',
      ScheduleExpressionTimezone: 'America/New_York',
      State: 'ENABLED',
      Target: { Arn: scheduler.runs.queueArn, RoleArn: scheduler.runs.roleArn },
    });
  });

  it('answers a proposal confirmed again with the task it already made', async () => {
    const browser = await visitor();
    const task = await confirm(browser, MORNING_BRIEF, 'call-1');

    const again = await browser.post('/scheduled-tasks', { ...MORNING_BRIEF, proposalId: 'call-1' });

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(task);
    expect(await scheduled(browser)).toEqual([task]);
  });

  it("keeps each account's tasks to itself", async () => {
    await confirm(await visitor());

    expect(await scheduled(await visitor())).toEqual([]);
  });

});

describe('the cap on scheduled tasks', () => {
  it('refuses the eleventh task and schedules nothing for it', async () => {
    const browser = await visitor();
    for (let n = 1; n <= 10; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- tasks are confirmed one at a time
      await confirm(browser, { ...MORNING_BRIEF, title: `Brief ${n}` });
    }

    const response = await browser.post('/scheduled-tasks', { ...MORNING_BRIEF, title: 'Brief 11', proposalId: randomUUID() });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: 'An account can schedule at most 10 tasks' });
    expect((await scheduled(browser)).map(({ title }) => title)).not.toContain('Brief 11');
  });

  it('frees a place when a task is deleted', async () => {
    const browser = await visitor();
    const tasks: ScheduledTask[] = [];
    for (let n = 1; n <= 10; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- tasks are confirmed one at a time
      tasks.push(await confirm(browser, { ...MORNING_BRIEF, title: `Brief ${n}` }));
    }

    expect((await browser.delete(`/scheduled-tasks/${tasks[0]?.id}`)).status).toBe(204);

    const replacement = await confirm(browser, { ...MORNING_BRIEF, title: 'Brief 11' });
    expect((await browser.delete(`/scheduled-tasks/${replacement.id}`)).status).toBe(204);
    tasks[0] = await confirm(browser, { ...MORNING_BRIEF, title: 'Brief 1' });
  });
});

async function patch(browser: Browser, id: string, changes: object): Promise<Response> {
  return browser.request(`/scheduled-tasks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(changes),
  });
}

describe('managing a scheduled task', () => {

  it('pauses a task with its schedule', async () => {
    const browser = await visitor();
    const { id } = await confirm(browser, MORNING_BRIEF, 'call-1');

    const paused = await patch(browser, id, { paused: true });

    expect(paused.status).toBe(200);
    const expected = { id, ...MORNING_BRIEF, paused: true, proposalId: 'call-1', ended: false, sideChat: null };
    expect(await paused.json()).toEqual(expected);
    expect(await scheduler.schedule(id)).toMatchObject({ State: 'DISABLED' });
    expect(await scheduled(browser)).toEqual([expected]);
  });

  it('edits what a task asks and when it runs', async () => {
    const browser = await visitor();
    const { id } = await confirm(browser, MORNING_BRIEF, 'call-1');

    const edited = await patch(browser, id, {
      prompt: 'Summarize overnight moves in FX',
      schedule: 'cron(30 7 ? * MON-FRI *)',
    });

    expect(edited.status).toBe(200);
    expect(await scheduled(browser)).toEqual([
      {
        id,
        ...MORNING_BRIEF,
        prompt: 'Summarize overnight moves in FX',
        schedule: 'cron(30 7 ? * MON-FRI *)',
        paused: false,
        proposalId: 'call-1',
        nextRun: expect.any(String),
        ended: false,
        sideChat: null,
      },
    ]);
    expect(await scheduler.schedule(id)).toMatchObject({ ScheduleExpression: 'cron(30 7 ? * MON-FRI *)' });
  });

  it('deletes a task and its schedule', async () => {
    const browser = await visitor();
    const { id } = await confirm(browser);

    const response = await browser.delete(`/scheduled-tasks/${id}`);

    expect(response.status).toBe(204);
    expect(await scheduled(browser)).toEqual([]);
    expect(await scheduler.schedule(id)).toBeNull();
  });

  it("does not touch another account's task", async () => {
    const { id } = await confirm(await visitor());

    const response = await (await visitor()).delete(`/scheduled-tasks/${id}`);

    expect(response.status).toBe(404);
    expect(await scheduler.schedule(id)).not.toBeNull();
  });
});

/** What has been posted to the Session so far, waiting up to 20 s for the first post. */
async function posted(sessionId: string): Promise<string[]> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const posts = stack.sessionApi
      .events()
      .flatMap((event) => (event.operation === 'post' && event.sessionId === sessionId ? [event.content ?? ''] : []));
    if (posts.length > 0 || Date.now() > deadline) return posts;
    // eslint-disable-next-line no-await-in-loop -- polls until the queued run is done
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const answer = (...frames: object[]) => ({
  kind: 'stream' as const,
  frames: [{ type: 'RUN_STARTED' }, ...frames, { type: 'RUN_FINISHED' }].map(
    (frame) => `data: ${JSON.stringify(frame)}`
  ),
});

async function sideChats(browser: Browser): Promise<{ id: string; title: string }[]> {
  return ((await (await browser.get('/threads')).json()) as { threads: { id: string; title: string }[] }).threads;
}

describe('a scheduled run', () => {
  it('runs the task in a fresh Side Chat and posts its answer to the Main Chat', async () => {
    const browser = await visitor();
    const task = await confirm(browser, { ...MORNING_BRIEF, prompt: 'Brief me on rates' });
    stack.agentcore.scriptPrompt(
      'Brief me on rates',
      answer(
        { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'The 10y yield ' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'fell 5bp overnight.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'a1' }
      )
    );
    const { id: mainChat } = (await (await browser.get('/main-chat')).json()) as { id: string };

    await scheduler.fire(task.id);

    expect(await posted(mainChat)).toEqual(['Scheduled task "Morning brief": The 10y yield fell 5bp overnight.']);
    const [run] = await sideChats(browser);
    expect(run).toMatchObject({ title: 'Morning brief' });
    expect(run?.id).not.toBe(mainChat);
    expect(stack.agentcore.invocationFor(run?.id ?? '').payload).toMatchObject({
      messages: [{ role: 'user', content: 'Brief me on rates' }],
    });
  });

  it("puts what the run did in the Activity: its Turn's title and summary", async () => {
    const browser = await visitor();
    const task = await confirm(browser, { ...MORNING_BRIEF, prompt: 'Brief me on oil' });
    stack.agentcore.scriptPrompt(
      'Brief me on oil',
      answer(
        { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'Brent rose 2%.' },
        { type: 'TEXT_MESSAGE_END', messageId: 'a1' }
      )
    );
    stack.bedrock.turnSummary = { title: 'Brief on oil', summary: 'Reported Brent up 2%' };
    const { id: mainChat } = (await (await browser.get('/main-chat')).json()) as { id: string };

    await scheduler.fire(task.id);

    expect(await posted(mainChat)).toHaveLength(1);
    expect(((await (await browser.get('/activity')).json()) as { tasks: unknown[] }).tasks).toContainEqual({
      title: 'Brief on oil',
      summary: 'Reported Brent up 2%',
      completedAt: expect.any(String),
    });
    expect(stack.bedrock.summarizedTurns()).toContainEqual({ request: 'Brief me on oil', answer: 'Brent rose 2%.' });
  });


  it('posts the summary failure to Main Chat and keeps its queue delivery failed', async () => {
    const logged = vi.spyOn(console, 'error');
    const browser = await visitor();
    const task = await confirm(browser, { ...MORNING_BRIEF, prompt: 'Brief me with a broken summary' });
    stack.agentcore.scriptPrompt('Brief me with a broken summary', answer(
      { type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: 'Rates rose.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'a1' },
    ));
    const { id: mainChat } = (await (await browser.get('/main-chat')).json()) as { id: string };
    stack.bedrock.turnSummary = 'fail';
    try {
      await scheduler.fire(task.id);
      expect(await posted(mainChat)).toEqual([
        'Scheduled task "Morning brief" failed: The Turn summary could not be saved: The summary model answered HTTP 500',
      ]);
      await vi.waitFor(() => expect(logged.mock.calls).toContainEqual(['Scheduled run failed', expect.any(Error)]));
      expect(await scheduler.queued()).toBe(1);
    } finally {
      stack.bedrock.turnSummary = { title: 'Answered a question', summary: 'Replied to the user' };
    }
  });

  it('posts a failed run to the Main Chat', async () => {
    const browser = await visitor();
    const task = await confirm(browser, { ...MORNING_BRIEF, prompt: 'Brief me on equities' });
    stack.agentcore.scriptPrompt('Brief me on equities', { kind: 'error', status: 502, body: 'Runtime unavailable' });
    const { id: mainChat } = (await (await browser.get('/main-chat')).json()) as { id: string };

    await scheduler.fire(task.id);

    expect(await posted(mainChat)).toEqual([
      'Scheduled task "Morning brief" failed: AgentCore upstream returned HTTP 502: Runtime unavailable',
    ]);
  });
});


describe('managing a scheduled task', () => {
  it('preserves the classified unknown-group error and durable state at the origin HTTP boundary', async () => {
    const logged = vi.spyOn(console, 'error');
    const documents = DynamoDBDocumentClient.from(stack.table.client);
    const browser = await visitor();
    const { accountId } = await browser.openAccountSession();
    const task = await confirm(browser);
    expect((await patch(browser, task.id, { paused: true })).status).toBe(200);
    const removed = await fetch(`${motoEndpoint()}/schedules/${task.id}?groupName=${scheduler.runs.group}`, {
      method: 'DELETE',
      headers: { authorization: `AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY_ID}/20260101/us-east-1/scheduler/aws4_request, SignedHeaders=host, Signature=0` },
    });
    expect(removed.status).toBe(200);
    const pk = `SCHEDULED#${accountId}`;
    const read = async (sk: string) => (await documents.send(new GetCommand({
      TableName: stack.table.name, Key: { pk, sk }, ConsistentRead: true,
    }))).Item;
    await documents.send(new UpdateCommand({
      TableName: stack.table.name, Key: { pk, sk: `TASK#${task.id}` },
      UpdateExpression: 'REMOVE schedule_group',
    }));
    const before = await Promise.all([read(`TASK#${task.id}`), read(`PROPOSAL#${task.proposalId}`), read('COUNT')]);
    expect(before.every((item) => item !== undefined)).toBe(true);
    expect(before[2]?.tasks).toBe(1);

    const response = await browser.delete(`/scheduled-tasks/${task.id}`);

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ detail: 'Scheduled task schedule group is unknown' });
    expect(await Promise.all([read(`TASK#${task.id}`), read(`PROPOSAL#${task.proposalId}`), read('COUNT')])).toEqual(before);
    const { nextRun: _, ...asPaused } = { ...task, paused: true };
    expect(await scheduled(browser)).toEqual([asPaused]);
    expect(logged.mock.calls.map((args) => format(...args)).join('\n')).toContain('HttpError: Scheduled task schedule group is unknown');
    logged.mockRestore();
  });




});

