import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../test/fakes/stack.js';
import { createScheduledRuns, SchedulerView, type ScheduledRuns } from '../test/fakes/scheduler.js';
import { ScheduledTasks } from './scheduled-tasks.js';

const definition = { title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 hour)', timezone: 'UTC' };
const aws = { region: 'us-east-1', credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } };
let table: string;
let runs: ScheduledRuns;
let dynamodb: DynamoDBClient;
let scheduler: SchedulerClient;
let view: SchedulerView;

beforeAll(async () => {
  const endpoint = inject('dynamodbEndpoint');
  table = `time-${randomUUID()}`;
  await createChatTable(endpoint, table);
  runs = await createScheduledRuns(endpoint);
  dynamodb = new DynamoDBClient({ ...aws, endpoint });
  scheduler = new SchedulerClient({ ...aws, endpoint });
  view = new SchedulerView(endpoint, runs);
});

const normal = () => new ScheduledTasks(table, runs, dynamodb, scheduler);
const held = () => {
  let reach!: () => void;
  let release!: () => void;
  return { entered: new Promise<void>((resolve) => { reach = resolve; }), waiting: new Promise<void>((resolve) => { release = resolve; }), reach: () => reach(), release: () => release() };
};

async function raw(owner: string, id: string) {
  return (await DynamoDBDocumentClient.from(dynamodb).send(new GetCommand({ TableName: table, Key: { pk: `SCHEDULED#${owner}`, sk: `TASK#${id}` } }))).Item;
}

