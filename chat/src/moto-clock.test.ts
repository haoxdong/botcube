import { DescribeTableCommand, DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { GetScheduleGroupCommand, ListScheduleGroupsCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { GetQueueUrlCommand, ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { afterEach, expect, it, vi } from 'vitest';
import { motoAws } from '../test/fakes/moto.js';

const aws = () => (motoAws());

const SLOW_RUNNER_MS = 2_000;
const advancesClockWhileFailing = <A, R>(next: (args: A) => Promise<R>) => async (args: A) => {
  try {
    return await next(args);
  } catch (error) {
    vi.setSystemTime(Date.now() + SLOW_RUNNER_MS);
    throw error;
  }
};
const beforeTheSdkReadsTheError = { step: 'deserialize', priority: 'high' } as const;

function dynamodb() {
  const client = new DynamoDBClient(aws());
  client.middlewareStack.add(advancesClockWhileFailing, beforeTheSdkReadsTheError);
  return { sampleClockOffset: () => client.send(new ListTablesCommand({})), fail: () => client.send(new DescribeTableCommand({ TableName: 'absent' })) };
}

function scheduler() {
  const client = new SchedulerClient(aws());
  client.middlewareStack.add(advancesClockWhileFailing, beforeTheSdkReadsTheError);
  return { sampleClockOffset: () => client.send(new ListScheduleGroupsCommand({})), fail: () => client.send(new GetScheduleGroupCommand({ Name: 'absent' })) };
}

function sqs() {
  const client = new SQSClient(aws());
  client.middlewareStack.add(advancesClockWhileFailing, beforeTheSdkReadsTheError);
  return { sampleClockOffset: () => client.send(new ListQueuesCommand({})), fail: () => client.send(new GetQueueUrlCommand({ QueueName: 'absent' })) };
}

afterEach(() => {
  vi.useRealTimers();
});

it.each([
  ['DynamoDB', dynamodb],
  ['Scheduler', scheduler],
  ['SQS', sqs],
])('a test-built %s client sees each moto error once while the test clock moves', async (_, start) => {
  vi.useFakeTimers({ now: Date.parse('2030-01-01T00:00:00.000Z'), toFake: ['Date'] });
  const { sampleClockOffset, fail } = start();
  await sampleClockOffset();
  await expect(fail()).rejects.toMatchObject({ $metadata: { attempts: 1 } });
});
