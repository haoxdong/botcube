import { randomUUID } from 'node:crypto';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { ListSchedulesCommand, SchedulerClient, ValidationException } from '@aws-sdk/client-scheduler';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inject } from 'vitest';
import { Hono } from 'hono';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../test/fakes/stack.js';
import { SchedulerView, createScheduledRuns, type ScheduledRuns } from '../test/fakes/scheduler.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';
import { ScheduledTasks, schedulerConfigFromEnv } from './scheduled-tasks.js';
import { DynamoDBSessionMetadata } from './session-metadata.js';
import { DynamoDBAgentDocuments } from './agent-documents.js';
import type { AccountHistory } from './cartridge.js';
import { createChatService } from './server.js';

let stack: InProcessStack;
let scheduler: SchedulerView;
beforeAll(async () => {
  stack = await startInProcess({ scheduled: true });
  scheduler = defined(stack.scheduler, 'the stack schedules tasks');
});
afterAll(() => stack.stop());

const MORNING_BRIEF = {
  title: 'Morning brief',
  prompt: 'Summarize overnight moves in US rates',
  schedule: 'cron(0 8 ? * MON-FRI *)',
  timezone: 'America/New_York',
};

interface Task {
  id: string;
  title: string;
  prompt: string;
  schedule: string;
  timezone: string;
  model?: string;
  paused: boolean;
  proposalId: string;
}

const request = (owner: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  stack.app.request(path, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-test-owner': owner },
    ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
  });

async function confirm(owner: string, proposal: object = MORNING_BRIEF, proposalId: string = randomUUID()): Promise<Task> {
  const response = await request(owner, '/scheduled-tasks', { method: 'POST', body: { ...proposal, proposalId } });
  expect(response.status).toBe(201);
  return (await response.json()) as Task;
}

async function listed(owner: string): Promise<Task[]> {
  const response = await request(owner, '/scheduled-tasks');
  expect(response.status).toBe(200);
  return ((await response.json()) as { tasks: Task[] }).tasks;
}

const owner = () => `owner-${Math.random().toString(36).slice(2)}`;

