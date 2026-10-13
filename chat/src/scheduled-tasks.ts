import { positiveInteger } from './config.js';
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient, type TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
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
import { isScheduledInstant, nextRateTick, nextScheduledRun } from './schedule-time.js';
import { HttpError } from './cartridge.js';
import type { ScheduledRunCard } from './session-api.js';

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
  /** The stop time, an ISO instant: Scheduler's `EndDate`, after which the schedule no longer runs. */
  endDate?: string;
  /** The first eligible instant. For rate schedules this sets the cadence anchor. */
  startDate?: string;
}

/** Definition edits, nullable time bounds, and pause state. */
export type TaskChanges = Partial<Omit<ScheduledTaskDefinition, 'startDate' | 'endDate'>> & { startDate?: string | null; endDate?: string | null; paused?: boolean };

/** Whether a schedule runs once: Scheduler's `at(...)`. */
const once = (schedule: string) => schedule.startsWith('at(');

/** The clock a time zone shows at an instant, read as if it were UTC. */
const shownAsUtc = (at: number, timeZone: string) =>
  Date.parse(`${new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'medium' }).format(at).replace(' ', 'T')}Z`);

/** Whether a one-off's time, `at(...)` in its time zone, has come. */
function due({ schedule, timezone }: { schedule: string; timezone: string }): boolean {
  const wall = Date.parse(`${/^at\((.+)\)$/.exec(schedule)?.[1] ?? ''}Z`);
  if (Number.isNaN(wall)) throw new Error(`Scheduled task schedule ${schedule} has no readable time`);
  return wall - (shownAsUtc(wall, timezone) - wall) <= Date.now();
}

/** Whether a one-off has fired: Scheduler has delivered its one run and deleted its schedule (`ActionAfterCompletion: DELETE`). */
export const fired = (task: { schedule: string; timezone: string }) => once(task.schedule) && due(task);

/** How a task's latest run ended: Done, Failed, or Needs sign-in in its sheet. */
export interface ScheduledTaskRun {
  at: string;
  status: Exclude<ScheduledRunCard['status'], 'skipped'>;
}

/** A task the agent runs on its schedule, each run in its one Side Chat. */
export interface ScheduledTask extends ScheduledTaskDefinition {
  id: string;
  paused: boolean;
  /** The proposal's tool call, so a chat can tell its proposal is already confirmed. */
  proposalId: string;
  /** Absent until its first run ends. */
  lastRun?: ScheduledTaskRun;
  /** When it next runs; absent while paused or once it has ended. */
  nextRun?: string;
  /** Why its next run cannot be read from a schedule Scheduler took, in place of `nextRun` (ADR 0030 probe semantics). */
  nextRunUnknown?: string;
  /** Whether it runs no more: past its stop time or no runs left before it. Ended beats paused. */
  ended: boolean;
}

