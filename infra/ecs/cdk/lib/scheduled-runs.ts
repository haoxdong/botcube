import { Duration, type Stack } from 'aws-cdk-lib';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { optionalPhysicalName } from './physical-name.js';

/** The Chat Service's settings for its scheduled runs' queue and schedules. */
export interface ScheduledRunsProps {
  clusterName: string;
  scheduledRunsQueue?: sqs.IQueue;
  /** The Deployment Config's `schedules` adapter: EventBridge Scheduler (the default), or the Chat Service polling its table. */
  schedules?: 'eventbridge-scheduler' | 'table-poller';
  scheduledRunsQueueName?: string;
  scheduledRunsFailedQueueName?: string;
  scheduledRunsRoleName?: string;
  scheduleGroupName?: string;
  scheduledRunVisibilitySeconds?: number;
  scheduledRunRetentionDays?: number;
  scheduledRunMaxReceiveCount?: number;
}

/** Scheduled tasks: each task's schedule sends its run to a queue the Chat Service polls. */
export function addScheduledRuns(scope: Construct, origin: Stack, task: ecs.FargateTaskDefinition, container: ecs.ContainerDefinition, props: ScheduledRunsProps): void {
  const runs = props.scheduledRunsQueue ?? new sqs.Queue(scope, 'ScheduledRuns', {
    ...optionalPhysicalName('queueName', props.scheduledRunsQueueName),
    // Longer than a run's stream, so a run in progress is not delivered twice.
    visibilityTimeout: Duration.seconds(props.scheduledRunVisibilitySeconds ?? 900),
    retentionPeriod: Duration.days(props.scheduledRunRetentionDays ?? 14),
    deadLetterQueue: { queue: new sqs.Queue(scope, 'ScheduledRunsFailed', { ...optionalPhysicalName('queueName', props.scheduledRunsFailedQueueName), retentionPeriod: Duration.days(props.scheduledRunRetentionDays ?? 14) }), maxReceiveCount: props.scheduledRunMaxReceiveCount ?? 3 },
  });
  runs.grantConsumeMessages(task.taskRole);
  if (props.schedules === 'table-poller') runs.grantSendMessages(task.taskRole);
  else scheduleWithEventBridge(scope, origin, task, container, runs, props);
  container.addEnvironment('BOTCUBE_SCHEDULED_RUNS_QUEUE_URL', runs.queueUrl);
}

/**
 * EventBridge Scheduler sends each schedule's run to the queue, since it cannot call the Chat Service directly.
 * Moving to the table poller removes the group, and deleting a group deletes its schedules, so none fires twice.
 */
function scheduleWithEventBridge(scope: Construct, origin: Stack, task: ecs.FargateTaskDefinition, container: ecs.ContainerDefinition, runs: sqs.IQueue, props: ScheduledRunsProps): void {
  const scheduleGroup = props.scheduleGroupName ?? `${props.clusterName}-scheduled-tasks`;
  new scheduler.CfnScheduleGroup(scope, 'ScheduledTasks', { name: scheduleGroup });
  const runsRole = new iam.Role(scope, 'ScheduledRunsRole', { ...optionalPhysicalName('roleName', props.scheduledRunsRoleName), assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com') });
  runs.grantSendMessages(runsRole);
  task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
    resources: [origin.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: `${scheduleGroup}/*` })],
  }));
  task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['scheduler:GetScheduleGroup'],
    resources: [origin.formatArn({ service: 'scheduler', resource: 'schedule-group', resourceName: scheduleGroup })],
  }));
  runsRole.grantPassRole(task.taskRole);
  container.addEnvironment('BOTCUBE_SCHEDULE_GROUP', scheduleGroup);
  container.addEnvironment('BOTCUBE_SCHEDULER_ROLE_ARN', runsRole.roleArn);
  container.addEnvironment('BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN', runs.queueArn);
}
