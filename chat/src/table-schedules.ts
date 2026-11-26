import { ConditionalCheckFailedException, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, paginateQuery } from '@aws-sdk/lib-dynamodb';
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
  UpdateScheduleCommand,
  ValidationException,
  type CreateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { nextScheduledRun } from './schedule-time.js';
import type { ScheduleCommand, Schedules } from './scheduler.js';
import type { ScheduledRunMessage } from './scheduled-tasks.js';

/** How often the poller reads its due schedules: a run starts at most this late. */
const POLL_MILLISECONDS = 10_000;

const PARTITION = 'SCHEDULES';
const rowKey = (name: string | undefined) => ({ pk: PARTITION, sk: `SCHEDULE#${name}` });
/** Present once the tasks scheduled in EventBridge Scheduler have their rows here. */
const ADOPTED = { pk: PARTITION, sk: 'ADOPTED' };

interface ScheduleRow {
  pk: string;
  sk: string;
  expression: string;
  timezone: string;
  start?: string;
  end?: string;
  /** Deleted once it has fired, as Scheduler's `ActionAfterCompletion: DELETE`. */
  once: boolean;
  /** The run message its fire sends. */
  input: string;
  /** Its next fire; absent while disabled or once it has no more. */
  due?: string;
}

/** An EventBridge Scheduler error's options, as the service sends them: its message in both spellings. */
const failure = (message: string) => ({ $metadata: {}, message, Message: message });

/**
 * Schedules as rows of the chat table, answering ScheduledTasks as EventBridge Scheduler does, and the poller that
 * fires them into the run queue. Each fire is claimed by moving the row's `due` with a conditional write before its
 * run is sent, so a restarted or concurrent poller never sends it twice. A poller that stops between its claim and
 * its send loses that one run: a missed run beats a double one, which repeats a user's prompt.
 */
export class TableSchedules implements Schedules {
  private readonly documents: DynamoDBDocumentClient;
  private adoption: Promise<void> | undefined;

  constructor(
    private readonly tableName: string,
    dynamodb: DynamoDBClient,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    /** The schedules the deployment's tasks hold in EventBridge Scheduler, which the table takes over. */
    private readonly existing: () => Promise<CreateScheduleCommandInput[]>,
  ) {
    this.documents = DynamoDBDocumentClient.from(dynamodb);
  }

  async send(command: ScheduleCommand): Promise<object> {
    await this.adopted();
    if (command instanceof CreateScheduleCommand) await this.put(command.input, 'attribute_not_exists(pk)', () => new ConflictException(failure(`Schedule ${command.input.Name} already exists`)));
    else if (command instanceof UpdateScheduleCommand) await this.put(command.input, 'attribute_exists(pk)', () => notFound(command.input.Name));
    else if (command instanceof DeleteScheduleCommand) await this.delete(command.input.Name);
    else if (command instanceof GetScheduleCommand) await this.get(command.input.Name);
    return {};
  }

