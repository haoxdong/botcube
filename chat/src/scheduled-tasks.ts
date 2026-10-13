import { positiveInteger } from './config.js';
import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient, type TransactionCanceledException } from '@aws-sdk/client-dynamodb';
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
import { Cron } from 'croner';
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
  /** How many runs it makes before it retires itself, as iCalendar RRULE's `COUNT` beside `UNTIL`. */
  maxRuns?: number;
}

/** An edit: any definition fields but the count of runs, a stop time cleared with null, and whether the task is paused. */
export type TaskChanges = Partial<Omit<ScheduledTaskDefinition, 'endDate' | 'maxRuns'>> & { endDate?: string | null; paused?: boolean };

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
  /** Whether it runs no more: past its stop time, no runs left before it, or its count of runs made. Ended beats paused. */
  ended: boolean;
  /** How many runs it has made, for a task with a count of runs. */
  runsMade?: number;
}

/** Whether a task has made its count of runs, so it runs no more and its last run retires it. */
export const spent = (task: { maxRuns?: number | undefined; runsMade?: number | undefined }) => task.maxRuns !== undefined && (task.runsMade ?? 0) >= task.maxRuns;

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

type TaskItem = Omit<ScheduledTask, 'proposalId' | 'lastRun' | 'nextRun' | 'nextRunUnknown' | 'ended' | 'runsMade'> & {
  pk: string; sk: string; created_at: string; proposal_id: string; pending_creation?: boolean; creation_refused?: boolean; schedule_group?: string; last_run?: ScheduledTaskRun;
  /** The deliveries that ran, for a task with a count of runs: a set, so a redelivered run counts once. */
  run_deliveries?: Set<string>;
};

const runsMade = (item: TaskItem) => (item.maxRuns === undefined ? undefined : (item.run_deliveries?.size ?? 0));

/** A `rate(...)` schedule's first tick after now, counted from the task's creation as its schedule starts there. */
function nextRateTick(schedule: string, createdAt: string): Date | undefined {
  const rate = /^rate\(\s*([1-9]\d*)\s+(minute|hour|day)s?\s*\)$/.exec(schedule);
  if (rate === null) return undefined;
  const units = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  const period = Number(rate[1]) * units[rate[2] as keyof typeof units];
  const anchor = new Date(createdAt).getTime();
  return new Date(anchor + Math.max(1, Math.floor((Date.now() - anchor) / period) + 1) * period);
}

/** What the task's schedule says of its runs: its next, or why that cannot be read, and why it runs no more. */
interface Runs {
  next?: Date;
  unknown?: string;
  /** What ended it: its stop time passed or comes before its next run, its schedule has no runs left, or it made its count. */
  ended?: 'stop time' | 'schedule' | 'count';
}

/** The task's runs, its pause aside: Scheduler runs nothing past the stop time. */
function runs(item: TaskItem): Runs {
  const { schedule, timezone, created_at, endDate, maxRuns } = item;
  if (spent({ maxRuns, runsMade: runsMade(item) })) return { ended: 'count' };
  const stop = endDate === undefined ? Infinity : Date.parse(endDate);
  if (stop <= Date.now()) return { ended: 'stop time' };
  let next: Date | undefined;
  try {
    next = scheduledRun(schedule, timezone, created_at);
  } catch (error) {
    // Probe semantics (ADR 0030): a schedule Scheduler took but croner cannot read is reported unread, failing nothing.
    return { unknown: unreadable(schedule, error) };
  }
  if (next === undefined) return { ended: 'schedule' };
  return next.getTime() > stop ? { ended: 'stop time' } : { next };
}

/**
 * The schedule's next run after now, ignoring pause and stop time, read as EventBridge Scheduler reads it in its time
 * zone: a cron's six fields end with the year, its days of the week count from 1, Sunday, and `?` reads as any.
 * Croner takes seconds first.
 */