/** The message a schedule delivers to the run queue when it is due. */
export interface ScheduledRunMessage {
  owner: string;
  taskId: string;
  deliveryFence?: string;
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

type Mutation = { token: string; kind: 'update'; changes: TaskChanges } | { token: string; kind: 'transfer'; destination: string; paused: boolean } | { token: string; kind: 'retire'; completedOneOff?: boolean };

type TaskItem = Omit<ScheduledTask, 'proposalId' | 'lastRun' | 'nextRun' | 'nextRunUnknown' | 'ended'> & {
  deliveryFence?: string; revision?: number; mutation?: Mutation; pk: string; sk: string; created_at: string; proposal_id: string; pending_creation?: boolean; creation_refused?: boolean; schedule_group?: string; last_run?: ScheduledTaskRun;
};

class RetirementSchedulerFailure extends Error {
  constructor(readonly error: unknown, readonly refused: boolean) {
    super('Scheduled task retirement failed', { cause: error });
  }
}

function retirementFailure(item: TaskItem, error: unknown): unknown {
  if (!(error instanceof ResourceNotFoundException)) return error;
  if (item.schedule_group !== undefined && item.pending_creation !== false) return error;
  const failure = item.schedule_group === undefined
    ? new HttpError(503, 'Scheduled task schedule group is unknown')
    : new HttpError(404, 'Scheduled task schedule not found');
  failure.cause = error;
  return failure;
}

interface Runs { next?: Date; unknown?: string; ended?: 'stop time' | 'schedule'; }

function runs(item: TaskItem): Runs {
  const stop = item.endDate === undefined ? Infinity : Date.parse(item.endDate);
  if (stop <= Date.now()) return { ended: 'stop time' };
  let next: Date | undefined;
  try {
    next = nextScheduledRun({ ...item, createdAt: item.created_at }, new Date());
  } catch (error) {
    return { unknown: unreadable(item.schedule, error) };
  }
  if (next === undefined) return { ended: 'schedule' };
  return next.getTime() >= stop ? { ended: 'stop time' } : { next };
}

const unreadable = (schedule: string, error: unknown) => `The schedule ${schedule} cannot be read: ${error instanceof Error ? error.message : String(error)}`;

/** A new schedule the sheet cannot read its next run from is the user's 400, refused before anything is stored. */
function assertReadable({ schedule, timezone, created_at }: TaskItem): void {
  try {
    nextScheduledRun({ schedule, timezone, createdAt: created_at }, new Date());
  } catch (error) {
    throw new HttpError(400, unreadable(schedule, error));
  }
}

function assertMigrated(item: TaskItem): void {
  if ('maxRuns' in item || 'run_deliveries' in item) throw new HttpError(503, 'Scheduled task migration is incomplete');
  if (item.deliveryFence !== undefined && (typeof item.deliveryFence !== 'string' || !item.deliveryFence)) throw new HttpError(503, 'Scheduled task delivery fence is invalid');
}

const task = (item: TaskItem): ScheduledTask => {
  assertMigrated(item);
  const { id, title, prompt, schedule, timezone, model, startDate, endDate, paused, proposal_id, last_run } = item;
  const { next, unknown, ended } = runs(item);
  return {
    id,
    title,
    prompt,
    schedule,
    timezone,
    ...(model === undefined ? {} : { model }),
    ...(endDate === undefined ? {} : { endDate }),
    ...(startDate === undefined ? {} : { startDate }),
    paused,
    proposalId: proposal_id,
    ...(last_run === undefined ? {} : { lastRun: last_run }),
    ...(next === undefined || paused ? {} : { nextRun: next.toISOString() }),
    ...(unknown === undefined || paused ? {} : { nextRunUnknown: unknown }),
    ended: ended !== undefined,
  };
};

const cancelledOn = (error: unknown, index: number) =>
  (error as Partial<TransactionCanceledException>).CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';

/**
 * Scheduled tasks, stored per account in the chat table beside a count that
 * holds the cap, each with an EventBridge Scheduler schedule of the same ID.
 */
export class ScheduledTasks {
  private readonly documents: DynamoDBDocumentClient;
  private readonly scheduler: SchedulerClient;
  private migrationVerified = false;
  private expiryCursor: Record<string, unknown> | undefined;

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

  async get(owner: string, id: string, delivery?: Pick<ScheduledRunMessage, 'deliveryFence'>): Promise<ScheduledTask | null> {
    const item = await this.taskItem(owner, id);
    if (item === undefined || (delivery !== undefined && (item.mutation?.kind === 'retire' || (item.deliveryFence !== undefined && item.deliveryFence !== delivery.deliveryFence)))) return null;
    return task(item);
  }