  /** Send each run that is due, moving its schedule to its next fire. */
  async tick(): Promise<void> {
    await this.adopted();
    const now = new Date();
    const due: ScheduleRow[] = [];
    const pages = paginateQuery({ client: this.documents }, {
      TableName: this.tableName, ConsistentRead: true,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :schedule)', FilterExpression: '#due <= :now',
      ExpressionAttributeNames: { '#due': 'due' }, ExpressionAttributeValues: { ':pk': PARTITION, ':schedule': 'SCHEDULE#', ':now': now.toISOString() },
    });
    for await (const page of pages) due.push(...(page.Items ?? []) as ScheduleRow[]);
    await Promise.all(due.map(async (row) => {
      const message = { ...JSON.parse(row.input) as ScheduledRunMessage, scheduledAt: row.due };
      if (await this.claim(row, now)) {
        await this.sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(message) }));
      }
    }));
  }

  /** Poll until stopped; a failed poll stops polling and is reported, as a failed run queue receive is. */
  start(onFailure: (error: unknown) => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    const poll = () => {
      void this.tick().then(() => { timer = setTimeout(poll, POLL_MILLISECONDS); }, (error: unknown) => {
        console.error('Scheduled runs stopped: the schedule poll failed', error);
        onFailure(error);
      });
    };
    poll();
    return () => clearTimeout(timer);
  }

  private async claim(row: ScheduleRow, now: Date): Promise<boolean> {
    const following = row.once ? undefined : nextDue(row, now);
    const claimed = { TableName: this.tableName, Key: { pk: row.pk, sk: row.sk }, ConditionExpression: '#due = :due', ExpressionAttributeNames: { '#due': 'due' } };
    try {
      if (row.once) await this.documents.send(new DeleteCommand({ ...claimed, ExpressionAttributeValues: { ':due': row.due } }));
      else if (following === undefined) await this.documents.send(new UpdateCommand({ ...claimed, UpdateExpression: 'REMOVE #due', ExpressionAttributeValues: { ':due': row.due } }));
      else await this.documents.send(new UpdateCommand({ ...claimed, UpdateExpression: 'SET #due = :following', ExpressionAttributeValues: { ':due': row.due, ':following': following } }));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
    return true;
  }

  private async put(input: CreateScheduleCommandInput, condition: string, refusal: () => Error): Promise<void> {
    try {
      await this.documents.send(new PutCommand({ TableName: this.tableName, Item: row(input), ConditionExpression: condition }));
    } catch (error) {
      throw error instanceof ConditionalCheckFailedException ? refusal() : error;
    }
  }

  private async delete(name: string | undefined): Promise<void> {
    try {
      await this.documents.send(new DeleteCommand({ TableName: this.tableName, Key: rowKey(name), ConditionExpression: 'attribute_exists(pk)' }));
    } catch (error) {
      throw error instanceof ConditionalCheckFailedException ? notFound(name) : error;
    }
  }

  private async get(name: string | undefined): Promise<void> {
    const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key: rowKey(name), ConsistentRead: true }));
    if (Item === undefined) throw notFound(name);
  }

  private adopted(): Promise<void> {
    this.adoption ??= this.adopt().catch((error: unknown) => {
      this.adoption = undefined;
      throw error;
    });
    return this.adoption;
  }

  /** Once per table: every task scheduled in EventBridge Scheduler gets its row, unless one was written since. */
  private async adopt(): Promise<void> {
    const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key: ADOPTED, ConsistentRead: true }));
    if (Item !== undefined) return;
    await Promise.all((await this.existing()).map(async (input) => {
      try {
        await this.documents.send(new PutCommand({ TableName: this.tableName, Item: row(input), ConditionExpression: 'attribute_not_exists(pk)' }));
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
    }));
    await this.documents.send(new PutCommand({ TableName: this.tableName, Item: { ...ADOPTED, at: new Date().toISOString() } }));
  }
}

function row(input: CreateScheduleCommandInput): ScheduleRow {
  const { Name, ScheduleExpression, ScheduleExpressionTimezone, StartDate, EndDate, State, ActionAfterCompletion, Target } = input;
  if (ScheduleExpression === undefined || Target?.Input === undefined) throw new ValidationException(failure(`Schedule ${Name} has no expression or target input`));
  const schedule: ScheduleRow = {
    ...rowKey(Name),
    expression: ScheduleExpression,
    timezone: ScheduleExpressionTimezone ?? 'UTC',
    ...(StartDate === undefined ? {} : { start: StartDate.toISOString() }),
    ...(EndDate === undefined ? {} : { end: EndDate.toISOString() }),
    once: ActionAfterCompletion === 'DELETE',
    input: Target.Input,
  };
  let due: string | undefined;
  try {
    due = State === 'DISABLED' ? undefined : nextDue(schedule, new Date());
  } catch (error) {
    throw new ValidationException(failure(error instanceof Error ? error.message : String(error)));
  }
  return due === undefined ? schedule : { ...schedule, due };
}

/** The schedule's first fire after `after`, before its end. */
function nextDue({ expression, timezone, start, end }: ScheduleRow, after: Date): string | undefined {
  const next = nextScheduledRun({ schedule: expression, timezone, createdAt: start ?? after.toISOString(), ...(start === undefined ? {} : { startDate: start }) }, after);
  return next === undefined || (end !== undefined && next.getTime() >= Date.parse(end)) ? undefined : next.toISOString();
}

const notFound = (name: string | undefined) => new ResourceNotFoundException(failure(`Schedule ${name} does not exist`));
