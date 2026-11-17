import type {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  GetScheduleGroupCommand,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';

/**
 * Where schedules deliver their runs: the group's schedules send to the queue. EventBridge Scheduler sends to
 * `queueArn` as `roleArn`; the table poller sends to `queueUrl` itself.
 */
export interface SchedulerConfig {
  group: string;
  roleArn?: string;
  queueArn?: string;
  queueUrl: string;
}

export type ScheduleCommand = CreateScheduleCommand | UpdateScheduleCommand | DeleteScheduleCommand | GetScheduleCommand | GetScheduleGroupCommand;

/** What holds the schedules: EventBridge Scheduler, or the table poller's rows, which answer as Scheduler does. */
export interface Schedules {
  send(command: ScheduleCommand): Promise<unknown>;
}

export function schedulerConfigFromEnv(env: NodeJS.ProcessEnv): SchedulerConfig | null {
  const group = env.BOTCUBE_SCHEDULE_GROUP;
  const roleArn = env.BOTCUBE_SCHEDULER_ROLE_ARN;
  const queueArn = env.BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN;
  const queueUrl = env.BOTCUBE_SCHEDULED_RUNS_QUEUE_URL;
  return group && roleArn && queueArn && queueUrl ? { group, roleArn, queueArn, queueUrl } : null;
}