describe('rate schedule cadence', () => {
  it.each([
    ['rate(1 minute)', '2030-10-06T09:40:32.000Z'],
    ['rate(5 minutes)', '2030-10-06T09:44:32.000Z'],
    ['rate(1 hour)', '2030-10-06T10:39:32.000Z'],
    ['rate(2 hours)', '2030-10-06T11:39:32.000Z'],
    ['rate(1 day)', '2030-10-07T09:39:32.000Z'],
    ['rate(2 days)', '2030-10-08T09:39:32.000Z'],
  ])('waits one interval before the first run of %s', async (schedule, firstRun) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-10-06T09:39:32.000Z'));
    try {
      const task = await confirm(owner(), { ...MORNING_BRIEF, schedule });

      expect(await scheduler.schedule(task.id)).toMatchObject({
        State: 'ENABLED', StartDate: new Date(firstRun).getTime() / 1000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['2030-10-06T09:40:31.000Z', '2030-10-06T09:44:32.000Z'],
    ['2030-10-06T10:01:00.000Z', '2030-10-06T10:04:32.000Z'],
    ['2030-10-06T10:04:32.000Z', '2030-10-06T10:09:32.000Z'],
  ])('resumes on the next creation-anchored tick after %s', async (resumedAt, nextRun) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-10-06T09:39:32.000Z'));
    try {
      const account = owner();
      const task = await confirm(account, { ...MORNING_BRIEF, schedule: 'rate(5 minutes)' });
      expect((await request(account, `/scheduled-tasks/${task.id}`, { method: 'PATCH', body: { paused: true } })).status).toBe(200);
      vi.setSystemTime(new Date(resumedAt));

      const response = await request(account, `/scheduled-tasks/${task.id}`, { method: 'PATCH', body: { paused: false } });

      expect(response.status).toBe(200);
      expect(await scheduler.schedule(task.id)).toMatchObject({
        State: 'ENABLED', StartDate: new Date(nextRun).getTime() / 1000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the creation anchor through edits and an Account Claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-10-06T09:39:32.000Z'));
    try {
      const [source, destination] = [owner(), owner()];
      const task = await confirm(source, { ...MORNING_BRIEF, schedule: 'rate(5 minutes)' });
      vi.setSystemTime(new Date('2030-10-06T09:40:00.000Z'));

      expect((await request(source, `/scheduled-tasks/${task.id}`, {
        method: 'PATCH', body: { title: 'Updated brief' },
      })).status).toBe(200);
      expect(await scheduler.schedule(task.id)).toMatchObject({
        StartDate: new Date('2030-10-06T09:44:32.000Z').getTime() / 1000,
      });

      vi.setSystemTime(new Date('2030-10-06T10:01:00.000Z'));
      expect((await request(source, `/scheduled-tasks/${task.id}`, {
        method: 'PATCH', body: { schedule: 'rate(10 minutes)' },
      })).status).toBe(200);
      expect(await scheduler.schedule(task.id)).toMatchObject({
        ScheduleExpression: 'rate(10 minutes)', StartDate: new Date('2030-10-06T10:09:32.000Z').getTime() / 1000,
      });

      vi.setSystemTime(new Date('2030-10-06T10:11:00.000Z'));
      expect((await request(source, `/scheduled-tasks/${task.id}`, {
        method: 'PATCH', body: { timezone: 'Europe/London' },
      })).status).toBe(200);
      expect(await scheduler.schedule(task.id)).toMatchObject({
        ScheduleExpressionTimezone: 'Europe/London', StartDate: new Date('2030-10-06T10:19:32.000Z').getTime() / 1000,
      });

      vi.setSystemTime(new Date('2030-10-06T10:22:00.000Z'));
      await stack.history.transfer(source, destination);
      expect(await scheduler.schedule(task.id)).toMatchObject({
        StartDate: new Date('2030-10-06T10:29:32.000Z').getTime() / 1000,
        Target: { Input: JSON.stringify({ owner: destination, taskId: task.id }) },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves cron execution on its calendar schedule', async () => {
    const task = await confirm(owner());

    expect(await scheduler.schedule(task.id)).toMatchObject({
      ScheduleExpression: MORNING_BRIEF.schedule, ScheduleExpressionTimezone: MORNING_BRIEF.timezone, State: 'ENABLED',
    });
    expect(await scheduler.schedule(task.id)).toMatchObject({ StartDate: null });
  });
});

describe('POST /scheduled-tasks', () => {
  it('refuses task creation admitted before account history deletion completes', async () => {
    const account = owner();
    let admit!: () => void;
    let resume!: () => void;
    const admitted = new Promise<void>((resolve) => { admit = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const deleting = await startInProcess({
      scheduled: true,
      cartridge: {
        requester: async () => {
          admit();
          await paused;
          return { owner: account };
        },
      },
    });
    try {
      const creating = deleting.app.request('/scheduled-tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...MORNING_BRIEF, proposalId: randomUUID() }),
      });
      await admitted;
      await deleting.history.delete(account);
      resume();

      const response = await creating;

      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ detail: 'The account history was deleted' });
      const listed = await deleting.app.request('/scheduled-tasks');
      expect(await listed.json()).toEqual({ tasks: [] });
      const scheduled = new SchedulerClient({
        region: 'us-east-1',
        endpoint: inject('dynamodbEndpoint'),
        credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
      });
      const { Schedules } = await scheduled.send(new ListSchedulesCommand({
        GroupName: defined(deleting.scheduler, 'the stack schedules tasks').runs.group,
      }));
      expect(Schedules).toEqual([]);
    } finally {
      resume();
      await deleting.stop();
    }
  });

  it('stores the confirmed task and schedules it to send its run to the queue', async () => {
    const account = owner();

    const task = await confirm(account, {
      title: '  Morning brief ',
      prompt: ' Summarize overnight moves in US rates\n',
      schedule: ' cron(0 8 ? * MON-FRI *) ',
      timezone: ' America/New_York ',
    }, 'call-1');

    expect(task).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), ...MORNING_BRIEF, paused: false, proposalId: 'call-1' });
    expect(await listed(account)).toEqual([task]);
    expect(await scheduler.schedule(task.id)).toMatchObject({
      Name: task.id,
      GroupName: scheduler.runs.group,
      ScheduleExpression: 'cron(0 8 ? * MON-FRI *)',
      ScheduleExpressionTimezone: 'America/New_York',
      State: 'ENABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: scheduler.runs.queueArn,
        RoleArn: scheduler.runs.roleArn,
        Input: JSON.stringify({ owner: account, taskId: task.id }),
      },
    });
  });

  it('names no model: its runs use the account default until an edit picks one', async () => {
    const account = owner();

    const task = await confirm(account, { ...MORNING_BRIEF, model: 'thorough' });
    const edited = await request(account, `/scheduled-tasks/${task.id}`, { method: 'PATCH', body: { model: 'plan' } });

    expect(task).not.toHaveProperty('model');
    expect(await edited.json()).toEqual({ ...task, model: 'plan' });
    expect(await listed(account)).toEqual([{ ...task, model: 'plan' }]);
  });

  it('lists tasks in the order they were confirmed', async () => {
    const account = owner();
    const first = await confirm(account, { ...MORNING_BRIEF, title: 'First' });
    const second = await confirm(account, { ...MORNING_BRIEF, title: 'Second' });
    const third = await confirm(account, { ...MORNING_BRIEF, title: 'Third' });

    expect(await listed(account)).toEqual([first, second, third]);
  });

  it("lists only the account's own tasks", async () => {
    await confirm(owner());

    expect(await listed(owner())).toEqual([]);
  });

  it.each([
    ['a body that is not an object', '"Morning brief"', 'Expected a JSON object'],
    ['a body that is not JSON', 'not json', 'Expected a JSON object'],
    ['a missing field', { ...MORNING_BRIEF, prompt: undefined }, 'prompt is required'],
    ['a blank field', { ...MORNING_BRIEF, timezone: '   ' }, 'timezone is required'],
    ['a field that is not text', { ...MORNING_BRIEF, schedule: 8 }, 'schedule is required'],
    ['a proposal without its ID', MORNING_BRIEF, 'proposalId is required'],
    ['a blank proposal ID', { ...MORNING_BRIEF, proposalId: ' ' }, 'proposalId is required'],
  ])('refuses %s and schedules nothing', async (_, body, detail) => {
    const account = owner();

    const response = await request(account, '/scheduled-tasks', { method: 'POST', body });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail });
    expect(await listed(account)).toEqual([]);
  });

  it('answers a proposal confirmed again with the task it already made, scheduling it once', async () => {
    const account = owner();
    const proposalId = randomUUID();
    const task = await confirm(account, MORNING_BRIEF, proposalId);

    const again = await request(account, '/scheduled-tasks', { method: 'POST', body: { ...MORNING_BRIEF, proposalId } });

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(task);
    expect(await listed(account)).toEqual([task]);
    for (let n = 2; n <= 10; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- tasks are confirmed one at a time
      await confirm(account, { ...MORNING_BRIEF, title: `Brief ${n}` });
    }
  });

  it("confirms another account's proposal ID as its own task", async () => {
    const proposalId = randomUUID();
    const theirs = await confirm(owner(), MORNING_BRIEF, proposalId);

    const mine = await confirm(owner(), MORNING_BRIEF, proposalId);

    expect(mine.id).not.toBe(theirs.id);
  });

  it("takes a deleted task's proposal again", async () => {
    const account = owner();
    const proposalId = randomUUID();
    const { id } = await confirm(account, MORNING_BRIEF, proposalId);
    expect((await request(account, `/scheduled-tasks/${id}`, { method: 'DELETE' })).status).toBe(204);

    const again = await confirm(account, MORNING_BRIEF, proposalId);

    expect(again.id).not.toBe(id);
    expect(await listed(account)).toEqual([again]);
  });

  it('refuses the eleventh task, and takes another once one is deleted', async () => {
    const account = owner();
    const tasks: Task[] = [];
    for (let n = 1; n <= 10; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- tasks are confirmed one at a time
      tasks.push(await confirm(account, { ...MORNING_BRIEF, title: `Brief ${n}` }));
    }

    const refused = await request(account, '/scheduled-tasks', {
      method: 'POST',
      body: { ...MORNING_BRIEF, proposalId: randomUUID() },
    });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ detail: 'An account can schedule at most 10 tasks' });
    expect(await listed(account)).toEqual(tasks);
    await confirm(owner());
    expect((await request(account, `/scheduled-tasks/${tasks[3]?.id}`, { method: 'DELETE' })).status).toBe(204);
    await confirm(account, { ...MORNING_BRIEF, title: 'Brief 11' });
  });
});

