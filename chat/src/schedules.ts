import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { BotCubeConfig } from 'botcube-config';
import { sqsRunQueue, type RunQueue } from './scheduled-runs.js';
import { ScheduledTasks } from './scheduled-tasks.js';
import { schedulerConfigFromEnv } from './scheduler.js';
import { TableSchedules } from './table-schedules.js';

export interface ChatScheduling {
  tasks: ScheduledTasks;
  queue: RunQueue;
  /** The table poller, which fires the schedules itself; absent when EventBridge Scheduler fires them. */
  poll?: TableSchedules;
}

/** Scheduled tasks on the BotCube Config's `schedules` adapter; null under `none`, or while an EventBridge Scheduler deployment has no run queue. */
export function chatScheduling(
  schedules: BotCubeConfig['schedules'],
  env: NodeJS.ProcessEnv,
  table: string,
  clients: { dynamodb?: DynamoDBClient; sqs?: SQSClient; scheduler?: SchedulerClient } = {},
): ChatScheduling | null {
  if (schedules.kind === 'none') return null;
  if (schedules.kind === 'eventbridge-scheduler') {
    const config = schedulerConfigFromEnv(env);
    return config && { tasks: new ScheduledTasks(table, config, clients.dynamodb, clients.scheduler), queue: sqsRunQueue(config.queueUrl, clients.sqs) };
  }
  const queueUrl = env.BOTCUBE_SCHEDULED_RUNS_QUEUE_URL;
  if (!queueUrl) throw new Error('schedules.kind: table-poller needs BOTCUBE_SCHEDULED_RUNS_QUEUE_URL, the run queue it sends due runs to');
  // Stryker disable next-line ObjectLiteral: production's clients, in the region the SDK resolves; tests inject ones pointed at moto
  const { dynamodb = new DynamoDBClient({}), sqs = new SQSClient({}) } = clients;
  const poll: TableSchedules = new TableSchedules(table, dynamodb, sqs, queueUrl, () => tasks.existingSchedules());
  const tasks = new ScheduledTasks(table, { group: 'table-poller', queueUrl }, dynamodb, poll);
  return { tasks, queue: sqsRunQueue(queueUrl, sqs), poll };
}
