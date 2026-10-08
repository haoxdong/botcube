import { positiveInteger } from './config.js';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, type TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  paginateQuery,
} from '@aws-sdk/lib-dynamodb';
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  GetScheduleGroupCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
  ValidationException,
} from '@aws-sdk/client-scheduler';
import { HttpError } from './cartridge.js';

/** The most tasks one account may schedule, so costs stay bounded until there is data. */
const SCHEDULED_TASK_CAP = positiveInteger(process.env, 'BOTCUBE_SCHEDULED_TASK_CAP', 10);

/** What the user confirmed: the agent's proposal, in the user's timezone. */
export interface ScheduledTaskDefinition {
  title: string;
  prompt: string;
  /** An EventBridge Scheduler expression: `cron(...)`, `rate(...)`, or `at(...)`. */
  schedule: string;
  /** The IANA timezone the schedule is read in. */
  timezone: string;
  /** The model key each run uses; absent, runs use the account's default model. */
  model?: string;
}

/** A task the agent runs on its schedule, each run in a fresh Side Chat. */
export interface ScheduledTask extends ScheduledTaskDefinition {
  id: string;
  paused: boolean;
  /** The proposal's tool call, so a chat can tell its proposal is already confirmed. */
  proposalId: string;
}

/** The message a schedule delivers to the run queue when it is due. */
export interface ScheduledRunMessage {
  owner: string;
  taskId: string;
}

/** Where schedules deliver their runs: SCHEDULE_GROUP's schedules send to the queue as the role. */
export interface SchedulerConfig {
  group: string;
  roleArn: string;
  queueArn: string;
  queueUrl: string;
}

export function schedulerConfigFromEnv(env: NodeJS.ProcessEnv): SchedulerConfig | null {
  const group = env.BOTCUBE_SCHEDULE_GROUP;
  const roleArn = env.BOTCUBE_SCHEDULER_ROLE_ARN;
  const queueArn = env.BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN;
  const queueUrl = env.BOTCUBE_SCHEDULED_RUNS_QUEUE_URL;
  return group && roleArn && queueArn && queueUrl ? { group, roleArn, queueArn, queueUrl } : null;
}

const ownerPk = (owner: string) => `SCHEDULED#${owner}`;
const taskKey = (owner: string, id: string) => ({ pk: ownerPk(owner), sk: `TASK#${id}` });
const countKey = (owner: string) => ({ pk: ownerPk(owner), sk: 'COUNT' });
/** The confirmed proposal, so confirming it again answers the task it made. */
const proposalKey = (owner: string, proposalId: string) => ({ pk: ownerPk(owner), sk: `PROPOSAL#${proposalId}` });

type TaskItem = Omit<ScheduledTask, 'proposalId'> & { pk: string; sk: string; created_at: string; proposal_id: string; pending_creation?: boolean; creation_refused?: boolean; schedule_group?: string };

const task = ({ id, title, prompt, schedule, timezone, model, paused, proposal_id }: TaskItem): ScheduledTask => ({
  id,
  title,
  prompt,
  schedule,
  timezone,
  ...(model === undefined ? {} : { model }),
  paused,
  proposalId: proposal_id,
});

const cancelledOn = (error: unknown, index: number) =>
  (error as Partial<TransactionCanceledException>).CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';

/**
 * Scheduled tasks, stored per account in the chat table beside a count that
 * holds the cap, each with an EventBridge Scheduler schedule of the same ID.
 */
export class ScheduledTasks {
  private readonly documents: DynamoDBDocumentClient;
  private readonly scheduler: SchedulerClient;

  constructor(
    private readonly tableName: string,
    private readonly config: SchedulerConfig,
    // Stryker disable next-line ObjectLiteral: production's clients; tests inject ones pointed at moto
    dynamodb = new DynamoDBClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' }),
    // Stryker disable next-line ObjectLiteral: production's clients; tests inject ones pointed at moto
    scheduler = new SchedulerClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' }),
  ) {
    this.documents = DynamoDBDocumentClient.from(dynamodb);
    this.scheduler = scheduler;
  }

