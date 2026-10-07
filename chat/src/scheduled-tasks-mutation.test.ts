import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SchedulerClient, type UpdateScheduleCommandInput } from '@aws-sdk/client-scheduler';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../../../tests/chat/fakes/stack.js';
import { createScheduledRuns, SchedulerView } from '../../../tests/chat/fakes/scheduler.js';
import { ScheduledTasks } from './scheduled-tasks.js';

const BRIEF = { title: 'Brief', prompt: 'Summarize overnight news', schedule: 'rate(1 day)', timezone: 'America/New_York' };
let dynamodb: DynamoDBClient;
let scheduler: SchedulerClient;
let view: SchedulerView;
let tasks: ScheduledTasks;

beforeEach(async () => {
  const endpoint = inject('dynamodbEndpoint');
  const table = `chat-${Math.random().toString(36).slice(2)}`;
  await createChatTable(endpoint, table);
  const runs = await createScheduledRuns(endpoint);
  const aws = {
    region: 'us-east-1', endpoint,
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  };
  dynamodb = new DynamoDBClient(aws);
  scheduler = new SchedulerClient(aws);
  view = new SchedulerView(endpoint, runs);
  tasks = new ScheduledTasks(table, runs, dynamodb, scheduler);
});

describe('Account Claim at the scheduled-task cap', () => {
  it('keeps an overflow schedule disabled throughout its move', async () => {
    for (let n = 0; n < 10; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- fill the account before claiming the source
      await tasks.create('destination', randomUUID(), BRIEF);
    }
    const { task } = await tasks.create('source', randomUUID(), BRIEF);
    const states: string[] = [];
    scheduler.middlewareStack.add(
      (next, context) => async (args) => {
        const response = await next(args);
        if (context.commandName === 'UpdateScheduleCommand' && (args.input as UpdateScheduleCommandInput).Name === task.id) {
          states.push((await view.schedule(task.id))?.State ?? 'missing');
        }
        return response;
      },
      { step: 'initialize' },
    );

    await tasks.transfer('source', 'destination');

    expect(states).toEqual(['DISABLED']);
    expect(await tasks.list('source')).toEqual([]);
    expect(await tasks.get('destination', task.id)).toEqual({ ...task, paused: true });
    expect(await view.schedule(task.id)).toMatchObject({
      State: 'DISABLED', Target: { Input: JSON.stringify({ owner: 'destination', taskId: task.id }) },
    });
  });

  it('propagates a storage outage during a move and leaves ownership at the source', async () => {
    const { task } = await tasks.create('source', randomUUID(), BRIEF);
    const outage = new Error('DynamoDB is unavailable');
    dynamodb.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === 'TransactWriteItemsCommand') throw outage;
        return next(args);
      },
      { step: 'initialize' },
    );

    await expect(tasks.transfer('source', 'destination')).rejects.toBe(outage);
    expect(await tasks.list('source')).toEqual([task]);
    expect(await tasks.list('destination')).toEqual([]);
  });
});