  async checkHealth(): Promise<void> {
    if (this.migrationVerified) return;
    let key: Record<string, unknown> | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- each scan page supplies the next cursor
      const page = await this.documents.send(new ScanCommand({
        TableName: this.tableName, ConsistentRead: true, ExclusiveStartKey: key,
        ProjectionExpression: 'pk, sk',
        FilterExpression: 'begins_with(pk, :pk) AND begins_with(sk, :sk) AND (attribute_exists(#max) OR attribute_exists(#runs))',
        ExpressionAttributeNames: { '#max': 'maxRuns', '#runs': 'run_deliveries' },
        ExpressionAttributeValues: { ':pk': 'SCHEDULED#', ':sk': 'TASK#' },
      }));
      if (page.Items === undefined) throw new HttpError(503, 'Scheduled task migration probe omitted rows');
      if (page.Items.length !== 0) throw new HttpError(503, 'Scheduled task migration is incomplete');
      key = page.LastEvaluatedKey;
    } while (key !== undefined);
    this.migrationVerified = true;
  }

  private async taskItem(owner: string, id: string): Promise<TaskItem | undefined> {
    const { Item } = await this.documents.send(
      // Stryker disable next-line BooleanLiteral: moto reads are always consistent; DynamoDB's strong read finds a task just confirmed
      new GetCommand({ TableName: this.tableName, Key: taskKey(owner, id), ConsistentRead: true }),
    );
    if (Item !== undefined) assertMigrated(Item as TaskItem);
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
    assertBounds(definition);
    for (const field of ['startDate', 'endDate'] as const) if (item[field] !== undefined) item[field] = new Date(item[field]).toISOString();
    assertReadable(item);
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
    try {
      await this.scheduler.send(new CreateScheduleCommand(this.schedule(owner, item, group)));
    } catch (error) {
      await this.rollbackCreation(owner, id, proposalId, error);
      throw schedulerRefusal(error);
    }
    await this.completeCreation(owner, item);
    // Read only once Scheduler has taken the schedule, so reading it never strands a pending task.
    return { task: task(item), created: true };
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
  async update(owner: string, id: string, changes: TaskChanges): Promise<ScheduledTask | null> {
    const item = await this.taskItem(owner, id);
    if (item === undefined) return null;
    // An Account Claim can leave the account over the cap with the overflow paused: none resumes until it is back under.
    if (item.paused && changes.paused === false && (await this.count(owner)) > SCHEDULED_TASK_CAP) {
      throw new HttpError(409, `An account can schedule at most ${SCHEDULED_TASK_CAP} tasks: delete one to resume another`);
    }
    const updated = withChanges(item, changes);
    assertBounds(updated);
    changes = { ...changes };
    for (const field of ['startDate', 'endDate'] as const) if (typeof changes[field] === 'string') changes[field] = new Date(changes[field]).toISOString();
    // A stored schedule unread is reported, not refused: only a new one must be readable.
    if (changes.schedule !== undefined) assertReadable(updated);
    // Scheduler runs nothing past the stop time, so an ended task resumes only once its stop time moves or clears.
    const { ended } = runs(updated);
    if (item.paused && changes.paused === false && ended !== undefined) {
      throw new HttpError(409, `This task has ended: ${ended === 'stop time' ? 'move or clear its stop time' : 'change its schedule'} to resume it`);
    }
    if (!['schedule', 'timezone', 'paused', 'startDate', 'endDate'].some((field) => field in changes)) return (await this.writeChanges(owner, id, changes)) ? this.get(owner, id) : null;
    const mutation: Mutation = { token: randomUUID(), kind: 'update', changes };
    await this.fence(owner, item, mutation);
    return this.finishUpdate(owner, { ...item, mutation });
  }

  private async finishUpdate(owner: string, item: TaskItem): Promise<ScheduledTask | null> {
    const mutation = item.mutation;
    if (mutation?.kind !== 'update') throw new Error('Task update has no durable intent');
    const updated = withChanges(item, mutation.changes);
    if (['schedule', 'timezone', 'paused', 'startDate', 'endDate'].some((field) => field in mutation.changes)) {
      try {
        await this.reschedule(owner, item, updated);
      } catch (error) {
        if (error instanceof HttpError && (error.status === 400 || error.status === 409)) {
          try {
            await this.documents.send(new UpdateCommand({
              TableName: this.tableName, Key: taskKey(owner, item.id), UpdateExpression: 'REMOVE mutation',
              ConditionExpression: 'mutation.#token = :token', ExpressionAttributeNames: { '#token': 'token' },
              ExpressionAttributeValues: { ':token': mutation.token },
            }));
          } catch (recoveryFailure) {
            throw new AggregateError([error, recoveryFailure], 'Refused task update could not release its mutation fence');
          }
        }
        throw error;
      }
    }
    return (await this.writeChanges(owner, item.id, mutation.changes, mutation.token)) ? this.get(owner, item.id) : null;
  }

  private async fence(owner: string, item: TaskItem, mutation: Mutation, contentionAllowed = false): Promise<boolean> {
    try {
      await this.documents.send(new UpdateCommand({
        TableName: this.tableName, Key: taskKey(owner, item.id),
        UpdateExpression: 'SET mutation = :mutation',
        ConditionExpression: `attribute_exists(pk) AND attribute_not_exists(mutation) AND ${item.revision === undefined ? 'attribute_not_exists(revision)' : 'revision = :revision'}`,
        ExpressionAttributeValues: { ':mutation': mutation, ...(item.revision === undefined ? {} : { ':revision': item.revision }) },
      }));
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      if (contentionAllowed) return false;
      const failure = new HttpError(409, 'Scheduled task changed or has a pending mutation; retry after it completes');
      failure.cause = error;
      throw failure;
    }
    return true;
  }

  /** Call only after every Chat Service writer has stopped. A live writer may still have an AWS request in flight. */
  async recoverMutation(owner: string, id: string): Promise<void> {
    const item = await this.taskItem(owner, id);
    if (item?.mutation === undefined) return;
    if (item.mutation.kind === 'update') await this.finishUpdate(owner, item);
    else if (item.mutation.kind === 'transfer') await this.finishMove(owner, item.mutation.destination, item);
    else await this.finishRetirement(owner, item);
  }

  /** Move the task's schedule to match its changed item; a one-off whose schedule is gone has already run. */
  private async reschedule(owner: string, item: TaskItem, updated: TaskItem): Promise<void> {
    try {
      await this.scheduler.send(new UpdateScheduleCommand(this.schedule(owner, updated)));
    } catch (error) {
      if (error instanceof ResourceNotFoundException && (once(item.schedule) || once(updated.schedule))) {
        const refusal = new HttpError(409, once(item.schedule)
          ? 'This one-off task has already run: it leaves Scheduled once its run reaches the Main Chat'
          : 'The schedule is unavailable; the task update could not be confirmed');
        refusal.cause = error;
        throw refusal;
      }
      throw schedulerRefusal(error);
    }
  }

  /** Store the task's changes unless the account history was deleted; false when the task is gone. */
  private async writeChanges(owner: string, id: string, changes: TaskChanges, token?: string): Promise<boolean> {
    const expression = fencedChangeExpression(changes, token);
    const taskCondition = {
      TableName: this.tableName, Key: taskKey(owner, id),
      ConditionExpression: token === undefined ? 'attribute_exists(pk) AND attribute_not_exists(mutation)' : 'attribute_exists(pk) AND mutation.#token = :token',
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
          expression === null ? { ConditionCheck: taskCondition } : { Update: { ...taskCondition, ...expression } },
        ],
      }));
    } catch (error) {
      if (cancelledOn(error, 0)) return this.refuseDeletedUpdate(owner, id, token);
      if (cancelledOn(error, 1)) {
        if (token === undefined && await this.taskItem(owner, id) === undefined) return false;
        throw new HttpError(409, 'Scheduled task mutation lost its fence');
      }
      throw error;
    }
    return true;
  }

  private async refuseDeletedUpdate(owner: string, id: string, token?: string): Promise<never> {
    const refusal = new HttpError(410, 'The account history was deleted');
    if (token !== undefined) {
      try {
        await this.documents.send(new UpdateCommand({
          TableName: this.tableName, Key: taskKey(owner, id), UpdateExpression: 'REMOVE mutation',
          ConditionExpression: 'mutation.#token = :token', ExpressionAttributeNames: { '#token': 'token' },
          ExpressionAttributeValues: { ':token': token },
        }));
      } catch (recoveryFailure) {
        if (!(recoveryFailure instanceof ConditionalCheckFailedException)) {
          throw new AggregateError([refusal, recoveryFailure], 'Deleted account task update could not release its mutation fence');
        }
      }
    }
    throw refusal;
  }

  /** Record how the task's latest run ended; a task deleted while it ran has nothing to record it on. */
  async recordRun(owner: string, id: string, run: ScheduledTaskRun): Promise<void> {
    await this.updateRunning(owner, id, 'SET last_run = :run', { ':run': run });
  }

  /** Update a task a run is under way on; a task deleted while it ran has nothing to update. */
  private async updateRunning(owner: string, id: string, expression: string, values: Record<string, unknown>): Promise<void> {
    try {
      await this.documents.send(new UpdateCommand({
        TableName: this.tableName,
        Key: taskKey(owner, id),
        UpdateExpression: expression,
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: values,
      }));
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  }

  /** Delete the task's schedule, then the task; false when there is no such task. */
  async delete(owner: string, id: string): Promise<boolean> {
    let item = await this.taskItem(owner, id);
    if (item === undefined) return false;
    if (item.mutation?.kind !== 'retire') {
      const mutation: Mutation = { token: randomUUID(), kind: 'retire' };
      if (!(await this.fence(owner, item, mutation, true))) {
        const current = await this.taskItem(owner, id);
        if (current === undefined) return false;
        if (current.mutation?.kind !== 'retire') throw new HttpError(409, 'Scheduled task has a pending mutation');
        return this.finishRetirement(owner, current);
      }
      item = { ...item, mutation };
    }
    return this.finishRetirement(owner, item);
  }

  private async finishRetirement(owner: string, item: TaskItem, isolateSchedulerFailure = false): Promise<boolean> {
    if (item.mutation?.kind !== 'retire') throw new Error('Task retirement has no durable intent');
    if (item.mutation.completedOneOff === true) return this.remove(owner, item.id, item.proposal_id);
    try {
      return await this.removeScheduledTask(owner, item.id, item.proposal_id, item.schedule_group ?? this.config.group, item.pending_creation === false && item.schedule_group !== undefined, item.mutation.token);
    } catch (error) {
      if (!(error instanceof RetirementSchedulerFailure)) throw error;
      const failure = retirementFailure(item, error.error);
      if (error.refused && item.pending_creation === false) {
        await this.releaseRetirementFence(owner, item.id, item.mutation.token, failure);
      }
      throw isolateSchedulerFailure ? new RetirementSchedulerFailure(failure, error.refused) : failure;
    }
  }

  private async releaseRetirementFence(owner: string, id: string, token: string, failure: unknown): Promise<void> {
    try {
      await this.documents.send(new UpdateCommand({
        TableName: this.tableName, Key: taskKey(owner, id), UpdateExpression: 'REMOVE mutation',
        ConditionExpression: 'mutation.#token = :token', ExpressionAttributeNames: { '#token': 'token' },
        ExpressionAttributeValues: { ':token': token },
      }));
    } catch (recoveryFailure) {
      if (!(recoveryFailure instanceof ConditionalCheckFailedException)) {
        throw new AggregateError([failure, recoveryFailure], 'Refused task retirement could not release its mutation fence');
      }
    }
  }

  async retireExpired(): Promise<{ owner: string; taskId: string; error: unknown }[]> {
    const failures: { owner: string; taskId: string; error: unknown }[] = [];
    const now = new Date().toISOString();
    const page = await this.documents.send(new ScanCommand({
      TableName: this.tableName, Limit: 100, ExclusiveStartKey: this.expiryCursor,
      FilterExpression: 'begins_with(pk, :owner) AND begins_with(sk, :task) AND ((endDate <= :now AND attribute_not_exists(mutation)) OR mutation.#kind = :retire)',
      ExpressionAttributeNames: { '#kind': 'kind' },
      ExpressionAttributeValues: { ':owner': 'SCHEDULED#', ':task': 'TASK#', ':now': now, ':retire': 'retire' },
    }));
    for (const candidate of (page.Items ?? []) as TaskItem[]) {
      if ((once(candidate.schedule) && candidate.mutation?.kind !== 'retire') || candidate.pending_creation !== false) continue;
      const owner = candidate.pk.slice('SCHEDULED#'.length);
      // eslint-disable-next-line no-await-in-loop -- capacity release transactions share an owner counter
      const current = await this.taskItem(owner, candidate.id);
      if (current === undefined) continue;
      // eslint-disable-next-line no-await-in-loop -- each retirement holds its fence before deleting Scheduler
      const retiring = await this.fenceExpiredTask(owner, current);
      if (retiring === undefined) continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- capacity release transactions share an owner counter
        await this.finishRetirement(owner, retiring, true);
      } catch (error) {
        if (!(error instanceof RetirementSchedulerFailure)) throw error;
        failures.push({ owner, taskId: current.id, error: error.error });
      }
    }
    this.expiryCursor = page.LastEvaluatedKey;
    return failures;
  }

  private async fenceExpiredTask(owner: string, current: TaskItem): Promise<TaskItem | undefined> {
    if (current.mutation?.kind === 'retire') return current;
    if (current.mutation !== undefined || current.endDate === undefined || Date.parse(current.endDate) > Date.now()) return undefined;
    const mutation: Mutation = { token: randomUUID(), kind: 'retire' };
    if (!(await this.fence(owner, current, mutation, true))) return undefined;
    return { ...current, mutation };
  }

  /**
   * Once a one-off's run has reached the Main Chat, however it ended: Scheduler has deleted its schedule
   * (`ActionAfterCompletion: DELETE`), so it can never run again, and the task leaves the account, freeing its place
   * under the cap. Its Side Chat and run card keep the record. Recurring expiry is settled by the polling lifecycle.
   */
  async retire(owner: string, task: ScheduledTask): Promise<void> {
    if (!fired(task)) return;
    const current = await this.taskItem(owner, task.id);
    if (current === undefined || !fired(current)) return;
    if (current.mutation?.kind === 'retire') {
      await this.finishRetirement(owner, current);
      return;
    }
    const mutation: Mutation = { token: randomUUID(), kind: 'retire', completedOneOff: true };
    if (!(await this.fence(owner, current, mutation, true))) throw new HttpError(409, 'One-off retirement is waiting for a task mutation');
    await this.finishRetirement(owner, { ...current, mutation });

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
      assertMigrated(found);
      held += 1;
      const item = { ...found, paused: found.paused || held > SCHEDULED_TASK_CAP };
      // eslint-disable-next-line no-await-in-loop -- one task at a time
      await this.move(source, destination, item);
    }
  }

  private async move(source: string, destination: string, item: TaskItem): Promise<void> {
    const mutation: Mutation = { token: randomUUID(), kind: 'transfer', destination, paused: item.paused };
    await this.fence(source, item, mutation);
    return this.finishMove(source, destination, { ...item, mutation });
  }

  private async finishMove(source: string, destination: string, item: TaskItem): Promise<void> {
    const mutation = item.mutation;
    if (mutation?.kind !== 'transfer') throw new Error('Task transfer has no durable intent');
    item = { ...item, paused: mutation.paused };
    const moved = { ...item };
    delete moved.mutation;
    try {
      await this.scheduler.send(new UpdateScheduleCommand(this.schedule(destination, item)));
    } catch (error) {
      // Scheduler deletes a one-off's schedule once its run is delivered; the task moves until its run retires it.
      if (!(error instanceof ResourceNotFoundException && once(item.schedule))) throw error;
    }
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
      { Put: { TableName: this.tableName, Item: { ...moved, revision: (item.revision ?? 0) + 1, ...taskKey(destination, item.id) } } },
      {
        Put: {
          TableName: this.tableName,
          Item: { ...proposalKey(destination, item.proposal_id), task_id: item.id },
        },
      },
      { Delete: { TableName: this.tableName, Key: proposalKey(source, item.proposal_id) } },
      destinationCount,
      { Delete: { TableName: this.tableName, Key: taskKey(source, item.id), ConditionExpression: 'mutation.#token = :token', ExpressionAttributeNames: { '#token': 'token' }, ExpressionAttributeValues: { ':token': mutation.token } } },
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
      if (cancelledOn(error, transactItems.indexOf(destinationCount))) {
        await this.documents.send(new UpdateCommand({ TableName: this.tableName, Key: taskKey(source, item.id), UpdateExpression: 'SET mutation.paused = :paused', ConditionExpression: 'mutation.#token = :token', ExpressionAttributeNames: { '#token': 'token' }, ExpressionAttributeValues: { ':paused': true, ':token': mutation.token } }));
        return this.finishMove(source, destination, { ...item, mutation: { ...mutation, paused: true } });
      }
      throw error;
    }
  }

  private async removeScheduledTask(owner: string, id: string, proposalId: string, group: string, creationComplete: boolean, clientToken?: string): Promise<boolean> {
    try {
      await this.scheduler.send(new DeleteScheduleCommand({ Name: id, GroupName: group, ClientToken: clientToken }));
    } catch (error) {
      // An admitted create may still produce a schedule: only durable completion permits metadata repair.
      if (!(error instanceof ResourceNotFoundException) || !creationComplete) {
        throw clientToken === undefined ? error : new RetirementSchedulerFailure(error, error instanceof ResourceNotFoundException);
      }
      // DeleteSchedule's 404 can name the group, not this task: verify its recorded group before durable cleanup.
      // https://docs.aws.amazon.com/scheduler/latest/APIReference/API_DeleteSchedule.html
      await this.verifyRemovalGroup(group, clientToken);
      try {
        await this.remove(owner, id, proposalId);
      } catch (repairFailure) {
        throw new AggregateError([error, repairFailure], 'Schedule absence and task metadata cleanup failed');
      }
      // Repair retains the observed SDK failure; the next deletion retry sees the erased task.
      throw clientToken === undefined ? error : new RetirementSchedulerFailure(error, false);
    }
    return this.remove(owner, id, proposalId);
  }

  private async verifyRemovalGroup(group: string, clientToken?: string): Promise<void> {
    try {
      await this.scheduler.send(new GetScheduleGroupCommand({ Name: group }));
    } catch (groupError) {
      if (groupError instanceof ResourceNotFoundException) {
        const failure = new HttpError(502, 'Scheduled task schedule group not found');
        failure.cause = groupError;
        throw clientToken === undefined ? failure : new RetirementSchedulerFailure(failure, true);
      }
      throw clientToken === undefined ? groupError : new RetirementSchedulerFailure(groupError, false);
    }
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

  private schedule(owner: string, { id, schedule, timezone, startDate: starts, endDate, paused, created_at, deliveryFence }: TaskItem, group = this.config.group) {
    const message: ScheduledRunMessage = { owner, taskId: id, ...(deliveryFence === undefined ? {} : { deliveryFence }) };
    const startDate = nextRateTick(schedule, created_at, Date.now(), starts) ?? (starts === undefined ? undefined : new Date(starts));
    // Scheduler's API reference promises no past EndDate, so a schedule past its stop time goes without one, disabled:
    // the task keeps its stop time, to move or clear.
    const stopped = endDate !== undefined && Date.parse(endDate) <= Date.now();
    return {
      Name: id,
      GroupName: group,
      ScheduleExpression: schedule,
      ScheduleExpressionTimezone: timezone,
      ...(startDate === undefined ? {} : { StartDate: startDate }),
      ...(endDate === undefined || stopped ? {} : { EndDate: new Date(endDate) }),
      // A one-off schedule is gone once it has run; its run retires the task.
      ...(once(schedule) ? { ActionAfterCompletion: 'DELETE' as const } : {}),
      State: paused || stopped ? ('DISABLED' as const) : ('ENABLED' as const),
      FlexibleTimeWindow: { Mode: 'OFF' as const },
      Target: { Arn: this.config.queueArn, RoleArn: this.config.roleArn, Input: JSON.stringify(message) },
    };
  }
}

