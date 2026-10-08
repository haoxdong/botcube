import { AWS_ACCESS_KEY_ID } from './credentials.js';

/** The EventBridge Scheduler schedule group and SQS queue of scheduled runs, in the suite's moto. */
export interface ScheduledRuns {
  readonly group: string;
  readonly queueArn: string;
  readonly queueUrl: string;
  readonly roleArn: string;
}

/** A moto request: moto accepts any signature from the suite's access key. */
const authorization = (service: string) =>
  `AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY_ID}/20260101/us-east-1/${service}/aws4_request, SignedHeaders=host, Signature=0`;

async function sqs(endpoint: string, action: string, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': `AmazonSQS.${action}`,
      authorization: authorization('sqs'),
    },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) throw new Error(`SQS ${action}: ${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

async function scheduler(endpoint: string, method: string, path: string, body?: object): Promise<Response> {
  return fetch(`${endpoint}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: authorization('scheduler') },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Create a schedule group and a run queue of their own for one stack. */
export async function createScheduledRuns(endpoint: string): Promise<ScheduledRuns> {
  const name = `scheduled-runs-${Math.random().toString(36).slice(2)}`;
  const created = await scheduler(endpoint, 'POST', `/schedule-groups/${name}`, {});
  if (created.status !== 200) throw new Error(`CreateScheduleGroup: ${created.status} ${await created.text()}`);
  const { QueueUrl } = (await sqs(endpoint, 'CreateQueue', { QueueName: name })) as { QueueUrl: string };
  return {
    group: name,
    queueArn: `arn:aws:sqs:us-east-1:123456789012:${name}`,
    queueUrl: QueueUrl,
    roleArn: 'arn:aws:iam::123456789012:role/scheduled-runs',
  };
}

/** One schedule as EventBridge Scheduler holds it. */
export interface Schedule {
  Name: string;
  GroupName: string;
  ScheduleExpression: string;
  ScheduleExpressionTimezone?: string;
  StartDate?: number | null;
  State: 'ENABLED' | 'DISABLED';
  Target: { Arn: string; RoleArn: string; Input: string };
}

/** The scheduled runs as a test sees them: the schedules, and firing one as Scheduler would. */
export class SchedulerView {
  constructor(
    private readonly endpoint: string,
    readonly runs: ScheduledRuns
  ) {}

  /** The schedule, or null when Scheduler has none by that name. */
  async schedule(name: string): Promise<Schedule | null> {
    const response = await scheduler(this.endpoint, 'GET', `/schedules/${name}?groupName=${this.runs.group}`);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`GetSchedule: ${response.status} ${await response.text()}`);
    return (await response.json()) as Schedule;
  }

  /** Deliver the schedule's target input to its queue, as Scheduler does when the schedule is due. */
  async fire(name: string): Promise<void> {
    const schedule = await this.schedule(name);
    if (schedule === null) throw new Error(`No schedule ${name}`);
    await this.deliver(schedule.Target.Input);
  }

  /** How many runs the queue holds, delivered or not. */
  async queued(): Promise<number> {
    const { Attributes } = (await sqs(this.endpoint, 'GetQueueAttributes', {
      QueueUrl: this.runs.queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    })) as { Attributes: Record<string, string> };
    return Number(Attributes.ApproximateNumberOfMessages) + Number(Attributes.ApproximateNumberOfMessagesNotVisible);
  }

  /** Send a run to the queue as a schedule would, whether or not the schedule still exists. */
  async deliver(input: string): Promise<void> {
    await sqs(this.endpoint, 'SendMessage', { QueueUrl: this.runs.queueUrl, MessageBody: input });
  }
}