describe('timestamp task lifecycle', () => {
  it('rejects obsolete bounds and impossible calendar instants before storing anything', async () => {
    const tasks = normal();
    const owner = randomUUID();
    for (const changes of [{ maxRuns: 3 }, { endDate: '2026-02-30T09:00:00Z' }, { startDate: '2026-10-02T09:00:00Z', endDate: '2026-10-02T09:00:00Z' }]) {
      // eslint-disable-next-line no-await-in-loop -- each invalid definition must independently leave no task
      await expect(tasks.create(owner, randomUUID(), { ...definition, ...changes })).rejects.toMatchObject({ status: 422 });
    }
    expect(await tasks.list(owner)).toEqual([]);
  });

  it('maps Starts to Scheduler and permits clearing both bounds', async () => {
    const tasks = normal();
    const owner = randomUUID();
    const { task } = await tasks.create(owner, randomUUID(), { ...definition, startDate: '2090-01-01T10:42:00.000Z', endDate: '2090-01-02T10:42:00.000Z' });
    expect(task.nextRun).toBe('2090-01-01T10:42:00.000Z');
    expect(await view.schedule(task.id)).toMatchObject({ StartDate: 3786950520, EndDate: 3787036920 });
    const updated = await tasks.update(owner, task.id, { startDate: null, endDate: null });
    expect(updated).not.toHaveProperty('startDate');
    expect(updated).not.toHaveProperty('endDate');
    expect(updated).toHaveProperty('nextRun');
  });

  it('keeps a task extended after the expiry scan read and before the retirement fence', async () => {
    const tasks = normal();
    const owner = randomUUID();
    const { task } = await tasks.create(owner, randomUUID(), { ...definition, endDate: '2000-01-01T00:00:00.000Z' });
    const delayed = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    const gate = held();
    let first = true;
    delayed.middlewareStack.add((next, context) => async (args) => {
      if (first && context.commandName === 'GetItemCommand') {
        first = false;
        const result = await next(args);
        gate.reach();
        await gate.waiting;
        return result;
      }
      return next(args);
    }, { step: 'initialize' });
    const sweep = new ScheduledTasks(table, runs, delayed, scheduler).retireExpired();
    try {
      await gate.entered;
      await tasks.update(owner, task.id, { endDate: '2099-01-01T00:00:00.000Z' });
      gate.release();
      await sweep;
      expect(await tasks.get(owner, task.id)).toMatchObject({ endDate: '2099-01-01T00:00:00.000Z', ended: false });
      expect(await view.schedule(task.id)).toMatchObject({ State: 'ENABLED', EndDate: 4070908800 });
    } finally { gate.release(); await sweep; }
  });

  it('excludes an extension before an expired task calls external Scheduler deletion', async () => {
    const tasks = normal();
    const owner = randomUUID();
    const { task } = await tasks.create(owner, randomUUID(), { ...definition, endDate: '2000-01-01T00:00:00.000Z' });
    const gate = held();
    const delayed = new SchedulerClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    delayed.middlewareStack.add((next, context) => async (args) => {
      if (context.commandName === 'DeleteScheduleCommand') { gate.reach(); await gate.waiting; }
      return next(args);
    }, { step: 'initialize' });
    const sweep = new ScheduledTasks(table, runs, dynamodb, delayed).retireExpired();
    try {
      await gate.entered;
      await expect(tasks.update(owner, task.id, { endDate: '2099-01-01T00:00:00.000Z' })).rejects.toMatchObject({ status: 409 });
      expect(await view.schedule(task.id)).toMatchObject({ State: 'DISABLED' });
      gate.release();
      await sweep;
      expect(await tasks.get(owner, task.id)).toBeNull();
    } finally { gate.release(); await sweep; }
  });

  it.each(['manual', 'expiry'] as const)('shares a terminal delete across concurrent %s retirement workers and releases capacity once', async (second) => {
    const owner = randomUUID();
    const tasks = normal();
    const { task } = await tasks.create(owner, randomUUID(), { ...definition, endDate: '2000-01-01T00:00:00.000Z' });
    const delayed = new SchedulerClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    const gate = held();
    let first = true;
    delayed.middlewareStack.add((next, context) => async (args) => {
      if (first && context.commandName === 'DeleteScheduleCommand') {
        first = false;
        gate.reach();
        await gate.waiting;
      }
      return next(args);
    }, { step: 'initialize' });
    const worker = new ScheduledTasks(table, runs, dynamodb, delayed);
    const sweep = worker.retireExpired();
    try {
      await gate.entered;
      const intent = (await raw(owner, task.id))?.mutation;
      expect(intent).toMatchObject({ kind: 'retire' });
      if (second === 'manual') expect(await worker.delete(owner, task.id)).toBe(true);
      else await worker.retireExpired();
      gate.release();
      await sweep;
      expect(await tasks.get(owner, task.id)).toBeNull();
      expect(await view.schedule(task.id)).toBeNull();
      const { Item } = await DynamoDBDocumentClient.from(dynamodb).send(new GetCommand({ TableName: table, Key: { pk: `SCHEDULED#${owner}`, sk: 'COUNT' } }));
      expect(Item?.tasks).toBe(0);
    } finally { gate.release(); await sweep; }
  });

  it('does not treat a new delete token as a replay of an earlier successful deletion', async () => {
    const owner = randomUUID();
    const { task } = await normal().create(owner, randomUUID(), definition);
    const input = { Name: task.id, GroupName: runs.group, ClientToken: randomUUID() };
    await scheduler.send(new DeleteScheduleCommand(input));
    await scheduler.send(new DeleteScheduleCommand(input));
    await expect(scheduler.send(new DeleteScheduleCommand({ ...input, Name: randomUUID() }))).rejects.toMatchObject({ name: 'ConflictException' });
    await expect(scheduler.send(new DeleteScheduleCommand({ ...input, ClientToken: randomUUID() }))).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
    await expect(normal().delete(owner, task.id)).rejects.toMatchObject({ status: 404 });
    expect(await normal().get(owner, task.id)).toBeNull();
  });

  it.each(['startDate', 'endDate'] as const)('rejects %s on a one-off at domain create and update boundaries', async (field) => {
    const owner = randomUUID();
    const tasks = normal();
    const oneOff = { ...definition, schedule: 'at(2090-01-01T12:00:00)' };
    const bounds = { [field]: '2090-01-01T10:00:00Z' };
    await expect(tasks.create(owner, randomUUID(), { ...oneOff, ...bounds })).rejects.toMatchObject({ status: 422 });
    const { task } = await tasks.create(owner, randomUUID(), oneOff);
    await expect(tasks.update(owner, task.id, bounds)).rejects.toMatchObject({ status: 422 });
    expect(await tasks.get(owner, task.id)).toEqual(task);
  });

  it('retains an uncertain update fence and recovers its saved intent only after writers stop', async () => {
    const tasks = normal();
    const owner = randomUUID();
    const { task } = await tasks.create(owner, randomUUID(), definition);
    const failure = new Error('Scheduler response lost');
    const lostResponse = new SchedulerClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    lostResponse.middlewareStack.add((next, context) => async (args) => {
      const result = await next(args);
      if (context.commandName === 'UpdateScheduleCommand') throw failure;
      return result;
    }, { step: 'initialize' });
    await expect(new ScheduledTasks(table, runs, dynamodb, lostResponse).update(owner, task.id, { paused: true })).rejects.toBe(failure);
    expect(await raw(owner, task.id)).toMatchObject({ mutation: { kind: 'update', changes: { paused: true } } });
    await expect(tasks.update(owner, task.id, { paused: false })).rejects.toMatchObject({ status: 409 });
    await expect(tasks.delete(owner, task.id)).rejects.toMatchObject({ status: 409 });
    await expect(tasks.transfer(owner, randomUUID())).rejects.toMatchObject({ status: 409 });
    await tasks.recoverMutation(owner, task.id);
    expect(await raw(owner, task.id)).not.toHaveProperty('mutation');
    expect(await tasks.get(owner, task.id)).toMatchObject({ paused: true });
    expect(await view.schedule(task.id)).toMatchObject({ State: 'DISABLED' });
  });

  it('releases a recurring-to-one-off edit fence when the accepted schedule has fired and disappeared', async () => {
    const tasks = normal();
    const owner = randomUUID();
    const { task } = await tasks.create(owner, randomUUID(), definition);
    const failure = new Error('Metadata write unavailable after Scheduler accepted edit');
    const delayed = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    let failed = false;
    delayed.middlewareStack.add((next, context) => async (args) => {
      if (!failed && context.commandName === 'TransactWriteItemsCommand') { failed = true; throw failure; }
      return next(args);
    }, { step: 'initialize' });
    const schedule = 'at(2090-01-01T12:00:00)';
    await expect(new ScheduledTasks(table, runs, delayed, scheduler).update(owner, task.id, { schedule })).rejects.toBe(failure);
    expect(await raw(owner, task.id)).toMatchObject({ mutation: { kind: 'update', changes: { schedule } } });
    await scheduler.send(new DeleteScheduleCommand({ Name: task.id, GroupName: runs.group }));
    await expect(tasks.recoverMutation(owner, task.id)).rejects.toMatchObject({ status: 409, detail: 'The schedule is unavailable; the task update could not be confirmed' });
    expect(await raw(owner, task.id)).not.toHaveProperty('mutation');
    expect(await tasks.get(owner, task.id)).toMatchObject({ schedule: definition.schedule });
    await expect(tasks.delete(owner, task.id)).rejects.toMatchObject({ status: 404 });
    expect(await tasks.delete(owner, task.id)).toBe(false);
    expect(await tasks.get(owner, task.id)).toBeNull();
  });

  it('refuses a never-accepted one-off conversion when the original schedule is missing', async () => {
    const tasks = normal();
    const owner = randomUUID();
    const { task } = await tasks.create(owner, randomUUID(), definition);
    await scheduler.send(new DeleteScheduleCommand({ Name: task.id, GroupName: runs.group }));
    await expect(tasks.update(owner, task.id, { schedule: 'at(2090-01-01T12:00:00)' })).rejects.toMatchObject({ status: 409 });
    expect(await raw(owner, task.id)).not.toHaveProperty('mutation');
    expect(await tasks.get(owner, task.id)).toMatchObject({ schedule: definition.schedule });
    await expect(tasks.delete(owner, task.id)).rejects.toMatchObject({ status: 404 });
    expect(await tasks.delete(owner, task.id)).toBe(false);
  });

  it('recovers a transfer whose Scheduler response was lost without releasing capacity twice', async () => {
    const tasks = normal();
    const owner = randomUUID();
    const destination = randomUUID();
    const { task } = await tasks.create(owner, randomUUID(), definition);
    const failure = new Error('Transfer response lost');
    const lostResponse = new SchedulerClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    lostResponse.middlewareStack.add((next, context) => async (args) => {
      const result = await next(args);
      if (context.commandName === 'UpdateScheduleCommand') throw failure;
      return result;
    }, { step: 'initialize' });
    await expect(new ScheduledTasks(table, runs, dynamodb, lostResponse).transfer(owner, destination)).rejects.toBe(failure);
    await tasks.recoverMutation(owner, task.id);
    await tasks.recoverMutation(owner, task.id);
    expect(await tasks.list(owner)).toEqual([]);
    expect(await tasks.get(destination, task.id)).toMatchObject({ id: task.id });
    expect(await view.schedule(task.id)).toMatchObject({ Target: { Input: JSON.stringify({ owner: destination, taskId: task.id }) } });
  });

  it('retains retirement after Scheduler succeeds but metadata fails and completes the same deletion on retry', async () => {
    const tasks = normal();
    const owner = randomUUID();
    const { task } = await tasks.create(owner, randomUUID(), { ...definition, endDate: '2000-01-01T00:00:00.000Z' });
    const failure = new Error('Retirement metadata unavailable');
    const failing = new DynamoDBClient({ ...aws, endpoint: inject('dynamodbEndpoint') });
    failing.middlewareStack.add((next, context) => async (args) => {
      if (context.commandName === 'TransactWriteItemsCommand') throw failure;
      return next(args);
    }, { step: 'initialize' });
    await expect(new ScheduledTasks(table, runs, failing, scheduler).retireExpired()).rejects.toBe(failure);
    expect(await raw(owner, task.id)).toMatchObject({ mutation: { kind: 'retire' } });
    expect(await view.schedule(task.id)).toBeNull();
    await tasks.recoverMutation(owner, task.id);
    expect(await tasks.get(owner, task.id)).toBeNull();
    await tasks.recordRun(owner, task.id, { at: new Date().toISOString(), status: 'done' });
    expect(await tasks.get(owner, task.id)).toBeNull();
  });
});