  async list(owner: string): Promise<ScheduledTask[]> {
    const items: TaskItem[] = [];
    const pages = paginateQuery(
      { client: this.documents },
      {
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :task)',
        ExpressionAttributeValues: { ':pk': ownerPk(owner), ':task': 'TASK#' },
        // Stryker disable next-line BooleanLiteral: moto reads are always consistent; DynamoDB's strong read lists a task just confirmed
        ConsistentRead: true,
      },
    );
    for await (const page of pages) items.push(...(page.Items as TaskItem[]));
    return items.sort((a, b) => a.created_at.localeCompare(b.created_at)).map(task);
  }

  async get(owner: string, id: string): Promise<ScheduledTask | null> {
    const item = await this.taskItem(owner, id);
    return item === undefined ? null : task(item);
  }

  private async taskItem(owner: string, id: string): Promise<TaskItem | undefined> {
    const { Item } = await this.documents.send(
      // Stryker disable next-line BooleanLiteral: moto reads are always consistent; DynamoDB's strong read finds a task just confirmed
      new GetCommand({ TableName: this.tableName, Key: taskKey(owner, id), ConsistentRead: true }),
    );
    return Item as TaskItem | undefined;
  }

  /**
   * Store the task within the account's cap, then schedule it; a refused schedule stores nothing.
   * A proposal confirmed again answers the task it already made, which `created` tells apart.
   */
  async create(
    owner: string,
    proposalId: string,
    definition: ScheduledTaskDefinition,
  ): Promise<{ task: ScheduledTask; created: boolean }> {
    const group = this.config.group;
    const id = randomUUID();
    const item: TaskItem = {
      ...taskKey(owner, id),
      id,
      ...definition,
      paused: false,
      created_at: new Date().toISOString(),
      proposal_id: proposalId,
      pending_creation: true,
      schedule_group: group,
    };
    try {
      await this.documents.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: countKey(owner),
                UpdateExpression: 'ADD tasks :one',
                ConditionExpression: 'attribute_not_exists(tasks) OR tasks < :cap',
                ExpressionAttributeValues: { ':one': 1, ':cap': SCHEDULED_TASK_CAP },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { ...proposalKey(owner, proposalId), task_id: id },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            { Put: { TableName: this.tableName, Item: item } },
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: `SESSIONS#${owner}`, sk: 'DELETED' },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (cancelledOn(error, 3)) throw new HttpError(410, 'The account history was deleted');
      if (cancelledOn(error, 1)) return this.confirmExistingProposal(owner, proposalId, definition);
      if (cancelledOn(error, 0)) {
        throw new HttpError(409, `An account can schedule at most ${SCHEDULED_TASK_CAP} tasks`);
      }
      throw error;
    }
    const created = task(item);
    try {
      await this.scheduler.send(new CreateScheduleCommand(this.schedule(owner, item, group)));
    } catch (error) {
      await this.rollbackCreation(owner, id, proposalId, error);
      throw schedulerRefusal(error);
    }
    await this.completeCreation(owner, item);
    return { task: created, created: true };
  }

  /** Record a definite refusal and attempt rollback, retaining every recovery failure. */
  private async rollbackCreation(owner: string, id: string, proposalId: string, error: unknown): Promise<void> {
    const failures: unknown[] = [error];
    if (error instanceof ValidationException) {
      try {
        // A definite refusal cannot create a schedule. Retain that fact if rollback fails.
        await this.documents.send(new UpdateCommand({
          TableName: this.tableName, Key: taskKey(owner, id),
          UpdateExpression: 'SET creation_refused = :refused',
          ExpressionAttributeValues: { ':refused': true },
          ConditionExpression: 'attribute_exists(pk)',
        }));
      } catch (markerFailure) {
        failures.push(markerFailure);
      }
    }
    try {
      await this.remove(owner, id, proposalId);
    } catch (cleanupFailure) {
      failures.push(cleanupFailure);
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Scheduled task creation recovery failed');
  }

  /** Persist accepted creation and honor an account deletion that raced Scheduler. */
  private async completeCreation(owner: string, item: TaskItem): Promise<void> {
    const { id, proposal_id: proposalId } = item;
    // Record completion before allowing missing-schedule cleanup to release the durable obligation.
    await this.documents.send(new UpdateCommand({
      TableName: this.tableName, Key: taskKey(owner, id),
      UpdateExpression: 'SET pending_creation = :complete',
      ExpressionAttributeValues: { ':complete': false },
      ConditionExpression: 'attribute_exists(pk)',
    }));
    // Scheduler is outside the transaction: deletion can fence the owner while its create is in flight.
    const { Item: deleted } = await this.documents.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `SESSIONS#${owner}`, sk: 'DELETED' },
      ConsistentRead: true,
    }));
    if (deleted !== undefined) {
      // Schedule first, as in account deletion. A failed cleanup leaves the task available for deletion retry.
      await this.removeScheduledTask(owner, id, proposalId, item.schedule_group ?? this.config.group, true);
      throw new HttpError(410, 'The account history was deleted');
    }
  }

  /** Resolve an existing confirmation, recovering only a durably refused attempt. */
  private async confirmExistingProposal(owner: string, proposalId: string, definition: ScheduledTaskDefinition): Promise<{ task: ScheduledTask; created: boolean }> {
    const { Item } = await this.documents.send(
      // Stryker disable next-line BooleanLiteral: moto reads are always consistent; DynamoDB's strong read finds a proposal just confirmed
      new GetCommand({ TableName: this.tableName, Key: proposalKey(owner, proposalId), ConsistentRead: true }),
    );
    const found = Item === undefined ? undefined : await this.taskItem(owner, (Item as { task_id: string }).task_id);
    // The proposal and its task are written and deleted together, so one without the other is corrupt state.
    if (found === undefined) throw new Error(`Scheduled task proposal ${proposalId} has no task`);
    if (found.creation_refused === true) {
      // Only an explicit confirmation retries a durable, definite refusal.
      await this.remove(owner, found.id, proposalId);
      return this.create(owner, proposalId, definition);
    }
    if (found.pending_creation === true) {
      try {
        await this.scheduler.send(new GetScheduleCommand({ Name: found.id, GroupName: found.schedule_group ?? this.config.group }));
      } catch (error) {
        if (!(error instanceof ResourceNotFoundException)) throw error;
        // A missing schedule is an honest pending-state probe, not a completed confirmation.
        const pending = new HttpError(409, 'Scheduled task confirmation is still pending; try again');
        pending.cause = error;
        throw pending;
      }
      await this.completeCreation(owner, found);
    }
    return { task: task(found), created: false };
  }

  /** Change the task's definition or pause it; its schedule changes to match. Null when there is no such task. */
  async update(
    owner: string,
    id: string,
    changes: Partial<ScheduledTaskDefinition> & { paused?: boolean },
  ): Promise<ScheduledTask | null> {
    const item = await this.taskItem(owner, id);
    if (item === undefined) return null;
    // An Account Claim can leave the account over the cap with the overflow paused: none resumes until it is back under.
    if (item.paused && changes.paused === false && (await this.count(owner)) > SCHEDULED_TASK_CAP) {
      throw new HttpError(409, `An account can schedule at most ${SCHEDULED_TASK_CAP} tasks: delete one to resume another`);
    }
    const updated: TaskItem = { ...item, ...changes };
    if (changes.schedule !== undefined || changes.timezone !== undefined || changes.paused !== undefined) {
      try {
        await this.scheduler.send(new UpdateScheduleCommand(this.schedule(owner, updated)));
      } catch (error) {
        throw schedulerRefusal(error);
      }
    }
    const entries = Object.entries(changes);
    const taskCondition = {
      TableName: this.tableName,
      Key: taskKey(owner, id),
      ConditionExpression: 'attribute_exists(pk)',
    };
    try {
      await this.documents.send(new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: this.tableName,
              Key: { pk: `SESSIONS#${owner}`, sk: 'DELETED' },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          entries.length === 0 ? { ConditionCheck: taskCondition } : {
            Update: {
              ...taskCondition,
              UpdateExpression: `SET ${entries.map((_, index) => `#field${index} = :value${index}`).join(', ')}`,
              ExpressionAttributeNames: Object.fromEntries(entries.map(([name], index) => [`#field${index}`, name])),
              ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], index) => [`:value${index}`, value])),
            },
          },
        ],
      }));
    } catch (error) {
      if (cancelledOn(error, 0)) throw new HttpError(410, 'The account history was deleted');
      if (cancelledOn(error, 1)) return null;
      throw error;
    }
    return this.get(owner, id);
  }

  /** Delete the task's schedule, then the task; false when there is no such task. */
  async delete(owner: string, id: string): Promise<boolean> {
    const item = await this.taskItem(owner, id);
    if (item === undefined) return false;
    try {
      return await this.removeScheduledTask(owner, id, item.proposal_id, item.schedule_group ?? this.config.group, item.pending_creation === false && item.schedule_group !== undefined);
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
      if (item.schedule_group === undefined) {
        const failure = new HttpError(502, 'Scheduled task schedule group is unknown');
        failure.cause = error;
        throw failure;
      }
      if (item.pending_creation !== false) throw error;
      const failure = new HttpError(404, 'Scheduled task schedule not found');
      failure.cause = error;
      throw failure;
    }
  }

  /** Account deletion: every task goes, schedule first. */
  async deleteAll(owner: string): Promise<void> {
    for (const { id } of await this.list(owner)) {
      // eslint-disable-next-line no-await-in-loop -- one task at a time: a retried deletion removes what is left
      await this.delete(owner, id);
    }
  }

  /** How many tasks the account holds, paused ones included. */
  private async count(owner: string): Promise<number> {
    const { Item } = await this.documents.send(
      // Stryker disable next-line BooleanLiteral: moto reads are always consistent; DynamoDB's strong read counts a task just confirmed
      new GetCommand({ TableName: this.tableName, Key: countKey(owner), ConsistentRead: true }),
    );
    return (Item?.tasks as number | undefined) ?? 0;
  }

  /**
   * Account Claim: every task moves to the destination account, its schedule first
   * so it runs as that account; a retried claim moves what is left. None is lost to the cap:
   * each one past it arrives paused (ADR 0030: no task is silently dropped).
   */
  async transfer(source: string, destination: string): Promise<void> {
    const { Items } = await this.documents.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :task)',
        ExpressionAttributeValues: { ':pk': ownerPk(source), ':task': 'TASK#' },
        // Stryker disable next-line BooleanLiteral: moto reads are always consistent; DynamoDB's strong read moves a task just confirmed
        ConsistentRead: true,
      }),
    );
    let held = await this.count(destination);
    const moving = (Items as TaskItem[]).sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const found of moving) {
      held += 1;
      const item = { ...found, paused: found.paused || held > SCHEDULED_TASK_CAP };
      // eslint-disable-next-line no-await-in-loop -- one task at a time
      if (!(await this.move(source, destination, item))) {
        // A task confirmed on the destination meanwhile took the last place: this one arrives paused.
        // eslint-disable-next-line no-await-in-loop -- one task at a time
        await this.move(source, destination, { ...item, paused: true });
      }
    }
  }

  /**
   * Move one task, its schedule first; an active one lands only while a place under
   * the cap is free. Whether it landed: false when the cap refused it.
   */
  private async move(source: string, destination: string, item: TaskItem): Promise<boolean> {
    await this.scheduler.send(new UpdateScheduleCommand(this.schedule(destination, item)));
    const destinationCount = {
      Update: {
        TableName: this.tableName,
        Key: countKey(destination),
        UpdateExpression: 'ADD tasks :one',
        ...(item.paused
          ? { ExpressionAttributeValues: { ':one': 1 } }
          : {
              ConditionExpression: 'attribute_not_exists(tasks) OR tasks < :cap',
              ExpressionAttributeValues: { ':one': 1, ':cap': SCHEDULED_TASK_CAP },
            }),
      },
    };
    const transactItems = [
      { Put: { TableName: this.tableName, Item: { ...item, ...taskKey(destination, item.id) } } },
      {
        Put: {
          TableName: this.tableName,
          Item: { ...proposalKey(destination, item.proposal_id), task_id: item.id },
        },
      },
      { Delete: { TableName: this.tableName, Key: proposalKey(source, item.proposal_id) } },
      destinationCount,
      { Delete: { TableName: this.tableName, Key: taskKey(source, item.id) } },
      {
        Update: {
          TableName: this.tableName,
          Key: countKey(source),
          UpdateExpression: 'ADD tasks :minus',
          ExpressionAttributeValues: { ':minus': -1 },
        },
      },
    ];
    try {
      // The schedule runs as the destination before the task moves there.
      await this.documents.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (error) {
      if (cancelledOn(error, transactItems.indexOf(destinationCount))) return false;
      throw error;
    }
    return true;
  }

  private async removeScheduledTask(owner: string, id: string, proposalId: string, group: string, creationComplete: boolean): Promise<boolean> {
    try {
      await this.scheduler.send(new DeleteScheduleCommand({ Name: id, GroupName: group }));
    } catch (error) {
      // An admitted create may still produce a schedule: only durable completion permits metadata repair.
      if (!(error instanceof ResourceNotFoundException) || !creationComplete) throw error;
      // DeleteSchedule's 404 can name the group, not this task: verify its recorded group before durable cleanup.
      // https://docs.aws.amazon.com/scheduler/latest/APIReference/API_DeleteSchedule.html
      try {
        await this.scheduler.send(new GetScheduleGroupCommand({ Name: group }));
      } catch (groupError) {
        if (groupError instanceof ResourceNotFoundException) {
          const failure = new HttpError(502, 'Scheduled task schedule group not found');
          failure.cause = groupError;
          throw failure;
        }
        throw groupError;
      }
      try {
        await this.remove(owner, id, proposalId);
      } catch (repairFailure) {
        throw new AggregateError([error, repairFailure], 'Schedule absence and task metadata cleanup failed');
      }
      // Repair retains the observed SDK failure; the next deletion retry sees the erased task.
      throw error;
    }
    return this.remove(owner, id, proposalId);
  }

  private async remove(owner: string, id: string, proposalId: string): Promise<boolean> {
    try {
      await this.documents.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.tableName, Key: taskKey(owner, id), ConditionExpression: 'attribute_exists(pk)' } },
          { Delete: { TableName: this.tableName, Key: proposalKey(owner, proposalId) } },
          {
            Update: {
              TableName: this.tableName,
              Key: countKey(owner),
              UpdateExpression: 'ADD tasks :minus',
              ExpressionAttributeValues: { ':minus': -1 },
            },
          },
        ],
      }),
      );
      return true;
    } catch (error) {
      if (cancelledOn(error, 0)) return false;
      throw error;
    }
  }

  private schedule(owner: string, { id, schedule, timezone, paused, created_at }: TaskItem, group = this.config.group) {
    const message: ScheduledRunMessage = { owner, taskId: id };
    const rate = /^rate\(\s*([1-9]\d*)\s+(minute|hour|day)s?\s*\)$/.exec(schedule);
    let startDate: Date | undefined;
    if (rate !== null) {
      const units = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
      const period = Number(rate[1]) * units[rate[2] as keyof typeof units];
      const anchor = new Date(created_at).getTime();
      const tick = Math.max(1, Math.floor((Date.now() - anchor) / period) + 1);
      startDate = new Date(anchor + tick * period);
    }
    return {
      Name: id,
      GroupName: group,
      ScheduleExpression: schedule,
      ScheduleExpressionTimezone: timezone,
      ...(startDate === undefined ? {} : { StartDate: startDate }),
      State: paused ? ('DISABLED' as const) : ('ENABLED' as const),
      FlexibleTimeWindow: { Mode: 'OFF' as const },
      Target: { Arn: this.config.queueArn, RoleArn: this.config.roleArn, Input: JSON.stringify(message) },
    };
  }
}

/** Scheduler's refusal of an expression or timezone is the user's 400; anything else propagates. */
function schedulerRefusal(error: unknown): unknown {
  return error instanceof ValidationException ? new HttpError(400, error.message) : error;
}