function scheduledRun(schedule: string, timezone: string, created_at: string): Date | undefined {
  const cron = /^cron\((.+)\)$/.exec(schedule)?.[1];
  if (cron !== undefined) {
    const fields = cron.trim().split(/\s+/).map((field, index) =>
      // Croner counts the days of the week from 0, Sunday; a lone L is the week's last day, Saturday (7).
      index === 4 ? (field === 'L' ? '7' : field).replace(/(?<![#/\d])\d/g, (number) => String(Number(number) - 1))
        // Croner steps a year's `*` from year 0, which it refuses; EventBridge's years start at 1970.
        : index === 5 ? field.replace(/^\*\//, '1970/') : field);
    if (fields.length !== 6) throw new Error(`Scheduled task cron ${schedule} does not have six fields`);
    // Sloppy ranges read EventBridge's steps from a number (`1/10`), which croner's strict parser refuses.
    return new Cron(['0', ...fields.map((field) => (field === '?' ? '*' : field))].join(' '), { timezone, sloppyRanges: true }).nextRun() ?? undefined;
  }
  const at = /^at\((.+)\)$/.exec(schedule)?.[1];
  if (at !== undefined) return new Cron(at, { timezone }).nextRun() ?? undefined;
  const tick = nextRateTick(schedule, created_at);
  if (tick === undefined) throw new Error(`Scheduled task schedule ${schedule} is not cron(...), rate(...) or at(...)`);
  return tick;
}

const unreadable = (schedule: string, error: unknown) => `The schedule ${schedule} cannot be read: ${error instanceof Error ? error.message : String(error)}`;

/** A new schedule the sheet cannot read its next run from is the user's 400, refused before anything is stored. */
function assertReadable({ schedule, timezone, created_at }: TaskItem): void {
  try {
    scheduledRun(schedule, timezone, created_at);
  } catch (error) {
    throw new HttpError(400, unreadable(schedule, error));
  }
}

const task = (item: TaskItem): ScheduledTask => {
  const { id, title, prompt, schedule, timezone, model, endDate, maxRuns, paused, proposal_id, last_run } = item;
  const { next, unknown, ended } = runs(item);
  const made = runsMade(item);
  return {
    id,
    title,
    prompt,
    schedule,
    timezone,
    ...(model === undefined ? {} : { model }),
    ...(endDate === undefined ? {} : { endDate }),
    ...(maxRuns === undefined ? {} : { maxRuns }),
    paused,
    proposalId: proposal_id,
    ...(last_run === undefined ? {} : { lastRun: last_run }),
    ...(next === undefined || paused ? {} : { nextRun: next.toISOString() }),
    ...(unknown === undefined || paused ? {} : { nextRunUnknown: unknown }),
    ended: ended !== undefined,
    ...(made === undefined ? {} : { runsMade: made }),
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
    // A stored schedule unread is reported, not refused: only a new one must be readable.
    if (changes.schedule !== undefined) assertReadable(updated);
    // Scheduler runs nothing past the stop time, so an ended task resumes only once its stop time moves or clears.
    const { ended } = runs(updated);
    if (item.paused && changes.paused === false && ended !== undefined) {
      throw new HttpError(409, `This task has ended: ${ended === 'stop time' ? 'move or clear its stop time' : 'change its schedule'} to resume it`);
    }
    if (['schedule', 'timezone', 'paused', 'endDate'].some((field) => field in changes)) await this.reschedule(owner, item, updated);
    return (await this.writeChanges(owner, id, changes)) ? this.get(owner, id) : null;
  }

  /** Move the task's schedule to match its changed item; a one-off whose schedule is gone has already run. */
  private async reschedule(owner: string, item: TaskItem, updated: TaskItem): Promise<void> {
    try {
      await this.scheduler.send(new UpdateScheduleCommand(this.schedule(owner, updated)));
    } catch (error) {
      if (error instanceof ResourceNotFoundException && once(item.schedule)) {
        const refusal = new HttpError(409, 'This one-off task has already run: it leaves Scheduled once its run reaches the Main Chat');
        refusal.cause = error;
        throw refusal;
      }
      throw schedulerRefusal(error);
    }
  }

  /** Store the task's changes unless the account history was deleted; false when the task is gone. */
  private async writeChanges(owner: string, id: string, changes: TaskChanges): Promise<boolean> {
    const expression = changeExpression(changes);
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
          expression === null ? { ConditionCheck: taskCondition } : { Update: { ...taskCondition, ...expression } },
        ],
      }));
    } catch (error) {
      if (cancelledOn(error, 0)) throw new HttpError(410, 'The account history was deleted');
      if (cancelledOn(error, 1)) return false;
      throw error;
    }
    return true;
  }

  /** Record how the task's latest run ended; a task deleted while it ran has nothing to record it on. */
  async recordRun(owner: string, id: string, run: ScheduledTaskRun): Promise<void> {
    await this.updateRunning(owner, id, 'SET last_run = :run', { ':run': run });
  }

  /**
   * Count a run toward the task's count of runs as it starts, so no later delivery runs past it; a set of the
   * deliveries that ran, so a redelivered run counts once.
   */
  async countRun(owner: string, id: string, deliveryId: string): Promise<void> {
    await this.updateRunning(owner, id, 'ADD run_deliveries :delivery', { ':delivery': new Set([deliveryId]) });
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
    const item = await this.taskItem(owner, id);
    if (item === undefined) return false;
    try {
      return await this.removeScheduledTask(owner, id, item.proposal_id, item.schedule_group ?? this.config.group, item.pending_creation === false && item.schedule_group !== undefined);
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
      if (item.schedule_group === undefined) {
        const failure = new HttpError(503, 'Scheduled task schedule group is unknown');
        failure.cause = error;
        throw failure;
      }
      if (item.pending_creation !== false) throw error;
      const failure = new HttpError(404, 'Scheduled task schedule not found');
      failure.cause = error;
      throw failure;
    }
  }

  /**
   * Once a one-off's run has reached the Main Chat, however it ended: Scheduler has deleted its schedule
   * (`ActionAfterCompletion: DELETE`), so it can never run again, and the task leaves the account, freeing its place
   * under the cap. Its Side Chat and run card keep the record. A task that has made its count of runs leaves with its
   * schedule. Any other recurring task stays.
   */
  async retire(owner: string, task: ScheduledTask): Promise<void> {
    // A run queued before the task was made one-off leaves it until its own time comes.
    if (fired(task)) {
      await this.remove(owner, task.id, task.proposalId);
      return;
    }
    if (task.maxRuns === undefined) return;
    // The run just recorded is not in the task as its run read it.
    const current = await this.get(owner, task.id);
    if (current !== null && spent(current)) await this.delete(owner, task.id);
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

  private schedule(owner: string, { id, schedule, timezone, endDate, paused, created_at }: TaskItem, group = this.config.group) {
    const message: ScheduledRunMessage = { owner, taskId: id };
    const startDate = nextRateTick(schedule, created_at);
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
function withChanges(item: TaskItem, { endDate, ...rest }: TaskChanges): TaskItem {
  const { endDate: previous, ...kept } = item;
  const stop = endDate === undefined ? previous : (endDate ?? undefined);
  return { ...kept, ...rest, ...(stop === undefined ? {} : { endDate: stop }) };
}

/** The DynamoDB update an edit makes: SET each field it sends, REMOVE each it clears; null when it changes none. */
function changeExpression(changes: TaskChanges) {
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

/** Scheduler's refusal of an expression or timezone is the user's 400; anything else propagates. */
function schedulerRefusal(error: unknown): unknown {
  return error instanceof ValidationException ? new HttpError(400, error.message) : error;
}