describe('PATCH /scheduled-tasks/:id', () => {
  it('pauses and resumes the task with its schedule', async () => {
    const account = owner();
    const { id } = await confirm(account, MORNING_BRIEF, 'call-1');

    const paused = await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { paused: true } });

    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ id, ...MORNING_BRIEF, paused: true, proposalId: 'call-1' });
    expect(await scheduler.schedule(id)).toMatchObject({ State: 'DISABLED', ScheduleExpression: MORNING_BRIEF.schedule });
    expect(await listed(account)).toEqual([{ id, ...MORNING_BRIEF, paused: true, proposalId: 'call-1' }]);

    await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { paused: false } });

    expect(await scheduler.schedule(id)).toMatchObject({ State: 'ENABLED' });
  });

  it('edits only the fields sent, trimmed, and keeps the task paused', async () => {
    const account = owner();
    const { id } = await confirm(account, MORNING_BRIEF, 'call-1');
    await request(account, `/scheduled-tasks/${id}`, { method: 'PATCH', body: { paused: true } });

    const edited = await request(account, `/scheduled-tasks/${id}`, {
      method: 'PATCH',
      body: { prompt: ' Summarize overnight moves in FX ', schedule: 'rate(1 day)' },
    });

    const expected = {
      id,
      ...MORNING_BRIEF,
      prompt: 'Summarize overnight moves in FX',
      schedule: 'rate(1 day)',
      paused: true,
      proposalId: 'call-1',
    };
    expect(await edited.json()).toEqual(expected);
    expect(await listed(account)).toEqual([expected]);
    expect(await scheduler.schedule(id)).toMatchObject({
      ScheduleExpression: 'rate(1 day)',
      ScheduleExpressionTimezone: 'America/New_York',
      State: 'DISABLED',
      Target: { Input: JSON.stringify({ owner: account, taskId: id }) },
    });
  });

  it.each([
    ['paused that is not true or false', { paused: 'yes' }, 'paused must be true or false'],
    ['a blank field', { title: ' ' }, 'title is required'],
    ["a model that is not the account's", { model: 'retired' }, 'Model "retired" is not available to this account'],
    ['a model that is not a key', { model: 5 }, 'Model 5 is not available to this account'],
    ['a body that is not an object', '[]', 'Expected a JSON object'],
  ])('refuses %s and changes nothing', async (_, body, detail) => {
    const account = owner();
    const task = await confirm(account);

    const response = await request(account, `/scheduled-tasks/${task.id}`, { method: 'PATCH', body });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail });
    expect(await listed(account)).toEqual([task]);
  });

  it("does not find another account's task", async () => {
    const { id } = await confirm(owner());

    const response = await request(owner(), `/scheduled-tasks/${id}`, { method: 'PATCH', body: { paused: true } });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: 'Scheduled task not found' });
    expect(await scheduler.schedule(id)).toMatchObject({ State: 'ENABLED' });
  });
});