/** The task with an edit applied: a stop time cleared with null leaves it without one. */
function withChanges(item: TaskItem, changes: TaskChanges): TaskItem {
  const updated = { ...item, ...changes };
  for (const field of ['startDate', 'endDate'] as const) {
    if (changes[field] === null) delete updated[field];
  }
  return updated as TaskItem;
}

/** The DynamoDB update an edit makes: SET each field it sends, REMOVE each it clears; null when it changes none. */
function changeExpression(changes: TaskChanges): { UpdateExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues?: Record<string, string | boolean | number> } | null {
  const fields = Object.entries(changes);
  if (fields.length === 0) return null;
  const set = fields.flatMap(([, value], index) => (value === null ? [] : [`#field${index} = :value${index}`]));
  const removed = fields.flatMap(([, value], index) => (value === null ? [`#field${index}`] : []));
  const values = fields.flatMap(([, value], index) => (value === null ? [] : [[`:value${index}`, value] as const]));
  return {
    UpdateExpression: [set.length === 0 ? '' : `SET ${set.join(', ')}`, removed.length === 0 ? '' : `REMOVE ${removed.join(', ')}`].join(' ').trim(),
    ExpressionAttributeNames: Object.fromEntries(fields.map(([name], index) => [`#field${index}`, name])),
    ...(values.length === 0 ? {} : { ExpressionAttributeValues: Object.fromEntries(values) }),
  };
}

