import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { CreateQueueCommand, DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { loadDeployment } from 'botcube-deployment-config/load';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatTable } from '../test/fakes/stack.js';
import { createScheduledRuns, SchedulerView, type ScheduledRuns } from '../test/fakes/scheduler.js';
import { motoAws, motoEndpoint } from '../test/fakes/moto.js';
import { chatScheduling, type ChatScheduling } from './schedules.js';

const example = (name: string) => loadDeployment(fileURLToPath(new URL(`../../examples/${name}/deployment-config.json`, import.meta.url))).config;

let table: string;
let queueUrl: string;
let sqs: SQSClient;
let clients: { dynamodb: DynamoDBClient; sqs: SQSClient; scheduler: SchedulerClient };

beforeAll(() => {
  sqs = new SQSClient(motoAws());
  clients = { dynamodb: new DynamoDBClient(motoAws()), sqs, scheduler: new SchedulerClient(motoAws()) };
});

beforeEach(async () => {
  table = `schedules-${randomUUID()}`;
  await createChatTable(motoEndpoint(), table);
  ({ QueueUrl: queueUrl = '' } = await sqs.send(new CreateQueueCommand({ QueueName: `runs-${randomUUID()}` })));
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const enterprise = () => chatScheduling(example('enterprise').schedules, { BOTCUBE_SCHEDULED_RUNS_QUEUE_URL: queueUrl }, table, clients);

/** The runs the queue holds, by task, emptying it. */
async function delivered(): Promise<string[]> {
  const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }));
  await Promise.all(Messages.map(({ ReceiptHandle }) => sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle }))));
  return Messages.map(({ Body = '' }) => (JSON.parse(Body) as { taskId: string }).taskId).sort();
}

async function at(instant: string, ...pollers: ChatScheduling[]): Promise<string[]> {
  vi.setSystemTime(new Date(instant));
  await Promise.all(pollers.map((poller) => poller.poll?.tick()));
  return delivered();
}

describe('the enterprise example schedules from its table', () => {
  it('fires cron, rate and at schedules on time in a non-UTC time zone, once across restarted and concurrent pollers', async () => {
    vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
    const scheduling = enterprise();
    if (scheduling === null) throw new Error('the enterprise example schedules nothing');
    const owner = randomUUID();
    const timezone = 'America/New_York';
    const create = async (schedule: string) =>
      (await scheduling.tasks.create(owner, randomUUID(), { title: schedule, prompt: 'Brief me', schedule, timezone })).task.id;
    const cron = await create('cron(30 9 * * ? *)');
    const rate = await create('rate(2 hours)');
    const once = await create('at(2026-11-16T10:15:00)');

    expect(await at('2026-11-16T13:59:59.000Z', scheduling)).toEqual([]);
    expect(await at('2026-11-16T14:00:00.000Z', scheduling)).toEqual([rate]);
    expect(await at('2026-11-16T14:29:59.000Z', scheduling)).toEqual([]);
    const restarted = enterprise();
    const concurrent = enterprise();
    if (restarted === null || concurrent === null) throw new Error('the enterprise example schedules nothing');
    expect(await at('2026-11-16T14:30:00.000Z', restarted, concurrent)).toEqual([cron]);
    expect(await at('2026-11-16T14:30:05.000Z', scheduling, restarted, concurrent)).toEqual([]);
    expect(await at('2026-11-16T15:15:00.000Z', restarted, concurrent)).toEqual([once]);
    expect(await at('2026-11-16T16:00:00.000Z', restarted, concurrent)).toEqual([rate]);
    expect(await at('2026-11-17T14:30:00.000Z', restarted, concurrent)).toEqual([cron, rate].sort());
    expect(await at('2026-11-18T14:30:00.000Z', restarted)).toEqual([cron, rate].sort());
  });

  it('pauses and resumes a task through its schedule row', async () => {
    vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
    const scheduling = enterprise();
    if (scheduling === null) throw new Error('the enterprise example schedules nothing');
    const owner = randomUUID();
    const { task } = await scheduling.tasks.create(owner, randomUUID(), { title: 'Brief', prompt: 'Brief me', schedule: 'cron(30 9 * * ? *)', timezone: 'America/New_York' });
    await scheduling.tasks.update(owner, task.id, { paused: true });
    expect(await at('2026-11-16T14:30:00.000Z', scheduling)).toEqual([]);
    await scheduling.tasks.update(owner, task.id, { paused: false });
    expect(await at('2026-11-17T14:30:00.000Z', scheduling)).toEqual([task.id]);
    await scheduling.tasks.delete(owner, task.id);
    expect(await at('2026-11-18T14:30:00.000Z', scheduling)).toEqual([]);
  });
});