describe('DELETE /scheduled-tasks/:id', () => {
  it('deletes the task and its schedule', async () => {
    const account = owner();
    const kept = await confirm(account, { ...MORNING_BRIEF, title: 'Kept' });
    const { id } = await confirm(account);

    const response = await request(account, `/scheduled-tasks/${id}`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    expect(await listed(account)).toEqual([kept]);
    expect(await scheduler.schedule(id)).toBeNull();
    expect(await scheduler.schedule(kept.id)).not.toBeNull();
  });

  it("does not find another account's task", async () => {
    const { id } = await confirm(owner());

    const response = await request(owner(), `/scheduled-tasks/${id}`, { method: 'DELETE' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: 'Scheduled task not found' });
    expect(await scheduler.schedule(id)).not.toBeNull();
  });
});

describe("an account's scheduled tasks", () => {
  it('move with an Account Claim, scheduled to run as the claiming account', async () => {
    const [source, destination] = [owner(), owner()];
    const kept = await confirm(destination, { ...MORNING_BRIEF, title: 'Kept' });
    const first = await confirm(source, { ...MORNING_BRIEF, title: 'First' });
    const second = await confirm(source, { ...MORNING_BRIEF, title: 'Second' });
    await request(source, `/scheduled-tasks/${second.id}`, { method: 'PATCH', body: { paused: true } });

    await stack.history.transfer(source, destination);

    expect(await listed(source)).toEqual([]);
    expect(await listed(destination)).toEqual([kept, first, { ...second, paused: true }]);
    expect((await scheduler.schedule(first.id))?.Target.Input).toBe(JSON.stringify({ owner: destination, taskId: first.id }));
    expect(await scheduler.schedule(second.id)).toMatchObject({
      State: 'DISABLED',
      Target: { Input: JSON.stringify({ owner: destination, taskId: second.id }) },
    });
    expect((await request(destination, `/scheduled-tasks/${first.id}`, { method: 'DELETE' })).status).toBe(204);
  });

  it("free the claimed account's places under the cap", async () => {
    const [source, destination] = [owner(), owner()];
    await confirm(source, { ...MORNING_BRIEF, title: 'First' });
    await confirm(source, { ...MORNING_BRIEF, title: 'Second' });

    await stack.history.transfer(source, destination);

    for (let n = 1; n <= 10; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- tasks are confirmed one at a time
      await confirm(source, { ...MORNING_BRIEF, title: `Brief ${n}` });
    }
  });

  it('all move with an Account Claim past the cap, those past it paused, and none resumes or is added until the account is back under', async () => {
    const [source, destination] = [owner(), owner()];
    const held: Task[] = [];
    for (let n = 1; n <= 9; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- tasks are confirmed one at a time
      held.push(await confirm(destination, { ...MORNING_BRIEF, title: `Held ${n}` }));
    }
    const moved: Task[] = [];
    for (let n = 1; n <= 3; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- tasks are confirmed one at a time, so their order is known
      moved.push(await confirm(source, { ...MORNING_BRIEF, title: `Moved ${n}` }));
    }
    const [tenth, eleventh, twelfth] = moved as [Task, Task, Task];

    await stack.history.transfer(source, destination);

    expect(await listed(destination)).toEqual([...held, tenth, { ...eleventh, paused: true }, { ...twelfth, paused: true }]);
    expect(await scheduler.schedule(tenth.id)).toMatchObject({ State: 'ENABLED' });
    expect(await scheduler.schedule(eleventh.id)).toMatchObject({ State: 'DISABLED' });
    expect(await scheduler.schedule(twelfth.id)).toMatchObject({ State: 'DISABLED' });
    const resumed = await request(destination, `/scheduled-tasks/${eleventh.id}`, { method: 'PATCH', body: { paused: false } });
    expect(resumed.status).toBe(409);
    expect(await resumed.json()).toEqual({ detail: 'An account can schedule at most 10 tasks: delete one to resume another' });
    expect(await scheduler.schedule(eleventh.id)).toMatchObject({ State: 'DISABLED' });
    const added = await request(destination, '/scheduled-tasks', { method: 'POST', body: { ...MORNING_BRIEF, proposalId: randomUUID() } });
    expect(added.status).toBe(409);

    expect((await request(destination, `/scheduled-tasks/${twelfth.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(destination, `/scheduled-tasks/${held[0]?.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(destination, `/scheduled-tasks/${eleventh.id}`, { method: 'PATCH', body: { paused: false } })).status).toBe(200);
    expect(await scheduler.schedule(eleventh.id)).toMatchObject({ State: 'ENABLED' });
  });

  it.each([
    ['active', false, { paused: false, title: 'Edited active task', schedule: 'rate(1 day)' }],
    ['paused', true, { title: 'Edited paused task', schedule: 'rate(1 day)' }],
  ])('allow editing a task that stays %s while an Account Claim leaves the account over the cap', async (_, paused, changes) => {
    const [source, destination] = [owner(), owner()];
    const held: Task[] = [];
    for (let n = 1; n <= 9; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- tasks are confirmed one at a time, so their order is known
      held.push(await confirm(destination, { ...MORNING_BRIEF, title: `Held ${n}` }));
    }
    const tenth = await confirm(source, { ...MORNING_BRIEF, title: 'Tenth' });
    const eleventh = await confirm(source, { ...MORNING_BRIEF, title: 'Eleventh' });
    await stack.history.transfer(source, destination);
    const current = paused ? { ...eleventh, paused: true } : tenth;

    const response = await request(destination, `/scheduled-tasks/${current.id}`, { method: 'PATCH', body: changes });

    const edited = { ...current, ...changes };
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(edited);
    expect(await listed(destination)).toEqual([
      ...held,
      paused ? tenth : edited,
      paused ? edited : { ...eleventh, paused: true },
    ]);
    expect(await scheduler.schedule(current.id)).toMatchObject({
      ScheduleExpression: 'rate(1 day)',
      State: paused ? 'DISABLED' : 'ENABLED',
      Target: { Input: JSON.stringify({ owner: destination, taskId: current.id }) },
    });
  });

  it("answer a moved task's proposal, confirmed again, with that task", async () => {
    const [source, destination] = [owner(), owner()];
    const proposalId = randomUUID();
    const task = await confirm(source, MORNING_BRIEF, proposalId);

    await stack.history.transfer(source, destination);
    const again = await request(destination, '/scheduled-tasks', { method: 'POST', body: { ...MORNING_BRIEF, proposalId } });

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(task);
    expect((await confirm(source, MORNING_BRIEF, proposalId)).id).not.toBe(task.id);
  });

  it('are deleted, with their schedules, with the account', async () => {
    const account = owner();
    const { id } = await confirm(account);
    const other = await confirm(owner());

    await stack.history.delete(account);

    expect(await listed(account)).toEqual([]);
    expect(await scheduler.schedule(id)).toBeNull();
    expect(await scheduler.schedule(other.id)).not.toBeNull();
  });
});

describe('a Chat Service without scheduled tasks', () => {
  let unscheduled: InProcessStack;
  beforeAll(async () => {
    unscheduled = await startInProcess();
  });
  afterAll(() => unscheduled.stop());

  it.each([
    ['GET', '/scheduled-tasks', undefined],
    ['POST', '/scheduled-tasks', MORNING_BRIEF],
    ['PATCH', '/scheduled-tasks/task-1', { paused: true }],
    ['DELETE', '/scheduled-tasks/task-1', undefined],
  ])('answers %s %s with 503', async (method, path, body) => {
    const response = await unscheduled.app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: 'Scheduled tasks are not configured' });
  });
});

describe('ScheduledTasks', () => {
  const aws = {
    region: 'us-east-1',
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  };
  let table: string;
  let runs: ScheduledRuns;
  let dynamodb: DynamoDBClient;
  let realScheduler: SchedulerClient;
  beforeAll(async () => {
    const endpoint = inject('dynamodbEndpoint');
    table = `chat-${Math.random().toString(36).slice(2)}`;
    await createChatTable(endpoint, table);
    runs = await createScheduledRuns(endpoint);
    dynamodb = new DynamoDBClient({ ...aws, endpoint });
    realScheduler = new SchedulerClient({ ...aws, endpoint });
  });

  /** Scheduler that refuses its first request as this error, then answers as moto does. */
  const refusingOnce = (error: Error) => {
    let refused = false;
    return {
      send: async (command: unknown) => {
        if (!refused) {
          refused = true;
          throw error;
        }
        return realScheduler.send(command as Parameters<SchedulerClient['send']>[0]);
      },
    } as unknown as SchedulerClient;
  };
  const invalid = () => new ValidationException({ Message: 'Invalid Schedule Expression', message: 'Invalid Schedule Expression', $metadata: {} });

  function serviceForTasks(account: string, tasks: ScheduledTasks) {
    let history: AccountHistory | undefined;
    const app = createChatService(
      (hooks) => {
        history = hooks;
        return {
          corsOrigins: [],
          agentDocuments: { agentIdentity: { name: 'Test', character: '', vibe: '', avatar: '' }, soul: '' },
          models: [{ key: 'test', label: 'Test', provider: 'test' }],
          accountModels: async () => [],
          browserEventName: 'test:browser',
          routes: new Hono(),
          requester: async () => ({ owner: account }),
          filingUserId: (owner) => owner,
          invocationPayload: async (input) => ({ ...input, forwardedProps: { ...input.forwardedProps } }),
          credentialProps: [],
          scheduledRequester: async (owner) => ({ owner }),
          signInNeeded: async () => null,
          authorizeBrowserLiveView: async () => undefined,
          warmSession: async () => undefined,
        };
      },
      {
        agentCore: null, localHarnessUrl: null, corsOrigins: null,
        region: 'us-east-1', agentCoreEndpoint: stack.agentcore.url, browserId: 'test',
        sessionApi: { localUrl: stack.sessionApi.url }, warmupTimeoutMs: 10_000,
        turnSummaryModel: { region: 'us-east-1', url: `${stack.bedrock.url}/model/summary/converse` },
      },
      new DynamoDBSessionMetadata(table, dynamodb),
      new DynamoDBAgentDocuments(table, dynamodb),
      undefined,
      {
        tasks,
        queue: { receive: () => new Promise(() => undefined), delete: async () => undefined },
        draining: async () => false,
      },
    );
    return { app, history: defined(history, 'the Chat Service Account History') };
  }

  it.each(['title', 'prompt'] as const)('keeps an acknowledged pause when an earlier %s edit resumes', async (field) => {
    const account = owner();
    const tasks = new ScheduledTasks(table, runs, dynamodb, realScheduler);
    const { task } = await tasks.create(account, randomUUID(), MORNING_BRIEF);
    let reached!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const delayed = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    let first = true;
    delayed.middlewareStack.add((next, context) => async (args) => {
      if (first && context.commandName === 'GetItemCommand') {
        first = false;
        const result = await next(args);
        reached();
        await held;
        return result;
      }
      return next(args);
    }, { step: 'initialize' });
    const { app } = serviceForTasks(account, new ScheduledTasks(table, runs, delayed, realScheduler));
    const other = serviceForTasks(account, tasks).app;
    const patch = (body: object) => app.request(`/scheduled-tasks/${task.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const editing = patch({ [field]: 'Updated morning brief' });
    try {
      await admitted;
      const paused = await other.request(`/scheduled-tasks/${task.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }),
      });
      expect(paused.status).toBe(200);
      expect(await tasks.get(account, task.id)).toMatchObject({ paused: true });
      expect(await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule(task.id)).toMatchObject({ State: 'DISABLED' });
      release();
      expect((await editing).status).toBe(200);
      const saved = await tasks.get(account, task.id);
      const scheduled = await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule(task.id);
      expect({ paused: saved?.paused, state: scheduled?.State }).toEqual({ paused: true, state: 'DISABLED' });
      expect(saved?.[field]).toBe('Updated morning brief');
    } finally {
      release();
      await editing;
    }
  });

  it('answers a completed confirmation again while Scheduler is unavailable', async () => {
    const account = owner();
    const proposalId = randomUUID();
    const original = new ScheduledTasks(table, runs, dynamodb, realScheduler);
    const { task } = await original.create(account, proposalId, MORNING_BRIEF);
    const send = async () => { throw new Error('Scheduler unavailable'); };
    const { app } = serviceForTasks(account, new ScheduledTasks(table, runs, dynamodb, { send } as unknown as SchedulerClient));

    const again = await app.request('/scheduled-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...MORNING_BRIEF, proposalId }),
    });

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(task);
    const listed = await serviceForTasks(account, original).app.request('/scheduled-tasks');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ tasks: [task] });
  });

  it('edits metadata while Scheduler is unavailable and still honors explicit pause and resume', async () => {
    const account = owner();
    const original = new ScheduledTasks(table, runs, dynamodb, realScheduler);
    const { task } = await original.create(account, randomUUID(), MORNING_BRIEF);
    const send = vi.fn(async () => { throw new Error('Scheduler unavailable'); });
    const { app } = serviceForTasks(account, new ScheduledTasks(table, runs, dynamodb, { send } as unknown as SchedulerClient));
    const edited = await app.request(`/scheduled-tasks/${task.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Updated title', prompt: 'Updated prompt' }),
    });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ title: 'Updated title', prompt: 'Updated prompt', paused: false });
    expect(send).not.toHaveBeenCalled();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await app.request(`/scheduled-tasks/${task.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: true }),
      })).status).toBe(500);
      expect(await original.get(account, task.id)).toMatchObject({ paused: false });
    } finally { errors.mockRestore(); }
    const working = serviceForTasks(account, original).app;
    const patch = (body: object) => working.request(`/scheduled-tasks/${task.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await patch({ title: 'Paused title', paused: true })).status).toBe(200);
    expect(await original.get(account, task.id)).toMatchObject({ title: 'Paused title', prompt: 'Updated prompt', paused: true });
    expect(await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule(task.id)).toMatchObject({ State: 'DISABLED' });
    expect((await patch({ paused: false })).status).toBe(200);
    expect(await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule(task.id)).toMatchObject({ State: 'ENABLED' });
  });

  it('fails metadata persistence loudly without changing the paused schedule, and permits an explicit retry', async () => {
    const account = owner();
    const original = new ScheduledTasks(table, runs, dynamodb, realScheduler);
    const { task } = await original.create(account, randomUUID(), MORNING_BRIEF);
    await original.update(account, task.id, { paused: true });
    const failing = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    let refused = false;
    failing.middlewareStack.add((next, context) => async (args) => {
      if (!refused && context.commandName === 'TransactWriteItemsCommand') {
        refused = true;
        throw new Error('Task metadata unavailable');
      }
      return next(args);
    }, { step: 'initialize' });
    const { app } = serviceForTasks(account, new ScheduledTasks(table, runs, failing, realScheduler));
    const patch = () => app.request(`/scheduled-tasks/${task.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Updated title' }),
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await patch()).status).toBe(500);
      expect(await original.get(account, task.id)).toMatchObject({ title: MORNING_BRIEF.title, paused: true });
      expect(await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule(task.id)).toMatchObject({ State: 'DISABLED' });
      expect((await patch()).status).toBe(200);
      expect(await original.get(account, task.id)).toMatchObject({ title: 'Updated title', paused: true });
    } finally { errors.mockRestore(); }
  });

  it.each([
    ['successful compensation', false, false, 0, false],
    ['failed compensation then retry', true, false, 0, false],
    ['task already erased', false, true, 0, false],
    ['metadata cleanup failure then retry', false, false, 1, false],
    ['metadata cleanup failure during absence repair', false, false, 2, false],
    ['deletion already erased the pending task', false, true, 0, true],
  ] as const)('compensates creation fenced before Scheduler accepts it: %s', async (_, cleanupFails, metadataRemoved, metadataFails, erasedBeforeCreate) => {
    const account = owner();
    let admitted!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => { admitted = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const delayedScheduler = new SchedulerClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    const outage = new Error('Scheduler cleanup is unavailable');
    const storageOutage = new Error('Task metadata cleanup is unavailable');
    const initialOutage = new Error('Initial Scheduler deletion is unavailable');
    const intercepted = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    let metadataCleanupFailures = 0;
    intercepted.middlewareStack.add((next, context) => async (args) => {
      if (metadataCleanupFailures < metadataFails && context.commandName === 'TransactWriteItemsCommand'
        && (args.input as { TransactItems: { Delete?: unknown }[] }).TransactItems[0]?.Delete !== undefined) {
        metadataCleanupFailures += 1;
        throw storageOutage;
      }
      return next(args);
    }, { step: 'initialize' });
    let deletions = 0;
    delayedScheduler.middlewareStack.add((next, context) => async (args) => {
      if (context.commandName === 'CreateScheduleCommand') {
        admitted();
        await paused;
        if (metadataRemoved && !erasedBeforeCreate) {
          const result = await next(args);
          await history.delete(account);
          return result;
        }
      }
      if (context.commandName === 'DeleteScheduleCommand') {
        deletions += 1;
        if (!erasedBeforeCreate && deletions === 1) throw initialOutage;
        if (cleanupFails && deletions === 2) throw outage;
      }
      return next(args);
    }, { step: 'initialize' });
    const tasks = new ScheduledTasks(table, runs, intercepted, delayedScheduler);
    const { app, history } = serviceForTasks(account, tasks);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const creating = app.request('/scheduled-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...MORNING_BRIEF, proposalId: randomUUID() }),
    });
    try {
      await reached;
      const [pending] = await tasks.list(account);
      expect(pending?.prompt).toBe(MORNING_BRIEF.prompt);
      // A real Scheduler outage remains visible; exact schedule absence permits metadata cleanup.
      if (erasedBeforeCreate) await expect(history.delete(account)).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
      else await expect(history.delete(account)).rejects.toBe(initialOutage);
      resume();
      const response = await creating;

      const view = new SchedulerView(inject('dynamodbEndpoint'), runs);
      const id = defined(pending, 'the admitted task').id;
      if (metadataRemoved && !erasedBeforeCreate) {
        expect(response.status).toBe(500);
        expect(errors.mock.calls).toHaveLength(1);
        expect(errors.mock.calls[0]?.[0]).toBe('POST /scheduled-tasks failed');
        expect(errors.mock.calls[0]?.[1]).toMatchObject({ name: 'ConditionalCheckFailedException' });
        expect(await tasks.list(account)).toEqual([]);
        expect(await view.schedule(id)).toBeNull();
      } else if (cleanupFails || metadataFails) {
        expect(response.status).toBe(500);
        expect(await response.text()).toBe('Internal Server Error');
        expect(errors.mock.calls).toEqual([['POST /scheduled-tasks failed', metadataFails ? storageOutage : outage]]);
        expect(await tasks.list(account)).toEqual([pending]);
        if (metadataFails) expect(await view.schedule(id)).toBeNull();
        else expect(await view.schedule(id)).toMatchObject({ State: 'ENABLED' });
      } else {
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({ detail: 'The account history was deleted' });
        expect(errors).not.toHaveBeenCalled();
        expect(await tasks.list(account)).toEqual([]);
        expect(await view.schedule(id)).toBeNull();
      }
      // A genuine SDK failure remains visible and retains the durable row needed to finish erasure.
      if (metadataFails === 2) {
        const failure = await history.delete(account).then(() => null, (error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors[0]).toMatchObject({ name: 'ResourceNotFoundException' });
        expect((failure as AggregateError).errors[1]).toBe(storageOutage);
        expect(await tasks.list(account)).toEqual([pending]);
      }
      if (metadataFails) await expect(history.delete(account)).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
      await history.delete(account);
      expect(await tasks.list(account)).toEqual([]);
      expect(await view.schedule(id)).toBeNull();
      const { Item: count } = await dynamodb.send(new GetItemCommand({
        TableName: table,
        Key: { pk: { S: `SCHEDULED#${account}` }, sk: { S: 'COUNT' } },
        ConsistentRead: true,
      }));
      expect(count?.tasks).toEqual({ N: '0' });
    } finally {
      resume();
      await creating;
      errors.mockRestore();
    }
  });

  it.each(['fence read', 'completion write'] as const)('retains pending creation cleanup when its post-Scheduler %s fails', async (failureStage) => {
    const account = owner();
    const readFailure = new Error('Owner fence read unavailable');
    let created = false;
    let admitted!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => { admitted = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const delayed = new SchedulerClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    delayed.middlewareStack.add((next, context) => async (args) => {
      if (context.commandName === 'CreateScheduleCommand') {
        admitted();
        await paused;
        const result = await next(args);
        created = true;
        return result;
      }
      return next(args);
    }, { step: 'initialize' });
    const documents = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    documents.middlewareStack.add((next, context) => async (args) => {
      if (created && failureStage === 'completion write' && ['UpdateCommand', 'UpdateItemCommand'].includes(context.commandName as string)) throw readFailure;
      if (created && failureStage === 'fence read' && ['GetCommand', 'GetItemCommand'].includes(context.commandName as string)) {
        const key = (args.input as { Key: { sk: string | { S: string } } }).Key.sk;
        if ((typeof key === 'string' ? key : key.S) === 'DELETED') throw readFailure;
      }
      return next(args);
    }, { step: 'initialize' });
    const tasks = new ScheduledTasks(table, runs, documents, delayed);
    const { app, history } = serviceForTasks(account, tasks);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const creating = app.request('/scheduled-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...MORNING_BRIEF, proposalId: randomUUID() }),
    });
    try {
      await reached;
      const [pending] = await tasks.list(account);
      const deletion = await history.delete(account).then(() => null, (error: unknown) => error);
      resume();
      const response = await creating;
      expect(response.status).toBe(500);
      expect(errors.mock.calls).toEqual([['POST /scheduled-tasks failed', readFailure]]);
      const id = defined(pending, 'the admitted task').id;
      await history.delete(account);
      expect(await tasks.list(account)).toEqual([]);
      expect(await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule(id)).toBeNull();
      expect(deletion).toMatchObject({ name: 'ResourceNotFoundException' });
    } finally {
      resume();
      await creating;
      errors.mockRestore();
    }
  });

  it.each(['account', 'task'] as const)('does not restore a task updated after %s deletion completes', async (deleted) => {
    const account = owner();
    const tasks = new ScheduledTasks(table, runs, dynamodb, realScheduler);
    const { task } = await tasks.create(account, randomUUID(), MORNING_BRIEF);
    const intercepted = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    let removed = false;
    intercepted.middlewareStack.add((next, context) => async (args) => {
      if (!removed && ['PutItemCommand', 'TransactWriteItemsCommand'].includes(context.commandName as string)) {
        removed = true;
        if (deleted === 'account') {
          await history.delete(account);
        } else await tasks.delete(account, task.id);
      }
      return next(args);
    }, { step: 'initialize' });
    const service = serviceForTasks(account, new ScheduledTasks(table, runs, intercepted, realScheduler));
    const { history } = service;
    const { app } = service;
    const response = await app.request(`/scheduled-tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Private prompt updated after deletion' }),
    });

    expect(await tasks.list(account)).toEqual([]);
    expect(response.status).toBe(deleted === 'account' ? 410 : 404);
    expect(await response.json()).toEqual({
      detail: deleted === 'account' ? 'The account history was deleted' : 'Scheduled task not found',
    });
    expect(await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule(task.id)).toBeNull();
  });

  it.each([['refusal', 400], ['outage', 500]] as const)('never confirms a pending proposal that Scheduler then rejects: %s', async (failure, status) => {
    const account = owner();
    const proposalId = randomUUID();
    let admitted!: () => void;
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => { admitted = resolve; });
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const delayed = new SchedulerClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    let refused = false;
    delayed.middlewareStack.add((next, context) => async (args) => {
      if (!refused && context.commandName === 'CreateScheduleCommand') {
        refused = true;
        admitted();
        await held;
        throw failure === 'refusal' ? invalid() : new Error('Scheduler is unavailable');
      }
      return next(args);
    }, { step: 'initialize' });
    const tasks = new ScheduledTasks(table, runs, dynamodb, delayed);
    const { app } = serviceForTasks(account, tasks);
    const confirm = () => app.request('/scheduled-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...MORNING_BRIEF, proposalId }),
    });
    const first = confirm();
    try {
      await reached;
      const duplicate = await confirm();
      resume();
      expect((await first).status).toBe(status);
      expect(await tasks.list(account)).toEqual([]);
      // No schedule was created. A successful duplicate confirmation would falsely promise a task.
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toEqual({ detail: 'Scheduled task confirmation is still pending; try again' });
      const recovered = await confirm();
      expect(recovered.status).toBe(201);
      const created = await recovered.json();
      const completedDuplicate = await confirm();
      expect(completedDuplicate.status).toBe(200);
      expect(await completedDuplicate.json()).toEqual(created);
      expect(await tasks.list(account)).toEqual([created]);
      expect(await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule((created as Task).id)).toMatchObject({ State: 'ENABLED' });
    } finally {
      resume();
      await first;
    }
  });

  it('allows explicit confirmation retry after a definite refusal is rolled back', async () => {
    const account = owner();
    const proposalId = randomUUID();
    const tasks = new ScheduledTasks(table, runs, dynamodb, refusingOnce(invalid()));
    const { app } = serviceForTasks(account, tasks);
    const confirm = () => app.request('/scheduled-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...MORNING_BRIEF, proposalId }),
    });
    expect((await confirm()).status).toBe(400);
    expect(await tasks.list(account)).toEqual([]);
    const retry = await confirm();
    expect(retry.status).toBe(201);
    const created = await retry.json() as Task;
    expect(await tasks.list(account)).toEqual([created]);
    expect(await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule(created.id)).toMatchObject({ State: 'ENABLED' });
  });

  it('recovers a refused confirmation after its rollback storage outage settles', async () => {
    const account = owner();
    const proposalId = randomUUID();
    const rollbackFailure = new Error('Rollback storage is unavailable');
    const documents = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    let failed = false;
    documents.middlewareStack.add((next, context) => async (args) => {
      const input = args.input as { TransactItems?: { Delete?: unknown }[] };
      if (!failed && context.commandName?.startsWith('TransactWrite') && input.TransactItems?.[0]?.Delete !== undefined) {
        failed = true;
        throw rollbackFailure;
      }
      return next(args);
    }, { step: 'initialize' });
    const tasks = new ScheduledTasks(table, runs, documents, refusingOnce(invalid()));
    const { app } = serviceForTasks(account, tasks);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const confirm = () => app.request('/scheduled-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...MORNING_BRIEF, proposalId }),
    });
    expect((await confirm()).status).toBe(500);
    expect(errors.mock.calls).toEqual([['POST /scheduled-tasks failed', expect.objectContaining({ errors: [expect.any(ValidationException), rollbackFailure] })]]);
    expect(await tasks.list(account)).toHaveLength(1);
    const retry = await confirm();
    expect(retry.status).toBe(201);
    const created = await retry.json() as Task;
    expect(await tasks.list(account)).toEqual([created]);
    expect(await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule(created.id)).toMatchObject({ State: 'ENABLED' });
  });

  it.each(['complete recovery storage outage', 'ambiguous Scheduler failure'])('retains honest pending state after %s', async (stage) => {
    const account = owner();
    const proposalId = randomUUID();
    const storageFailure = new Error('Creation recovery storage is unavailable');
    const documents = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    documents.middlewareStack.add((next, context) => async (args) => {
      const input = args.input as { UpdateExpression?: string; TransactItems?: { Delete?: unknown }[] };
      if (stage === 'complete recovery storage outage' && input.UpdateExpression?.includes('creation_refused')
        || context.commandName?.startsWith('TransactWrite') && input.TransactItems?.[0]?.Delete !== undefined) {
        throw storageFailure;
      }
      return next(args);
    }, { step: 'initialize' });
    const schedulerFailure = stage === 'complete recovery storage outage' ? invalid() : new Error('Scheduler response was lost');
    const tasks = new ScheduledTasks(table, runs, documents, refusingOnce(schedulerFailure));
    const { app } = serviceForTasks(account, tasks);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const confirm = () => app.request('/scheduled-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...MORNING_BRIEF, proposalId }),
    });
    expect((await confirm()).status).toBe(500);
    expect(errors.mock.calls).toEqual([['POST /scheduled-tasks failed', expect.objectContaining({ errors: stage === 'complete recovery storage outage' ? [schedulerFailure, storageFailure, storageFailure] : [schedulerFailure, storageFailure] })]]);
    const pending = await tasks.list(account);
    expect(pending).toHaveLength(1);
    expect((await confirm()).status).toBe(409);
    expect(await tasks.list(account)).toEqual(pending);
  });

  it('reports a failed refusal marker while still rolling back the rejected task', async () => {
    const account = owner();
    const proposalId = randomUUID();
    const markerFailure = new Error('Refusal marker write is unavailable');
    const documents = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    documents.middlewareStack.add((next) => async (args) => {
      if ((args.input as { UpdateExpression?: string }).UpdateExpression?.includes('creation_refused')) throw markerFailure;
      return next(args);
    }, { step: 'initialize' });
    const refusal = invalid();
    const tasks = new ScheduledTasks(table, runs, documents, refusingOnce(refusal));
    const { app } = serviceForTasks(account, tasks);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const confirm = () => app.request('/scheduled-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...MORNING_BRIEF, proposalId }),
    });
    expect((await confirm()).status).toBe(500);
    expect(errors.mock.calls).toEqual([['POST /scheduled-tasks failed', expect.objectContaining({ errors: [refusal, markerFailure] })]]);
    expect(await tasks.list(account)).toEqual([]);
    expect((await confirm()).status).toBe(201);
    expect(await tasks.list(account)).toHaveLength(1);
  });

  it('cleans a durably refused proposal once during concurrent explicit confirmations', async () => {
    const account = owner();
    const proposalId = randomUUID();
    const documents = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    let deletes = 0;
    let resume!: () => void;
    const held = new Promise<void>((resolve) => { resume = resolve; });
    documents.middlewareStack.add((next, context) => async (args) => {
      const input = args.input as { TransactItems?: { Delete?: unknown }[] };
      if (context.commandName?.startsWith('TransactWrite') && input.TransactItems?.[0]?.Delete !== undefined) {
        deletes += 1;
        if (deletes === 1) throw new Error('First rollback is unavailable');
        if (deletes === 3) resume();
        await held;
      }
      return next(args);
    }, { step: 'initialize' });
    const tasks = new ScheduledTasks(table, runs, documents, refusingOnce(invalid()));
    const { app } = serviceForTasks(account, tasks);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const confirm = () => app.request('/scheduled-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...MORNING_BRIEF, proposalId }),
    });
    expect((await confirm()).status).toBe(500);
    try {
      const responses = await Promise.all([confirm(), confirm()]);
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect(responses.every((response) => [200, 201, 409].includes(response.status))).toBe(true);
      const recovered = await confirm();
      expect(recovered.status).toBe(200);
      const created = await recovered.json() as Task;
      expect(await tasks.list(account)).toEqual([created]);
      for (let count = 1; count < 10; count += 1) {
        // eslint-disable-next-line no-await-in-loop -- fill the account's existing ten-task cap
        await tasks.create(account, randomUUID(), MORNING_BRIEF);
      }
      await expect(tasks.create(account, randomUUID(), MORNING_BRIEF)).rejects.toMatchObject({ status: 409 });
      expect(await tasks.list(account)).toHaveLength(10);
    } finally {
      resume();
    }
  });

  it.each(['completion marker', 'repair marker', 'schedule probe'])('recovers a completed confirmation after a failed %s write or read', async (stage) => {
    const account = owner();
    const proposalId = randomUUID();
    const failure = new Error('Completion marker storage is unavailable');
    const documents = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    let refused = 0;
    documents.middlewareStack.add((next, context) => async (args) => {
      if (refused < (stage === 'repair marker' ? 2 : 1) && ['UpdateCommand', 'UpdateItemCommand'].includes(context.commandName as string)
        && (args.input as { UpdateExpression?: string }).UpdateExpression?.includes('pending_creation')) {
        refused += 1;
        throw failure;
      }
      return next(args);
    }, { step: 'initialize' });
    const probeFailure = new Error('Scheduler status is unavailable');
    const schedulerClient = new SchedulerClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    let failedProbe = false;
    schedulerClient.middlewareStack.add((next, context) => async (args) => {
      if (stage === 'schedule probe' && !failedProbe && context.commandName === 'GetScheduleCommand') {
        failedProbe = true;
        throw probeFailure;
      }
      return next(args);
    }, { step: 'initialize' });
    const tasks = new ScheduledTasks(table, runs, documents, schedulerClient);
    const { app } = serviceForTasks(account, tasks);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const confirm = () => app.request('/scheduled-tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...MORNING_BRIEF, proposalId }),
    });
    expect((await confirm()).status).toBe(500);
    expect(errors.mock.calls).toEqual([['POST /scheduled-tasks failed', failure]]);
    const [created] = await tasks.list(account);
    const id = defined(created, 'Scheduler accepted the task').id;
    expect(await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule(id)).toMatchObject({ State: 'ENABLED' });
    if (stage !== 'completion marker') {
      expect((await confirm()).status).toBe(500);
      expect(errors.mock.calls.at(-1)).toEqual(['POST /scheduled-tasks failed', stage === 'repair marker' ? failure : probeFailure]);
      expect(await tasks.list(account)).toEqual([created]);
    }
    const recovered = await confirm();
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual(created);
    expect((await confirm()).status).toBe(200);
    expect(await tasks.list(account)).toEqual([created]);
  });

  it("answers Scheduler's refusal of a schedule with 400, storing nothing and keeping the place", async () => {
    const tasks = new ScheduledTasks(table, runs, dynamodb, refusingOnce(invalid()));

    await expect(tasks.create('refused', randomUUID(), MORNING_BRIEF)).rejects.toMatchObject({ status: 400, detail: 'Invalid Schedule Expression' });

    expect(await tasks.list('refused')).toEqual([]);
    for (let n = 1; n <= 10; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- tasks are confirmed one at a time
      await tasks.create('refused', randomUUID(), { ...MORNING_BRIEF, title: `Brief ${n}` });
    }
    expect(await tasks.list('refused')).toHaveLength(10);
  });

  it('propagates any other Scheduler failure as it is', async () => {
    const outage = new Error('Scheduler is down');
    const tasks = new ScheduledTasks(table, runs, dynamodb, refusingOnce(outage));

    await expect(tasks.create('outage', randomUUID(), MORNING_BRIEF)).rejects.toBe(outage);
    expect(await tasks.list('outage')).toEqual([]);
  });

  it('answers a refused edit with 400 and keeps the task as it was', async () => {
    const { task } = await new ScheduledTasks(table, runs, dynamodb, realScheduler).create('edited', randomUUID(), MORNING_BRIEF);
    const tasks = new ScheduledTasks(table, runs, dynamodb, refusingOnce(invalid()));

    await expect(tasks.update('edited', task.id, { schedule: 'every day' })).rejects.toMatchObject({ status: 400 });

    expect(await tasks.get('edited', task.id)).toEqual(task);
  });

  it('fails loud on a proposal confirmed again whose record is gone when it is read back', async () => {
    const proposalId = randomUUID();
    await new ScheduledTasks(table, runs, dynamodb, realScheduler).create('raced', proposalId, MORNING_BRIEF);
    // A client whose read of a proposal finds nothing, as one deleted in between would.
    const losingProposals = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    losingProposals.middlewareStack.add(
      (next, context) => async (args) =>
        context.commandName?.startsWith('Get') && JSON.stringify(args.input).includes('PROPOSAL#')
          ? { output: { $metadata: {} }, response: {} }
          : next(args),
      { step: 'initialize' },
    );
    const tasks = new ScheduledTasks(table, runs, losingProposals, realScheduler);

    await expect(tasks.create('raced', proposalId, MORNING_BRIEF)).rejects.toThrow(
      `Scheduled task proposal ${proposalId} has no task`,
    );
  });

  it('pauses a moved task when a task created during the Account Claim takes the last place under the cap', async () => {
    const [source, destination] = [`claimed-${randomUUID()}`, `claiming-${randomUUID()}`];
    const tasks = new ScheduledTasks(table, runs, dynamodb, realScheduler);
    for (let n = 1; n <= 9; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- tasks are confirmed one at a time
      await tasks.create(destination, randomUUID(), { ...MORNING_BRIEF, title: `Held ${n}` });
    }
    const { task: moved } = await tasks.create(source, randomUUID(), { ...MORNING_BRIEF, title: 'Moved' });
    // A scheduler that lets the user confirm a task on the claiming account just as the claim reschedules the first one.
    let raced = false;
    const racing = {
      send: async (command: unknown) => {
        if (!raced) {
          raced = true;
          await tasks.create(destination, randomUUID(), { ...MORNING_BRIEF, title: 'Raced' });
        }
        return realScheduler.send(command as Parameters<SchedulerClient['send']>[0]);
      },
    } as unknown as SchedulerClient;

    await new ScheduledTasks(table, runs, dynamodb, racing).transfer(source, destination);

    const held = await tasks.list(destination);
    expect(held.filter((task) => !task.paused)).toHaveLength(10);
    expect(held.find((task) => task.id === moved.id)).toEqual({ ...moved, paused: true });
    expect(await new SchedulerView(inject('dynamodbEndpoint'), runs).schedule(moved.id)).toMatchObject({
      State: 'DISABLED',
      Target: { Input: JSON.stringify({ owner: destination, taskId: moved.id }) },
    });
  });

  it('propagates a storage failure as it is', async () => {
    const tasks = new ScheduledTasks('missing-table', runs, dynamodb, realScheduler);

    await expect(tasks.create('stored', randomUUID(), MORNING_BRIEF)).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
  });
});

describe('schedulerConfigFromEnv', () => {
  const env = {
    BOTCUBE_SCHEDULE_GROUP: 'chat-scheduled-tasks',
    BOTCUBE_SCHEDULER_ROLE_ARN: 'arn:aws:iam::123456789012:role/runs',
    BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN: 'arn:aws:sqs:us-east-1:123456789012:runs',
    BOTCUBE_SCHEDULED_RUNS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/runs',
  };

  it('reads the schedule group, role and queue', () => {
    expect(schedulerConfigFromEnv(env)).toEqual({
      group: 'chat-scheduled-tasks',
      roleArn: 'arn:aws:iam::123456789012:role/runs',
      queueArn: 'arn:aws:sqs:us-east-1:123456789012:runs',
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/runs',
    });
  });

  it.each(Object.keys(env))('leaves scheduled tasks unconfigured without %s', (name) => {
    expect(schedulerConfigFromEnv({ ...env, [name]: '' })).toBeNull();
  });
});