function fencedChangeExpression(changes: TaskChanges, token: string | undefined): ReturnType<typeof changeExpression> {
  const expression = changeExpression(changes);
  if (expression === null) return null;
  if (token !== undefined) {
    expression.UpdateExpression += expression.UpdateExpression.includes('REMOVE ') ? ', mutation' : ' REMOVE mutation';
    expression.ExpressionAttributeValues = { ...expression.ExpressionAttributeValues, ':token': token };
    expression.ExpressionAttributeNames = { ...expression.ExpressionAttributeNames, '#token': 'token' };
  }
  expression.UpdateExpression += ' ADD revision :one';
  expression.ExpressionAttributeValues = { ...expression.ExpressionAttributeValues, ':one': 1 };
  return expression;
}

/** Scheduler's refusal of an expression or timezone is the user's 400; anything else propagates. */
function schedulerRefusal(error: unknown): unknown {
  return error instanceof ValidationException ? new HttpError(400, error.message) : error;
}

function assertBounds(definition: { schedule: string; startDate?: string; endDate?: string }): void {
  if (once(definition.schedule) && (definition.startDate !== undefined || definition.endDate !== undefined)) throw new HttpError(422, 'One-off tasks do not support startDate or endDate');
  if ('maxRuns' in definition || 'count' in definition) throw new HttpError(422, 'Use startDate and endDate instead of a run count');
  for (const field of ['startDate', 'endDate'] as const) {
    const value = definition[field];
    if (value !== undefined && !isScheduledInstant(value)) throw new HttpError(422, `${field} must be an ISO instant`);
  }
  if (definition.startDate !== undefined && definition.endDate !== undefined && Date.parse(definition.endDate) <= Date.parse(definition.startDate)) throw new HttpError(422, 'endDate must be after startDate');
}