describe('a deployment on the default schedules adapter', () => {
  let runs: ScheduledRuns;
  beforeAll(async () => {
    runs = await createScheduledRuns(motoEndpoint());
  });

  it('keeps its existing schedules when it moves to the table poller', async () => {
    vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
    const env = {
      BOTCUBE_SCHEDULE_GROUP: runs.group, BOTCUBE_SCHEDULER_ROLE_ARN: runs.roleArn,
      BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN: runs.queueArn, BOTCUBE_SCHEDULED_RUNS_QUEUE_URL: queueUrl,
    };
    const existingBot = chatScheduling({ kind: 'eventbridge-scheduler' }, env, table, clients);
    if (existingBot === null) throw new Error('The deployment schedules nothing');
    expect(existingBot.poll).toBeUndefined();
    const owner = randomUUID();
    const { task: existing } = await existingBot.tasks.create(owner, randomUUID(), { title: 'Brief', prompt: 'Brief me', schedule: 'cron(30 9 * * ? *)', timezone: 'America/New_York' });
    vi.setSystemTime(new Date('2026-11-16T12:00:01.000Z'));
    const { task: paused } = await existingBot.tasks.create(owner, randomUUID(), { title: 'Later', prompt: 'Later', schedule: 'rate(1 hour)', timezone: 'UTC' });
    await existingBot.tasks.update(owner, paused.id, { paused: true });
    expect(await new SchedulerView(motoEndpoint(), runs).schedule(existing.id)).toMatchObject({ ScheduleExpression: 'cron(30 9 * * ? *)' });

    const moved = enterprise();
    if (moved === null) throw new Error('the enterprise example schedules nothing');
    expect(await at('2026-11-16T12:05:00.000Z', moved)).toEqual([]);
    expect(await moved.tasks.list(owner)).toMatchObject([{ id: existing.id, nextRun: '2026-11-16T14:30:00.000Z' }, { id: paused.id, paused: true }]);
    expect(await at('2026-11-16T14:30:00.000Z', moved, enterprise() ?? moved)).toEqual([existing.id]);
    await moved.tasks.update(owner, paused.id, { paused: false });
    expect(await at('2026-11-16T15:30:00.000Z', moved)).toEqual([paused.id]);
  });
});

describe('a deployment with schedules turned off', () => {
  it('offers no scheduled tasks, even with a run queue in its environment', () => {
    expect(chatScheduling({ kind: 'none' }, { BOTCUBE_SCHEDULED_RUNS_QUEUE_URL: queueUrl }, table, clients)).toBeNull();
  });
});

describe('a deployment on the table poller', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stops startup with no run queue, naming it, instead of scheduling nothing', () => {
    expect(() => chatScheduling({ kind: 'table-poller' }, {}, table, clients)).toThrow('schedules.kind: table-poller needs BOTCUBE_SCHEDULED_RUNS_QUEUE_URL');
  });

  it('takes its region from the SDK, failing with none rather than assuming us-east-1', async () => {
    vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', motoEndpoint());
    vi.stubEnv('AWS_ENDPOINT_URL_SQS', motoEndpoint());
    vi.stubEnv('AWS_REGION', undefined);
    vi.stubEnv('AWS_DEFAULT_REGION', undefined);
    vi.stubEnv('AWS_PROFILE', undefined);
    vi.stubEnv('AWS_CONFIG_FILE', '/nonexistent/aws-config');
    const scheduling = chatScheduling({ kind: 'table-poller' }, { BOTCUBE_SCHEDULED_RUNS_QUEUE_URL: queueUrl }, table);

    await expect(scheduling?.tasks.list(randomUUID())).rejects.toThrow('Region is missing');
  });
});
