import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { expect, it, vi } from 'vitest';
import { createChatTable } from '../test/fakes/stack.js';
import { createScheduledRuns } from '../test/fakes/scheduler.js';
import { ScheduledTasks } from './scheduled-tasks.js';
import { motoAws, motoEndpoint } from '../test/fakes/moto.js';

it('keeps the latest run when an older completed delivery records its outcome again', async () => {
  const endpoint = motoEndpoint();
  const table = `last-run-order-${randomUUID()}`;
  await createChatTable(endpoint, table);
  const runs = await createScheduledRuns(endpoint);
  const aws = motoAws();
  const tasks = new ScheduledTasks(table, runs, new DynamoDBClient(aws), new SchedulerClient(aws));
  const owner = randomUUID();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-30T08:00:00.000Z'));
  try {
    const { task } = await tasks.create(owner, randomUUID(), {
      title: 'Brief', prompt: 'Brief me', schedule: 'rate(1 hour)', timezone: 'UTC',
    });
    const earlier = { at: '2026-10-30T09:00:00.000Z', status: 'done' as const };
    const latest = { at: '2026-10-30T10:00:00.000Z', status: 'failed' as const };
    vi.setSystemTime(new Date(earlier.at));
    await tasks.recordRun(owner, task.id, earlier);
    vi.setSystemTime(new Date(latest.at));
    await tasks.recordRun(owner, task.id, latest);
    expect(await tasks.get(owner, task.id)).toMatchObject({ lastRun: latest });
    vi.setSystemTime(new Date('2026-10-30T10:05:00.000Z'));
    await tasks.recordRun(owner, task.id, earlier);
    expect(await tasks.get(owner, task.id)).toMatchObject({ lastRun: latest });
  } finally {
    vi.useRealTimers();
  }
});
