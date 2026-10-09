import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ScheduledRunStore } from './scheduled-run-store.js';
import {
  ConditionalCheckFailedException,
  DescribeTableCommand,
  DynamoDBClient,
  type TransactionCanceledException,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  paginateQuery,
  paginateScan,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';

/** Why a Turn failed, as the run error its client was sent last; AG-UI makes its code optional. */
export interface TurnFailure {
  code?: string;
  message: string;
}

/** One Session's metadata row; the Session's content lives in the Session record. */
export interface SessionSummary {
  session_id: string;
  filing_user_id: string;
  runtime_binding?: string;
  runtime_generation?: string;
  legacy_settlement_unproved?: true;
  title?: string;
  created_at: string;
  updated_at: string;
  /** The model provider of the Session's first Turn, which all its Turns run on; absent until a model Turn. */
  provider?: string;
  /** When the Session's latest relayed Turn started, until its relay ends. */
  turn_running_since?: string;
  /** The run ID of that Turn, which a Stop names. */
  turn_run_id?: string;
  /** The accepted Turn has not yet emitted RUN_STARTED, so Stop cannot reach it. */
  turn_preparing?: boolean;
  /** Why the Session's latest relayed Turn failed, and its run ID, until the next Turn starts. */
  turn_failure?: TurnFailure & { runId: string };
  /** The run ID of the Session's latest Turn, kept once it ends, while a relayed Turn is the latest. */
  turn_latest_run_id?: string;
  /**
   * The latest Turn's run ID or scheduled message ID. An idle history read names it so the session API
   * checks the snapshot's settled Turn marker or message membership.
   */
  latest_message_id?: string;
}

export type SessionPurge = Pick<SessionSummary, 'session_id' | 'filing_user_id' | 'runtime_binding' | 'runtime_generation' | 'legacy_settlement_unproved'>;

/** The Turn's Session, or its owner's whole history, is deleted: it takes no more Turns. */
export class SessionDeletedError extends Error {}

/** A registered writer has not acknowledged dispatch/completion yet; deletion must keep waiting. */
export class SessionDispatchPendingError extends Error {}

export class SessionNamespaceNotReadyError extends Error {
  constructor() {
    super('Session Runtime namespace is not ready; old Chat dispatchers must be retired and broker-only Memory writes verified before tracked admission');
  }
}

/** What the agent did in one finished Turn, as the Agent Profile's Activity shows it. */
export interface TurnSummary {
  /** The task, in a few words. */
  title: string;
  /** What the agent did, in one line. */
  summary: string;
}

/**
 * A finished Turn as the Activity lists it (ADR 0067 §2): when it finished and the first line
 * of its request, and its summary once the summary model wrote one, or why it failed.
 */
export interface TurnActivity {
  /** The first line of the user message that started the Turn. */
  request: string;
  /** When the Turn finished, ISO 8601. */
  completedAt: string;
  summary?: TurnSummary;
  /** The first line of the run error the Turn ended with, or of why its summary failed. */
  failed?: string;
}

/**
 * A finished Turn's row, by its Session and the user message that started the Turn. Rows saved
 * before the Activity backfill carry only the summary until it adds the rest.
 */
export interface StoredTurnSummary extends Partial<TurnSummary> {
  session_id: string;
  message_id: string;
  request?: string;
  completed_at?: string;
  failed?: string;
}

/** The Turn's model is another provider's than the Session's first Turn's. */
export class SessionProviderError extends Error {
  constructor(readonly provider: string) {
    super(`The Session runs on ${provider} models`);
  }
}

/** The source account's history is being transferred by Account Claim. */
export class SessionClaimError extends Error {}

/**
 * Session Metadata (ADR 0067 §2): the only index of Sessions. The item shape is
 * live production data and must stay byte-compatible with the items already stored:
 * `pk = SESSIONS#<owner>`, `sk = SESSION#<id>` | `DELETED` | `CLAIM` | `RETIRED#<id>` | `MAIN`.
 * Turn summaries: `pk = TURN_SUMMARIES#<filing user>`, `sk = SESSION#<id>#TURN#<message id>`.
 */
export interface TurnMemoryLease {
  purpose?: 'warmup' | undefined;
  owner: string;
  accountActorId: string;
  filingUserId: string;
  sessionId: string;
  runId: string;
  jti: string;
  startedAt: string;
  expiresAt: number;
}

type AcceptedDispatch = RunningTurn | { messageId: string };

export type RegisteredDispatch = (() => Promise<void>) & {
  readonly session?: SessionPurge;
  readonly token?: string;
  markRejected?: (runtimeTarget: string) => Promise<void>;
  markSucceeded?: (kind: 'memory-event' | 'session-post', completion?: NonNullable<TransactWriteCommandInput['TransactItems']>[number]) => Promise<void>;
  confirmStopped?: () => Promise<void>;
  stopConfirmed?: boolean;
};

function turnAdmissionCondition(creating: boolean, provider: string): string {
  return `attribute_not_exists(deleted_at) AND ${creating ? 'attribute_not_exists' : 'attribute_exists'}(session_id)${provider}`;
}

function compatibleAdmission(error: unknown, provider: string | undefined): boolean {
  const existing = (error as Partial<TransactionCanceledException>).CancellationReasons?.[1]?.Item?.provider?.S;
  return provider === undefined || existing === undefined || existing === provider;
}

export const trackedRuntime = (session: SessionPurge): session is SessionPurge & { runtime_binding: string } => session.legacy_settlement_unproved !== true && session.runtime_generation === 'tracked-v1' && /^runtime-[0-9a-f-]{36}$/.test(session.runtime_binding ?? '');
export const boundRuntime = (session: SessionPurge): session is SessionPurge & { runtime_binding: string } => trackedRuntime(session) || (session.runtime_generation === 'continuation-v1' && session.legacy_settlement_unproved === true && /^runtime-[0-9a-f-]{36}$/.test(session.runtime_binding ?? ''));
const runtimeIdentity = (session: Partial<SessionPurge>): Partial<SessionPurge> => ({
  ...(session.runtime_binding === undefined ? {} : { runtime_binding: session.runtime_binding }),
  ...(session.runtime_generation === undefined ? {} : { runtime_generation: session.runtime_generation }),
  ...(session.legacy_settlement_unproved === undefined ? {} : { legacy_settlement_unproved: session.legacy_settlement_unproved }),
});
const retirementKey = { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED' };
const retirementCondition = { ConditionExpression: 'old_chat_retired = :yes AND memory_broker_only = :yes', ExpressionAttributeValues: { ':yes': true } };

export interface SessionMetadata {
  readonly scheduledRuns?: ScheduledRunStore;
  /** Require verified retirement of old Chat dispatchers and the broker-only Memory cutover. */
  checkRuntimeNamespaceReady(): Promise<void>;
  /** Register a persistence writer against the deletion fences; release only after confirmed dispatch/completion. */
  beginDispatch(owner: string, sessionId: string, warmupFilingUserId?: string, acceptedTurn?: AcceptedDispatch): Promise<RegisteredDispatch>;
  /** Refuse deletion while another process may still dispatch or finish a persistence writer. */
  assertNoDispatch(session: SessionPurge, failedAdmissionTokens?: readonly string[]): Promise<void>;
  rejectedDispatches(session: SessionPurge, runtimeTarget?: string): Promise<RegisteredDispatch[]>;
  acknowledgeSuccessfulDispatch?(session: SessionPurge, token: string, kind: 'memory-event' | 'session-post'): Promise<void>;
  /** Durable fenced cleanup work, including work left by a replaced Chat Service task. */
  pendingPurges(): Promise<SessionPurge[]>;
  /** Acknowledge only after Runtime stop and durable event purge succeed. */
  completePurge(session: SessionPurge): Promise<void>;
  createMemoryLease(lease: TurnMemoryLease): Promise<void>;
  memoryLease(owner: string, jti: string): Promise<TurnMemoryLease | null>;
  endMemoryLease(owner: string, jti: string): Promise<void>;
  memorySessionActive(owner: string, sessionId: string, filingUserId: string): Promise<boolean>;
  /** Raise unless the table is active and readable. */
  checkHealth(): Promise<void>;
  /**
   * Create the Session's metadata on its first Turn and bump its last activity;
   * returns the user ID it is filed under. A Turn with a model `provider` records
   * it on the Session unless one is recorded. Throws SessionDeletedError when the
   * Session or its owner is deleted, SessionClaimError when its owner is transferring, and SessionProviderError when the Session
   * runs on another provider. A running Turn records its startedAt and runId together, and a `messageId`
   * becomes the Session's latest_message_id.
   */
  recordTurn(
    owner: string,
    sessionId: string,
    turn: { filingUserId: string; title: string; provider?: string; running?: RunningTurn; messageId?: string | undefined; warmup?: boolean | undefined; postAcceptance?: true | undefined },
  ): Promise<string>;
  /** Clear this running Turn's mark, and record why it failed, unless another run replaced it. */
  turnEnded(owner: string, sessionId: string, running: RunningTurn, failure: TurnFailure | undefined): Promise<void>;
  /**
   * Record why this Turn's summary failed, which runs on after its stream closed, unless another run
   * started since; the thread's next read returns it.
   */
  turnSummaryFailed(owner: string, sessionId: string, running: RunningTurn, failure: TurnFailure): Promise<void>;
  /** The Harness emitted RUN_STARTED for this Turn; it can now be stopped by run ID. */
  turnStarted(owner: string, sessionId: string, running: RunningTurn): Promise<void>;
  /**
   * Save a finished Turn, replacing any earlier row of it, under the Session's filing
   * user, which Account Claim keeps. Throws SessionDeletedError when the Session is missing
   * or fenced; fencing the Session deletes its Turns' rows.
   */
  saveTurnSummary(
    owner: string,
    turn: { sessionId: string; filingUserId: string; messageId: string },
    finished: TurnActivity,
  ): Promise<void>;
  /** The finished Turns of every Session filed under this user. */
  turnSummaries(filingUserId: string): Promise<StoredTurnSummary[]>;
  /** The owner's Sessions that are not fenced, newest activity first. */
  list(owner: string): Promise<SessionSummary[]>;
  /**
   * The ID of the owner's Main Chat, assigned on first use. It names a Session
   * that may have no Turns yet; every other Session is a Side Chat.
   */
  mainChat(owner: string, filingUserId: string): Promise<string>;
  /** Read only: recognize the assigned Main Chat before its first Turn without allocating; Session, owner deletion and Account Claim fences deny it. */
  ownsMainChat(owner: string, sessionId: string): Promise<boolean>;
  /** The owner's Session, unless it is fenced. */
  get(owner: string, sessionId: string): Promise<SessionSummary | null>;
  /**
   * Set the deletion fence on the owner's Session; null when the owner has no
   * such Session. Fencing a fenced Session keeps its first fence, so a repeated
   * delete can retry the purge.
   */
  fence(owner: string, sessionId: string): Promise<SessionSummary | null>;
  /**
   * Fence the account's history: the owner first, so no later Turn records a
   * Session, then every Session the account answers for (its own and those under
   * the retired IDs it gained through Account Claim), fenced ones included.
   */
  fenceOwner(owner: string): Promise<SessionSummary[]>;
  /**
   * Account Claim: the destination owns the source account's Sessions from now
   * on. Fence source Turn writes before the snapshot; failed transfers keep the
   * fence so their pinned Account Claim can retry. The source becomes a retired ID of the destination (recorded first), then
   * each Session's owner changes. Filing user IDs stay; no Session events move.
   * The source's Main Chat stays the Main Chat only when the destination has none.
   */
  transferOwner(source: string, destination: string): Promise<void>;
}

const OWNER = 'SESSIONS#';
const SESSION = 'SESSION#';
const RETIRED = 'RETIRED#';
const MAIN = 'MAIN';

const ownerPk = (owner: string) => `${OWNER}${owner}`;
const key = (owner: string, sessionId: string) => ({ pk: ownerPk(owner), sk: `${SESSION}${sessionId}` });
/** The tombstone that atomically fences an account's history writes after deletion. */
export const ownerFenceKey = (owner: string) => ({ pk: ownerPk(owner), sk: 'DELETED' });
const claimFenceKey = (owner: string) => ({ pk: ownerPk(owner), sk: 'CLAIM' });
const mainChatKey = (owner: string) => ({ pk: ownerPk(owner), sk: MAIN });
const turnSummariesPk = (filingUserId: string) => `TURN_SUMMARIES#${filingUserId}`;
const turnSummaryPrefix = (sessionId: string) => `${SESSION}${sessionId}#TURN#`;
const turnKey = ({ sessionId, filingUserId, messageId }: { sessionId: string; filingUserId: string; messageId: string }) => ({
  pk: turnSummariesPk(filingUserId),
  sk: `${turnSummaryPrefix(sessionId)}${messageId}`,
});

type SessionItem = SessionSummary & { pk: string; sk: string; deleted_at?: string; provider_pending?: true; purge_registered?: true };
const fenced = (item: SessionItem) => item.deleted_at !== undefined;

/** Only this writer's new model-less Sessions are unbound; older rows ran on Anthropic. */
function summaryOf(item: SessionItem): SessionSummary {
  const { provider_pending, ...summary } = item;
  return provider_pending ? summary : { ...summary, provider: summary.provider ?? 'anthropic' };
}

function providerWrite(provider: string | undefined, newUnbound: boolean) {
  if (provider === undefined) {
    return newUnbound
      ? { set: ', provider_pending = :pending', condition: ' AND attribute_not_exists(session_id)', values: { ':pending': true } }
      : { set: '', condition: '', values: {} };
  }
  return {
    set: ', provider = if_not_exists(provider, :provider)',
    condition: provider === 'anthropic'
      ? ' AND (attribute_not_exists(provider) OR provider = :provider)'
      : ' AND (provider = :provider OR (attribute_not_exists(provider) AND (attribute_not_exists(session_id) OR provider_pending = :pending)))',
    values: provider === 'anthropic' ? { ':provider': provider } : { ':provider': provider, ':pending': true },
  };
}

/** A relayed Turn: when it started, and its run ID, which a Stop names. */
export interface RunningTurn {
  startedAt: string;
  runId: string;
}

/** Marks the Session's Turn running, when the Turn has started, and names it the latest Turn. */
function runningWrite(running: RunningTurn | undefined, postAcceptance = false) {
  if (postAcceptance) return { set: '', remove: '', values: {} };
  return running === undefined
    ? { set: '', remove: ', turn_latest_run_id', values: {} }
    : {
        set: ', turn_running_since = :started_at, turn_run_id = :run_id, turn_latest_run_id = :run_id, turn_preparing = :preparing',
        remove: '',
        values: { ':started_at': running.startedAt, ':run_id': running.runId, ':preparing': true },
      };
}

function turnRemoval(runningRemoval: string, provider: string | undefined, postAcceptance = false): string {
  if (postAcceptance) return '';
  return ' REMOVE turn_failure' + runningRemoval + (provider === undefined ? '' : ', provider_pending');
}

function storedProvider(item: Record<string, AttributeValue> | undefined): string {
  return item?.provider?.S ?? 'anthropic';
}

/** The stored timestamp format: ISO 8601 with microseconds and a +00:00 offset. */
function now(): string {
  return new Date().toISOString().replace('Z', '000+00:00');
}

const PURGES = 'PURGES';
const purgeKey = ({ session_id, filing_user_id }: SessionPurge) => ({ pk: PURGES, sk: JSON.stringify([filing_user_id, session_id]) });

const dispatcherId = `${hostname()}:${process.pid}:${randomUUID()}`;
const dispatchKey = ({ session_id, filing_user_id }: SessionPurge, token: string) => ({ pk: `DISPATCH#${JSON.stringify([filing_user_id, session_id])}`, sk: token });

export class DynamoDBSessionMetadata implements SessionMetadata {
  readonly scheduledRuns: ScheduledRunStore;
  private readonly client: DynamoDBClient;
  private readonly documents: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client = new DynamoDBClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' }),
  ) {
    this.client = client;
    this.documents = DynamoDBDocumentClient.from(client);
    this.scheduledRuns = new ScheduledRunStore(tableName, client);
  }

  async checkRuntimeNamespaceReady(): Promise<void> {
    const { Item } = await this.documents.send(new GetCommand({
      TableName: this.tableName,
      Key: retirementKey,
      ConsistentRead: true,
    }));
    if (Item?.old_chat_retired !== true || Item.memory_broker_only !== true) throw new SessionNamespaceNotReadyError();
  }

  async pendingPurges(): Promise<SessionPurge[]> {
    // Older tasks could die after an owner fence or before a durable job existed.
    // Reconcile only unfinished rows; completion remains durable across discoveries.
    for await (const { Items } of paginateScan({ client: this.documents }, {
      TableName: this.tableName,
      FilterExpression: 'begins_with(pk, :owner) AND ((sk = :deleted AND attribute_not_exists(purge_reconciled)) OR (begins_with(sk, :session) AND attribute_exists(deleted_at) AND attribute_not_exists(purge_registered)))',
      ExpressionAttributeValues: { ':owner': OWNER, ':deleted': 'DELETED', ':session': SESSION },
      ConsistentRead: true,
    })) {
      for (const item of Items ?? []) {
        if (item.sk === 'DELETED') {
          // eslint-disable-next-line no-await-in-loop -- finish each interrupted account fence before returning its jobs
          await this.reconcileOwner(String(item.pk).slice(OWNER.length));
        } else {
          // eslint-disable-next-line no-await-in-loop -- persist each legacy fence's job before advancing the scan
          await this.registerLegacyPurge(item as SessionItem);
        }
      }
    }
    const pending: SessionPurge[] = [];
    const pages = paginateQuery({ client: this.documents }, {
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': PURGES },
      FilterExpression: 'attribute_not_exists(completed_at)',
      ConsistentRead: true,
    });
    for await (const page of pages) {
      for (const session of (page.Items ?? []) as SessionPurge[]) pending.push({ session_id: session.session_id, filing_user_id: session.filing_user_id, ...runtimeIdentity(session) });
    }
    return pending;
  }

  async completePurge(session: SessionPurge): Promise<void> {
    await this.assertNoDispatch(session);
    // A task can stop after committing the fence but before its synchronous
    // summary cleanup finishes; durable recovery must finish both records.
    await this.deleteTurnSummaries(session.filing_user_id, session.session_id);
    await this.documents.send(new UpdateCommand({
      TableName: this.tableName, Key: purgeKey(session),
      UpdateExpression: 'SET completed_at = if_not_exists(completed_at, :now)',
      ConditionExpression: 'session_id = :id AND filing_user_id = :filing',
      ExpressionAttributeValues: { ':now': now(), ':id': session.session_id, ':filing': session.filing_user_id },
    }));
  }

  private async registerLegacyPurge(item: SessionItem): Promise<void> {
    const job = { session_id: item.session_id, filing_user_id: item.filing_user_id, ...runtimeIdentity(item) };
    await this.documents.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: this.tableName, Key: { pk: item.pk, sk: item.sk },
        UpdateExpression: 'SET purge_registered = :registered',
        ConditionExpression: 'attribute_exists(deleted_at) AND filing_user_id = :filing',
        ExpressionAttributeValues: { ':registered': true, ':filing': item.filing_user_id },
      } },
      { Update: {
        TableName: this.tableName, Key: purgeKey(job),
        UpdateExpression: 'SET session_id = if_not_exists(session_id, :id), filing_user_id = if_not_exists(filing_user_id, :filing)' + (item.runtime_binding === undefined ? '' : ', runtime_binding = if_not_exists(runtime_binding, :binding)') + (item.runtime_generation === undefined ? '' : ', runtime_generation = if_not_exists(runtime_generation, :generation)') + (item.legacy_settlement_unproved === undefined ? '' : ', legacy_settlement_unproved = if_not_exists(legacy_settlement_unproved, :legacy)'),
        ExpressionAttributeValues: { ':id': item.session_id, ':filing': item.filing_user_id, ...(item.runtime_binding === undefined ? {} : { ':binding': item.runtime_binding }), ...(item.runtime_generation === undefined ? {} : { ':generation': item.runtime_generation }), ...(item.legacy_settlement_unproved === undefined ? {} : { ':legacy': item.legacy_settlement_unproved }) },
      } },
    ] }));
  }

  private async fenceAccount(owner: string, deletedAt: string): Promise<void> {
    try {
      await this.documents.send(new PutCommand({ TableName: this.tableName, Item: { ...ownerFenceKey(owner), deleted_at: deletedAt }, ConditionExpression: 'attribute_not_exists(pk)' }));
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  }

  private async retainLegacyMain(owner: string): Promise<string | null> {
    const main = await this.documents.send(new GetCommand({ TableName: this.tableName, Key: mainChatKey(owner), ConsistentRead: true }));
    if (main.Item === undefined || trackedRuntime(main.Item as SessionPurge)) return null;
    const sessionId = String(main.Item.session_id);
    const session = await this.documents.send(new GetCommand({ TableName: this.tableName, Key: key(owner, sessionId), ConsistentRead: true }));
    if (session.Item !== undefined) return null;
    await this.documents.send(new UpdateCommand({ TableName: this.tableName, Key: ownerFenceKey(owner),
      UpdateExpression: 'SET legacy_main_pending = :session', ConditionExpression: 'attribute_exists(deleted_at)',
      ExpressionAttributeValues: { ':session': sessionId },
    }));
    return sessionId;
  }

  private async reconcileOwner(owner: string): Promise<void> {
    const accounts = await this.answeringIds(owner);
    for (const account of accounts) {
      // eslint-disable-next-line no-await-in-loop -- all owner fences precede Session enumeration
      await this.documents.send(new UpdateCommand({
        TableName: this.tableName, Key: ownerFenceKey(account),
        UpdateExpression: 'SET deleted_at = if_not_exists(deleted_at, :now)',
        ExpressionAttributeValues: { ':now': now() },
      }));
    }
    for (const account of accounts) {
      // eslint-disable-next-line no-await-in-loop -- strongly consistent enumeration follows the durable owner fence
      for (const item of await this.query(account, SESSION)) {
        if (!fenced(item)) {
          // eslint-disable-next-line no-await-in-loop -- never acknowledge owner reconciliation before each Session fence persists
          await this.fence(account, item.session_id);
        } else if (item.purge_registered === undefined) {
          // eslint-disable-next-line no-await-in-loop -- preserve completion of previously registered Sessions
          await this.registerLegacyPurge(item);
        }
      }
      // eslint-disable-next-line no-await-in-loop -- an old warmup can have a Runtime without any Session metadata
      const legacyMain = await this.retainLegacyMain(account);
      if (legacyMain !== null) console.error(`Session purge failed; legacy Main Chat settlement remains pending. owner=${account} session_id=${legacyMain}`);
      // eslint-disable-next-line no-await-in-loop -- mark each owner only after all its Sessions have durable jobs
      await this.documents.send(new UpdateCommand({
        TableName: this.tableName, Key: ownerFenceKey(account),
        UpdateExpression: 'SET purge_reconciled = :complete',
        ExpressionAttributeValues: { ':complete': true },
      }));
    }
  }

  private async dispatchIdentity(owner: string, sessionId: string, warmupFilingUserId?: string, acceptedTurn?: AcceptedDispatch): Promise<{ dispatchOwner: string; session: SessionPurge; claimDestination: string | null }> {
    let claimDestination = acceptedTurn === undefined ? null : await this.claimDestination(owner);
    let transferred = claimDestination === null ? null : await this.get(claimDestination, sessionId);
    let existing = transferred ?? await this.get(owner, sessionId);
    if (existing === null && acceptedTurn !== undefined) {
      claimDestination ??= await this.claimDestination(owner);
      transferred = claimDestination === null ? null : await this.get(claimDestination, sessionId);
      existing = transferred;
    }
    const dispatchOwner = transferred === null ? owner : claimDestination ?? owner;
    const materializing = existing === null && warmupFilingUserId !== undefined;
    if (existing === null && warmupFilingUserId !== undefined) {
      await this.recordTurn(owner, sessionId, { filingUserId: warmupFilingUserId, title: '', warmup: true });
      existing = await this.get(owner, sessionId);
    }
    if (existing === null && warmupFilingUserId === undefined) throw new SessionDeletedError(sessionId);
    if (!materializing && existing !== null && warmupFilingUserId !== undefined && existing.filing_user_id !== warmupFilingUserId) throw new SessionDeletedError(sessionId);
    const filingUserId = existing?.filing_user_id ?? warmupFilingUserId;
    if (filingUserId === undefined) throw new SessionDeletedError(sessionId);
    return { dispatchOwner, session: { session_id: sessionId, filing_user_id: filingUserId, ...runtimeIdentity(existing ?? {}) }, claimDestination };
  }

  private dispatchProof(acceptedTurn?: AcceptedDispatch): { condition: string; values: Record<string, string> } {
    if (acceptedTurn === undefined) return { condition: '', values: {} };
    if ('messageId' in acceptedTurn) return { condition: ' AND latest_message_id = :message_id', values: { ':message_id': acceptedTurn.messageId } };
    return { condition: ' AND turn_running_since = :started_at AND turn_run_id = :run_id', values: { ':started_at': acceptedTurn.startedAt, ':run_id': acceptedTurn.runId } };
  }

  private dispatchConditions(acceptedTurn?: AcceptedDispatch): { claim: string; session: string } {
    if (acceptedTurn !== undefined) return {
      claim: 'attribute_not_exists(pk) OR attribute_exists(destination)',
      session: 'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND filing_user_id = :filing' + this.dispatchProof(acceptedTurn).condition,
    };
    return {
      claim: 'attribute_not_exists(pk)',
      session: 'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND filing_user_id = :filing',
    };
  }

  private dispatchClaimCondition(condition: string, destination: string | null): { ConditionExpression: string; ExpressionAttributeValues?: Record<string, string> } {
    return destination === null ? { ConditionExpression: condition } : { ConditionExpression: 'destination = :destination', ExpressionAttributeValues: { ':destination': destination } };
  }

  private async dispatchIdentityChanged(owner: string, sessionId: string, claimDestination: string | null): Promise<boolean> {
    if (claimDestination === null && await this.claimDestination(owner) !== null) return true;
    const transferred = await this.claimedSession(owner, sessionId);
    return transferred !== null && transferred.owner !== owner;
  }

  private dispatchSessionWrite(owner: string, session: SessionPurge, continuation: boolean, condition: string, acceptedTurn?: AcceptedDispatch): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
    const write = {
      TableName: this.tableName, Key: key(owner, session.session_id),
      ConditionExpression: condition,
      ExpressionAttributeValues: { ':filing': session.filing_user_id, ...this.dispatchProof(acceptedTurn).values },
    };
    if (!continuation) return { ConditionCheck: write };
    return { Update: {
      ...write,
      UpdateExpression: 'SET runtime_binding = :binding, runtime_generation = :generation, legacy_settlement_unproved = :legacy',
      ConditionExpression: condition + ' AND attribute_not_exists(runtime_binding) AND attribute_not_exists(runtime_generation)',
      ExpressionAttributeValues: { ...write.ExpressionAttributeValues, ':binding': session.runtime_binding, ':generation': session.runtime_generation, ':legacy': true },
    } };
  }

  private dispatchTransaction(owner: string, identity: { dispatchOwner: string; session: SessionPurge; claimDestination: string | null }, continuation: boolean, token: string, acceptedTurn?: AcceptedDispatch): TransactWriteCommandInput {
    const { dispatchOwner, session, claimDestination } = identity;
    const claimedTurn = claimDestination === null ? undefined : acceptedTurn;
    const conditions = this.dispatchConditions(claimedTurn);
    const fencedOwner = claimDestination ?? dispatchOwner;
    return { TransactItems: [
      { ConditionCheck: { TableName: this.tableName, Key: ownerFenceKey(owner), ConditionExpression: 'attribute_not_exists(pk)' } },
      { ConditionCheck: { TableName: this.tableName, Key: claimFenceKey(dispatchOwner),
        ...this.dispatchClaimCondition(conditions.claim, dispatchOwner === owner ? claimDestination : null),
      } },
      this.dispatchSessionWrite(dispatchOwner, session, continuation, conditions.session, claimedTurn),
      { Put: { TableName: this.tableName, Item: { ...dispatchKey(session, token), ...session, dispatcher: dispatcherId, created_at: now() } } },
      ...(continuation ? [{ ConditionCheck: { TableName: this.tableName, Key: retirementKey, ...retirementCondition } }] : []),
      ...(fencedOwner === owner ? [] : [{ ConditionCheck: { TableName: this.tableName, Key: ownerFenceKey(fencedOwner), ConditionExpression: 'attribute_not_exists(pk)' } }]),
    ] };
  }

  private async retryDispatch(error: unknown, owner: string, identity: { dispatchOwner: string; session: SessionPurge; claimDestination: string | null }, continuation: boolean, acceptedTurn?: AcceptedDispatch): Promise<boolean> {
    const { dispatchOwner, session, claimDestination } = identity;
    const reasons = (error as Partial<TransactionCanceledException>).CancellationReasons;
    if (continuation && reasons?.[2]?.Code === 'ConditionalCheckFailed') {
      const winner = await this.get(dispatchOwner, session.session_id);
      if (winner !== null && boundRuntime(winner)) return true;
    }
    if (continuation && reasons?.[4]?.Code === 'ConditionalCheckFailed') throw new SessionNamespaceNotReadyError();
    const admissionChanged = [reasons?.[1], reasons?.[2]].some((reason) => reason?.Code === 'ConditionalCheckFailed');
    if (acceptedTurn !== undefined && dispatchOwner === owner && admissionChanged) {
      if (await this.dispatchIdentityChanged(owner, session.session_id, claimDestination)) return true;
    }
    if (reasons?.[1]?.Code === 'ConditionalCheckFailed') throw new SessionClaimError(owner);
    if ([reasons?.[0], reasons?.[2], reasons?.[continuation ? 5 : 4]].some((reason) => reason?.Code === 'ConditionalCheckFailed')) throw new SessionDeletedError(session.session_id);
    throw error;
  }

  async beginDispatch(owner: string, sessionId: string, warmupFilingUserId?: string, acceptedTurn?: AcceptedDispatch): Promise<RegisteredDispatch> {
    const identity = await this.dispatchIdentity(owner, sessionId, warmupFilingUserId, acceptedTurn);
    const { session } = identity;
    const continuation = session.runtime_binding === undefined && session.runtime_generation === undefined;
    if (!continuation && !boundRuntime(session)) throw new SessionDispatchPendingError('Session Runtime binding is unproved');
    if (continuation) Object.assign(session, { runtime_binding: `runtime-${randomUUID()}`, runtime_generation: 'continuation-v1', legacy_settlement_unproved: true });
    const token = randomUUID();
    try {
      await this.documents.send(new TransactWriteCommand(this.dispatchTransaction(owner, identity, continuation, token, acceptedTurn)));
    } catch (error) {
      if (await this.retryDispatch(error, owner, identity, continuation, acceptedTurn)) return this.beginDispatch(owner, sessionId, warmupFilingUserId, acceptedTurn);
    }
    // No TTL: a paused dispatcher must never resume after an expired registration permits deletion.
    return this.dispatchAcknowledgement(session, token);
  }

  private dispatchAcknowledgement(session: SessionPurge, token: string, recovered = false, stopped = false, runtimeTarget?: string): RegisteredDispatch {
    const Key = dispatchKey(session, token);
    const binding = { ':binding': session.runtime_binding, ':generation': session.runtime_generation };
    const complete: RegisteredDispatch = Object.assign(async () => {
      await this.documents.send(new DeleteCommand({ TableName: this.tableName, Key,
        ...(recovered ? { ConditionExpression: 'attribute_not_exists(pk) OR (rejected_runtime_binding = :binding AND rejected_runtime_generation = :generation AND rejected_runtime_target = :target AND runtime_stop_confirmed = :binding)', ExpressionAttributeValues: { ...binding, ':target': runtimeTarget } } : {}),
      }));
    }, { session, token, stopConfirmed: stopped });
    complete.markSucceeded = async (kind, completion) => {
      const Update = { TableName: this.tableName, Key,
        UpdateExpression: 'SET writer_succeeded = :kind',
        ConditionExpression: 'dispatcher = :dispatcher AND session_id = :session AND filing_user_id = :filing AND runtime_binding = :binding AND runtime_generation = :generation',
        ExpressionAttributeValues: { ...binding, ':dispatcher': dispatcherId, ':session': session.session_id, ':filing': session.filing_user_id, ':kind': kind },
      };
      if (completion === undefined) {
        await this.documents.send(new UpdateCommand(Update));
        return;
      }
      if (kind !== 'session-post' || completion.Update?.TableName !== this.tableName) throw new SessionDispatchPendingError('Successful writer completion transaction is invalid');
      await this.documents.send(new TransactWriteCommand({ TransactItems: [{ Update }, completion] }));
    };
    complete.markRejected = async (target) => {
      await this.documents.send(new UpdateCommand({ TableName: this.tableName, Key,
        UpdateExpression: 'SET rejected_runtime_binding = :binding, rejected_runtime_generation = :generation, rejected_runtime_target = :target',
        ConditionExpression: 'dispatcher = :dispatcher AND attribute_exists(pk)',
        ExpressionAttributeValues: { ...binding, ':dispatcher': dispatcherId, ':target': target },
      }));
      runtimeTarget = target;
    };
    complete.confirmStopped = async () => {
      if (runtimeTarget === undefined) throw new SessionDispatchPendingError('Rejected Runtime target is unproved');
      await this.confirmDispatchStop(Key, { ...binding, ':target': runtimeTarget });
      complete.stopConfirmed = true;
    };
    return complete;
  }

  private async confirmDispatchStop(Key: ReturnType<typeof dispatchKey>, binding: { ':binding': string | undefined; ':generation': string | undefined; ':target': string }): Promise<void> {
    try {
      await this.documents.send(new UpdateCommand({ TableName: this.tableName, Key,
        UpdateExpression: 'SET runtime_stop_confirmed = :binding',
        ConditionExpression: 'rejected_runtime_binding = :binding AND rejected_runtime_generation = :generation AND rejected_runtime_target = :target',
        ExpressionAttributeValues: binding,
      }));
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
      if (Item !== undefined) throw error;
    }
  }

  async rejectedDispatches(session: SessionPurge, runtimeTarget?: string): Promise<RegisteredDispatch[]> {
    if (!trackedRuntime(session) || runtimeTarget === undefined) return [];
    const rows = await this.queryPartition(dispatchKey(session, '').pk) as unknown as {
      sk: string; rejected_runtime_binding?: string; rejected_runtime_generation?: string; rejected_runtime_target?: string; runtime_stop_confirmed?: string;
    }[];
    return rows.filter((row) => row.rejected_runtime_binding === session.runtime_binding && row.rejected_runtime_generation === session.runtime_generation && row.rejected_runtime_target === runtimeTarget)
      .map((row) => this.dispatchAcknowledgement(session, row.sk, true, row.runtime_stop_confirmed === session.runtime_binding, runtimeTarget));
  }

  async acknowledgeSuccessfulDispatch(session: SessionPurge, token: string, kind: 'memory-event' | 'session-post'): Promise<void> {
    if (!boundRuntime(session) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(token)) throw new SessionDispatchPendingError('Successful writer identity is unproved');
    const Key = dispatchKey(session, token);
    const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
    if (Item === undefined) return;
    if (Item.session_id !== session.session_id || Item.filing_user_id !== session.filing_user_id ||
      Item.runtime_binding !== session.runtime_binding || Item.runtime_generation !== session.runtime_generation || Item.writer_succeeded !== kind) {
      throw new SessionDispatchPendingError('Successful writer settlement is unproved');
    }
    await this.documents.send(new DeleteCommand({ TableName: this.tableName, Key,
      ConditionExpression: 'attribute_not_exists(pk) OR (session_id = :session AND filing_user_id = :filing AND runtime_binding = :binding AND runtime_generation = :generation AND writer_succeeded = :kind)',
      ExpressionAttributeValues: { ':session': session.session_id, ':filing': session.filing_user_id, ':binding': session.runtime_binding, ':generation': session.runtime_generation, ':kind': kind },
    }));
  }

  private async acknowledgeSuccessfulWriters(session: SessionPurge, pk: string): Promise<void> {
    const rows = await this.queryPartition(pk) as unknown as {
      sk: string; session_id?: string; filing_user_id?: string; runtime_binding?: string; runtime_generation?: string; writer_succeeded?: string;
    }[];
    await Promise.all(rows.filter((row) =>
      (row.writer_succeeded === 'memory-event' || row.writer_succeeded === 'session-post') &&
      row.session_id === session.session_id && row.filing_user_id === session.filing_user_id &&
      row.runtime_binding === session.runtime_binding && row.runtime_generation === session.runtime_generation &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.sk)
    ).map((row) => this.acknowledgeSuccessfulDispatch(session, row.sk, row.writer_succeeded as 'memory-event' | 'session-post')));
  }

  async assertNoDispatch(session: SessionPurge, failedAdmissionTokens: readonly string[] = []): Promise<void> {
    if (!trackedRuntime(session)) throw new SessionDispatchPendingError(`Session legacy settlement is unproved; deletion remains pending. session_id=${session.session_id} filing_user_id=${session.filing_user_id}`);
    await this.acknowledgeSuccessfulWriters(session, dispatchKey(session, '').pk);
    // Older tasks registered only the public Session ID. Until those tasks are
    // quiescent, absence of the new namespaced row cannot prove deletion is safe.
    for (const pk of [dispatchKey(session, '').pk, `DISPATCH#${session.session_id}`]) {
      // eslint-disable-next-line no-await-in-loop -- check both registry generations before allowing purge
      const items: { sk: string; dispatcher?: string }[] = await this.queryPartition(pk);
      const pending = items.find((item) => pk !== dispatchKey(session, '').pk || !failedAdmissionTokens.includes(item.sk));
      if (pending !== undefined) throw new SessionDispatchPendingError(`Session dispatch is still registered; deletion is blocked. session_id=${session.session_id} filing_user_id=${session.filing_user_id} registration=${String(pending.sk)} dispatcher=${String(pending.dispatcher)}`);
    }
  }

  async createMemoryLease(lease: TurnMemoryLease): Promise<void> {
    await this.documents.send(new PutCommand({
      TableName: this.tableName,
      Item: { pk: `TURN_MEMORY#${lease.owner}`, sk: `TURN#${lease.jti}`, ...lease },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }

  async memoryLease(owner: string, jti: string): Promise<TurnMemoryLease | null> {
    const { Item } = await this.documents.send(new GetCommand({
      TableName: this.tableName, Key: { pk: `TURN_MEMORY#${owner}`, sk: `TURN#${jti}` }, ConsistentRead: true,
    }));
    return Item === undefined ? null : Item as TurnMemoryLease;
  }

  async endMemoryLease(owner: string, jti: string): Promise<void> {
    await this.documents.send(new DeleteCommand({
      TableName: this.tableName, Key: { pk: `TURN_MEMORY#${owner}`, sk: `TURN#${jti}` },
    }));
  }

  async memorySessionActive(owner: string, sessionId: string, filingUserId: string): Promise<boolean> {
    const [session, deleted, claim] = await Promise.all([
      this.get(owner, sessionId),
      this.documents.send(new GetCommand({ TableName: this.tableName, Key: ownerFenceKey(owner), ConsistentRead: true })),
      this.documents.send(new GetCommand({ TableName: this.tableName, Key: claimFenceKey(owner), ConsistentRead: true })),
    ]);
    return session?.filing_user_id === filingUserId && deleted.Item === undefined && claim.Item === undefined;
  }

  async checkHealth(): Promise<void> {
    const { Table } = await this.client.send(new DescribeTableCommand({ TableName: this.tableName }));
    if (Table?.TableStatus !== 'ACTIVE') {
      throw new Error('Session Metadata table is not active');
    }
    await this.documents.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: 'HEALTH', sk: 'PROBE' }, ConsistentRead: true }),
    );
  }

  private async turnIdentity(owner: string, sessionId: string, filingUserId: string) {
    const creating = (await this.get(owner, sessionId)) === null;
    if (!creating) return { creating, filing: filingUserId, binding: undefined };
    const main = await this.mainIdentity(owner, sessionId);
    if (main?.Item?.session_id !== sessionId) return { creating, filing: filingUserId, binding: `runtime-${randomUUID()}` };
    const filing = typeof main.Item.filing_user_id === 'string' ? main.Item.filing_user_id : filingUserId;
    const binding = trackedRuntime(main.Item as SessionPurge) ? String(main.Item.runtime_binding) : undefined;
    return { creating, filing, binding };
  }

  async recordTurn(
    owner: string,
    sessionId: string,
    {
      filingUserId,
      title,
      provider,
      running,
      messageId,
      warmup,
      postAcceptance,
    }: { filingUserId: string; title: string; provider?: string | undefined; running?: RunningTurn | undefined; messageId?: string | undefined; warmup?: boolean | undefined; postAcceptance?: true | undefined },
  ): Promise<string> {
    const { creating, binding, filing } = await this.turnIdentity(owner, sessionId, filingUserId);
    filingUserId = filing;
    const newUnbound = provider === undefined && creating;
    const providerUpdate = providerWrite(provider, newUnbound);
    const runningUpdate = runningWrite(running, postAcceptance);
    try {
      await this.documents.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: ownerFenceKey(owner),
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: key(owner, sessionId),
                UpdateExpression:
                  'SET session_id = :session_id, updated_at = :now, ' +
                  'created_at = if_not_exists(created_at, :now), ' +
                  (warmup ? '' : 'title = if_not_exists(title, :title), ') +
                  'filing_user_id = if_not_exists(filing_user_id, :filing_user_id)' +
                  (binding === undefined ? '' : ', runtime_binding = :binding, runtime_generation = :generation') +
                  (messageId === undefined ? '' : ', latest_message_id = :latest_message_id') +
                  runningUpdate.set +
                  providerUpdate.set + turnRemoval(runningUpdate.remove, provider, postAcceptance),
                ConditionExpression: turnAdmissionCondition(creating, providerUpdate.condition),
                ExpressionAttributeValues: {
                  ':session_id': sessionId,
                  ':now': now(),
                  ...(warmup ? {} : { ':title': title }),
                  ...(binding === undefined ? {} : { ':binding': binding, ':generation': 'tracked-v1' }),
                  ':filing_user_id': filingUserId,
                  ...(messageId === undefined ? {} : { ':latest_message_id': messageId }),
                  ...runningUpdate.values,
                  ...providerUpdate.values,
                },
                ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
              },
            },
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: claimFenceKey(owner),
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            ...(binding === undefined ? [] : [{ ConditionCheck: { TableName: this.tableName, Key: retirementKey, ...retirementCondition } }]),
          ],
        }),
      );
    } catch (error) {
      if ((error as Partial<TransactionCanceledException>).CancellationReasons?.[3]?.Code === 'ConditionalCheckFailed') throw new SessionNamespaceNotReadyError();
      if (retryUnboundTurn(error, sessionId, creating && compatibleAdmission(error, provider))) {
        return this.recordTurn(owner, sessionId, { filingUserId, title, provider, running, messageId, warmup, postAcceptance });
      }
    }
    return this.acceptedFilingUserId(owner, sessionId);
  }

  private async acceptedFilingUserId(owner: string, sessionId: string): Promise<string> {
    const { Item } = await this.documents.send(
      new GetCommand({ TableName: this.tableName, Key: key(owner, sessionId), ConsistentRead: true }),
    );
    if (Item !== undefined) return (Item as SessionSummary).filing_user_id;
    // Claim may move an accepted Turn's row before this read. Recover the
    // stored filing ID from its pinned destination, never the new Turn's hint.
    const transferred = await this.claimedSession(owner, sessionId);
    if (transferred !== null) return transferred.session.filing_user_id;
    throw new Error('Session metadata missing after accepted Turn');
  }

  async turnStarted(owner: string, sessionId: string, running: RunningTurn): Promise<void> {
    await this.updateRunningMark(owner, sessionId, running, 'REMOVE turn_preparing');
  }

  async turnEnded(owner: string, sessionId: string, running: RunningTurn, failure: TurnFailure | undefined): Promise<void> {
    try {
      await this.updateRunningMark(
        owner,
        sessionId,
        running,
        `REMOVE turn_running_since, turn_run_id, turn_preparing${failure === undefined ? '' : ' SET turn_failure = :failure'}`,
        failure === undefined ? {} : { ':failure': { ...failure, runId: running.runId } },
      );
    } catch (error) {
      // A newer Turn's mark, or none: that Turn clears its own.
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  }

  async turnSummaryFailed(owner: string, sessionId: string, running: RunningTurn, failure: TurnFailure): Promise<void> {
    try {
      await this.updateRunningMark(
        owner,
        sessionId,
        running,
        'SET turn_failure = :failure',
        { ':failure': { ...failure, runId: running.runId } },
        // Still the latest Turn, running or ended: the summary can fail on either side of turnEnded.
        'attribute_exists(pk) AND attribute_not_exists(deleted_at) AND turn_latest_run_id = :run_id AND (attribute_not_exists(turn_running_since) OR turn_running_since = :started_at)',
      );
    } catch (error) {
      // A newer Turn: its own outcome replaces this one.
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  }

  private async updateRunningMark(
    owner: string,
    sessionId: string,
    running: RunningTurn,
    expression: string,
    values: Record<string, unknown> = {},
    condition = 'turn_running_since = :started_at AND turn_run_id = :run_id AND attribute_not_exists(deleted_at)',
  ): Promise<void> {
    const update = (currentOwner: string) => this.documents.send(new UpdateCommand({
      TableName: this.tableName,
      Key: key(currentOwner, sessionId),
      UpdateExpression: expression,
      ConditionExpression: condition,
      ExpressionAttributeValues: { ':started_at': running.startedAt, ':run_id': running.runId, ...values },
    }));
    try {
      await update(owner);
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException) || await this.get(owner, sessionId) !== null) throw error;
      // Claim can move an accepted Turn before either callback. Follow its pinned destination;
      // conditional writes still reject deletion or a newer Turn, and never create a row.
      const claim = await this.documents.send(new GetCommand({ TableName: this.tableName, Key: claimFenceKey(owner), ConsistentRead: true }));
      const destination = claim.Item?.destination;
      if (typeof destination !== 'string' || await this.get(destination, sessionId) === null) throw error;
      await update(destination);
    }
  }

  async saveTurnSummary(
    owner: string,
    turn: { sessionId: string; filingUserId: string; messageId: string },
    finished: TurnActivity,
  ): Promise<void> {
    const { request, completedAt, summary, failed } = finished;
    await this.writeTurn(owner, turn, {
      Put: {
        TableName: this.tableName,
        Item: {
          ...turnKey(turn),
          session_id: turn.sessionId,
          message_id: turn.messageId,
          request,
          completed_at: completedAt,
          ...summary,
          ...(failed === undefined ? {} : { failed }),
        },
      },
    }).catch(async (error: unknown) => {
      if (error instanceof SessionDeletedError) {
        const transferred = await this.claimedSession(owner, turn.sessionId);
        if (transferred !== null && transferred.session.filing_user_id === turn.filingUserId) {
          return this.saveTurnSummary(transferred.owner, turn, finished);
        }
      }
      throw error;
    });
  }

  /**
   * The Activity backfill: add a Turn's request and completion time to its row,
   * creating the row when the Turn has none, and keeping any values the row holds, so a
   * repeated backfill changes nothing. Refuses as saveTurnSummary does.
   */
  async backfillTurn(
    owner: string,
    turn: { sessionId: string; filingUserId: string; messageId: string },
    { request, completedAt }: Pick<TurnActivity, 'request' | 'completedAt'>,
  ): Promise<void> {
    await this.writeTurn(owner, turn, {
      Update: {
        TableName: this.tableName,
        Key: turnKey(turn),
        UpdateExpression:
          'SET session_id = :session, message_id = :message, ' +
          '#request = if_not_exists(#request, :request), completed_at = if_not_exists(completed_at, :completed)',
        ExpressionAttributeNames: { '#request': 'request' },
        ExpressionAttributeValues: {
          ':session': turn.sessionId,
          ':message': turn.messageId,
          ':request': request,
          ':completed': completedAt,
        },
      },
    });
  }

  /** Every owner's Sessions that are not fenced: what the Activity backfill reads. */
  async allSessions(): Promise<{ owner: string; session: SessionSummary }[]> {
    const sessions: { owner: string; session: SessionSummary }[] = [];
    const pages = paginateScan(
      { client: this.documents },
      {
        TableName: this.tableName,
        FilterExpression: 'begins_with(pk, :owner) AND begins_with(sk, :session)',
        ExpressionAttributeValues: { ':owner': OWNER, ':session': SESSION },
        ConsistentRead: true,
      },
    );
    for await (const page of pages) {
      for (const item of page.Items as SessionItem[]) {
        if (!fenced(item) && item.title !== undefined) sessions.push({ owner: item.pk.slice(OWNER.length), session: summaryOf(item) });
      }
    }
    return sessions;
  }

  /** Write a Turn's row unless its Session is missing or fenced, or its owner is. */
  private async writeTurn(
    owner: string,
    { sessionId }: { sessionId: string },
    write: NonNullable<NonNullable<TransactWriteCommandInput['TransactItems']>[number]>,
  ): Promise<void> {
    try {
      await this.documents.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: ownerFenceKey(owner),
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: key(owner, sessionId),
                ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleted_at)',
              },
            },
            write,
          ],
        }),
      );
    } catch (error) {
      throw fenceRefusal(error, sessionId);
    }
  }

  async turnSummaries(filingUserId: string): Promise<StoredTurnSummary[]> {
    const items = (await this.queryPartition(turnSummariesPk(filingUserId), SESSION)) as unknown as StoredTurnSummary[];
    return items.map(({ session_id, message_id, request, completed_at, title, summary, failed }) => ({
      session_id,
      message_id,
      ...(request === undefined ? {} : { request }),
      ...(completed_at === undefined ? {} : { completed_at }),
      ...(title === undefined ? {} : { title }),
      ...(summary === undefined ? {} : { summary }),
      ...(failed === undefined ? {} : { failed }),
    }));
  }

  async list(owner: string): Promise<SessionSummary[]> {
    return (await this.query(owner, SESSION))
      .filter((item) => !fenced(item) && item.title !== undefined)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(summaryOf);
  }

  async get(owner: string, sessionId: string): Promise<SessionSummary | null> {
    const { Item } = await this.documents.send(
      new GetCommand({ TableName: this.tableName, Key: key(owner, sessionId), ConsistentRead: true }),
    );
    return Item === undefined || fenced(Item as SessionItem) ? null : summaryOf(Item as SessionItem);
  }

  private async claimDestination(owner: string): Promise<string | null> {
    const { Item } = await this.documents.send(
      new GetCommand({ TableName: this.tableName, Key: claimFenceKey(owner), ConsistentRead: true }),
    );
    return typeof Item?.destination === 'string' ? Item.destination : null;
  }

  /** A live Session moved by the Account Claim pinned to this source. */
  private async claimedSession(owner: string, sessionId: string): Promise<Readonly<{ owner: string; session: SessionSummary }> | null> {
    const destination = await this.claimDestination(owner);
    if (destination === null) return null;
    const session = await this.get(destination, sessionId);
    return session === null ? null : { owner: destination, session };
  }

  async ownsMainChat(owner: string, sessionId: string): Promise<boolean> {
    if (await this.mainChatId(owner) !== sessionId) return false;
    const [session, deleted, claim] = await Promise.all([
      this.documents.send(new GetCommand({ TableName: this.tableName, Key: key(owner, sessionId), ConsistentRead: true })),
      this.documents.send(new GetCommand({ TableName: this.tableName, Key: ownerFenceKey(owner), ConsistentRead: true })),
      this.documents.send(new GetCommand({ TableName: this.tableName, Key: claimFenceKey(owner), ConsistentRead: true })),
    ]);
    return (session.Item === undefined || !fenced(session.Item as SessionItem)) && deleted.Item === undefined && claim.Item === undefined;
  }

  async mainChat(owner: string, filingUserId: string): Promise<string> {
    const assigned = await this.mainChatId(owner);
    if (assigned !== null) return assigned;
    await this.assignMainChatIfAbsent(owner, randomUUID(), undefined, filingUserId);
    return (await this.mainChatId(owner)) as string;
  }

  async fence(owner: string, sessionId: string): Promise<SessionSummary | null> {
    const fenced = await this.setFence(owner, sessionId);
    if (fenced === null) return null;
    await this.deleteTurnSummaries(fenced.filing_user_id, sessionId);
    return fenced;
  }

  private async deleteTurnSummaries(filingUserId: string, sessionId: string): Promise<void> {
    const summaries = await this.queryPartition(turnSummariesPk(filingUserId), turnSummaryPrefix(sessionId));
    // A longer Session ID can share the prefix.
    for (const { pk, sk } of summaries.filter((item) => item.session_id === sessionId)) {
      // eslint-disable-next-line no-await-in-loop -- stops at the first failure; deleting again retries
      await this.documents.send(new DeleteCommand({ TableName: this.tableName, Key: { pk, sk } }));
    }
  }

  private async setFence(owner: string, sessionId: string): Promise<SessionSummary | null> {
    const { Item } = await this.documents.send(
      new GetCommand({ TableName: this.tableName, Key: key(owner, sessionId), ConsistentRead: true }),
    );
    if (Item === undefined) return null;
    const deletedAt = now();
    try {
      await this.documents.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: this.tableName, Key: key(owner, sessionId),
          UpdateExpression: 'SET deleted_at = if_not_exists(deleted_at, :now), purge_registered = :registered REMOVE title',
          ConditionExpression: 'attribute_exists(pk) AND session_id = :id AND filing_user_id = :filing',
          ExpressionAttributeValues: { ':now': deletedAt, ':id': sessionId, ':filing': Item.filing_user_id, ':registered': true },
        } },
        { Put: { TableName: this.tableName, Item: { ...purgeKey({ session_id: sessionId, filing_user_id: Item.filing_user_id }), session_id: sessionId, filing_user_id: Item.filing_user_id, ...runtimeIdentity(Item as SessionPurge) } } },
      ] }));
      const { Item: fencedItem } = await this.documents.send(
        new GetCommand({ TableName: this.tableName, Key: key(owner, sessionId), ConsistentRead: true }),
      );
      if (fencedItem === undefined) throw new Error('The fenced Session disappeared before its acknowledgement');
      return summaryOf(fencedItem as SessionItem);
    } catch (error) {
      const reasons = (error as Partial<TransactionCanceledException>).CancellationReasons;
      if (reasons?.[0]?.Code === 'ConditionalCheckFailed') return null;
      throw error;
    }
  }

  async fenceOwner(owner: string): Promise<SessionSummary[]> {
    const deletedAt = now();
    const accounts = await this.answeringIds(owner);
    // Persist the root first: only it links all retired IDs for replacement-task recovery.
    for (const account of [owner, ...accounts.filter((account) => account !== owner)]) {
      // eslint-disable-next-line no-await-in-loop -- stops at the first failure without sending the rest
      await this.fenceAccount(account, deletedAt);
    }
    const fencedSessions: SessionSummary[] = [];
    for (const account of accounts) {
      // eslint-disable-next-line no-await-in-loop -- stops at the first failure without sending the rest
      for (const item of await this.query(account, SESSION)) {
        // eslint-disable-next-line no-await-in-loop -- stops at the first failure without sending the rest
        const result = await this.fence(item.pk.slice(OWNER.length), item.session_id);
        if (result !== null) fencedSessions.push(result);
      }
    }
    for (const account of accounts) {
      // eslint-disable-next-line no-await-in-loop -- preserve each unresolved original owner's Main Chat admission
      const legacyMain = await this.retainLegacyMain(account);
      if (legacyMain !== null) throw new SessionDispatchPendingError(`Session legacy settlement is unproved; Main Chat ${legacyMain} has no original filing metadata and account history deletion remains pending`);
    }
    return fencedSessions;
  }

  async transferOwner(source: string, destination: string): Promise<void> {
    for (const item of (await this.query(source, SESSION)).filter((item) => !fenced(item))) {
      // eslint-disable-next-line no-await-in-loop -- checks every Session before any write and stops at the first conflict
      if ((await this.get(destination, item.session_id)) !== null) {
        throw new Error('destination already owns this Session ID');
      }
    }
    // A failed transfer keeps this fence: the pinned Account Claim can retry,
    // while new source Turns cannot leave history behind its snapshot.
    await this.documents.send(new PutCommand({
      TableName: this.tableName,
      Item: { ...claimFenceKey(source), destination },
      ConditionExpression: 'attribute_not_exists(pk) OR destination = :destination',
      ExpressionAttributeValues: { ':destination': destination },
    }));
    const sessions = (await this.query(source, SESSION)).filter((item) => !fenced(item));
    await this.documents.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: ownerPk(destination), sk: `${RETIRED}${source}`, retired_id: source },
      }),
    );
    for (const item of sessions) {
      // eslint-disable-next-line no-await-in-loop -- stop at the first failed Session transfer
      await this.transferSession(source, destination, item);
    }
    const sourceMainChat = await this.mainChatId(source);
    if (sourceMainChat === null) return;
    // The destination keeps its own Main Chat; the source's becomes a Side Chat.
    const sourceMain = await this.documents.send(new GetCommand({ TableName: this.tableName, Key: mainChatKey(source), ConsistentRead: true }));
    await this.assignMainChatIfAbsent(destination, sourceMainChat, sourceMain.Item as SessionPurge);
  }

  private async transferSession(source: string, destination: string, item: SessionItem): Promise<void> {
    const identity = runtimeIdentity(item);
    const conditions = ['attribute_exists(pk)', 'attribute_not_exists(deleted_at)'];
    const values: Record<string, unknown> = {};
    for (const field of ['runtime_binding', 'runtime_generation', 'legacy_settlement_unproved'] as const) {
      if (identity[field] === undefined) conditions.push(`attribute_not_exists(${field})`);
      else {
        conditions.push(`${field} = :${field}`);
        values[`:${field}`] = identity[field];
      }
    }
    try {
      await this.documents.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { ...item, ...key(destination, item.session_id) }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Delete: { TableName: this.tableName, Key: key(source, item.session_id), ConditionExpression: conditions.join(' AND '),
          ...(Object.keys(values).length === 0 ? {} : { ExpressionAttributeValues: values }),
        } },
      ] }));
    } catch (error) {
      const reasons = (error as Partial<TransactionCanceledException>).CancellationReasons;
      if (reasons?.[1]?.Code !== 'ConditionalCheckFailed') throw error;
      const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key: key(source, item.session_id), ConsistentRead: true }));
      if (Item === undefined || fenced(Item as SessionItem)) throw error;
      if (JSON.stringify(runtimeIdentity(Item as SessionItem)) === JSON.stringify(identity)) throw error;
      await this.transferSession(source, destination, Item as SessionItem);
    }
  }

  private async mainChatId(owner: string): Promise<string | null> {
    const { Item } = await this.documents.send(
      new GetCommand({ TableName: this.tableName, Key: mainChatKey(owner), ConsistentRead: true }),
    );
    return Item === undefined ? null : (Item as { session_id: string }).session_id;
  }

  private async mainIdentity(owner: string, sessionId: string) {
    for (const original of [owner, ...(await this.answeringIds(owner)).filter((id) => id !== owner)]) {
      // eslint-disable-next-line no-await-in-loop -- read each immutable original Main Chat identity after Claim
      const main = await this.documents.send(new GetCommand({ TableName: this.tableName, Key: mainChatKey(original), ConsistentRead: true }));
      if (main.Item?.session_id !== sessionId) continue;
      if (!trackedRuntime(main.Item as SessionPurge) && main.Item.filing_user_id === undefined) throw new SessionDispatchPendingError('Session legacy settlement is unproved; original Main Chat filing identity is unknown');
      return main;
    }
    return undefined;
  }

  private async assignMainChatIfAbsent(owner: string, sessionId: string, inherited?: SessionPurge, filingUserId?: string): Promise<void> {
    if (inherited !== undefined) {
      const deleted = await this.documents.send(new GetCommand({ TableName: this.tableName, Key: ownerFenceKey(owner), ConsistentRead: true }));
      if (deleted.Item !== undefined) return;
    }
    const binding = inherited === undefined
      ? { runtime_binding: `runtime-${randomUUID()}`, runtime_generation: 'tracked-v1' }
      : runtimeIdentity(inherited);
    const filing = inherited?.filing_user_id ?? filingUserId;
    const createdAt = now();
    try {
      await this.documents.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { ...mainChatKey(owner), session_id: sessionId, ...binding, ...(filing === undefined ? {} : { filing_user_id: filing }) }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { ConditionCheck: { TableName: this.tableName, Key: ownerFenceKey(owner), ConditionExpression: 'attribute_not_exists(pk)' } },
        { ConditionCheck: { TableName: this.tableName, Key: claimFenceKey(owner), ConditionExpression: 'attribute_not_exists(pk)' } },
        ...(inherited === undefined ? [
          { ConditionCheck: { TableName: this.tableName, Key: retirementKey, ...retirementCondition } },
          { Put: { TableName: this.tableName, Item: { ...key(owner, sessionId), session_id: sessionId, filing_user_id: filing, ...binding, created_at: createdAt, updated_at: createdAt, provider_pending: true }, ConditionExpression: 'attribute_not_exists(pk)' } },
        ] : []),
      ] }));
    } catch (error) {
      const reasons = (error as Partial<TransactionCanceledException>).CancellationReasons;
      if (reasons?.[1]?.Code === 'ConditionalCheckFailed') throw new SessionDeletedError(sessionId);
      if (reasons?.[2]?.Code === 'ConditionalCheckFailed') throw new SessionClaimError(sessionId);
      if (reasons?.[0]?.Code === 'ConditionalCheckFailed') return;
      if (reasons?.[3]?.Code === 'ConditionalCheckFailed') throw new SessionNamespaceNotReadyError();
      throw error;
    }
  }

  /** The account and the retired IDs it gained through Account Claim. */
  private async answeringIds(owner: string): Promise<string[]> {
    const retired = (await this.query(owner, RETIRED)) as unknown as { retired_id: string }[];
    return [...retired.map((item) => item.retired_id), owner];
  }

  private query(owner: string, prefix: string): Promise<SessionItem[]> {
    return this.queryPartition(ownerPk(owner), prefix);
  }

  private async queryPartition(pk: string, prefix?: string): Promise<SessionItem[]> {
    const items: SessionItem[] = [];
    const pages = paginateQuery(
      { client: this.documents },
      {
        TableName: this.tableName,
        KeyConditionExpression: prefix === undefined ? 'pk = :pk' : 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ...(prefix === undefined ? {} : { ':prefix': prefix }) },
        ConsistentRead: true,
      },
    );
    for await (const page of pages) items.push(...(page.Items as SessionItem[]));
    return items;
  }
}

/** A fence-check refusal as SessionDeletedError; any other failure as is. */
function fenceRefusal(error: unknown, sessionId: string): unknown {
  const reasons = (error as Partial<TransactionCanceledException>).CancellationReasons;
  return reasons?.some((reason) => reason.Code === 'ConditionalCheckFailed') ? new SessionDeletedError(sessionId) : error;
}

function retryUnboundTurn(error: unknown, sessionId: string, newUnbound: boolean): boolean {
  const reasons = (error as Partial<TransactionCanceledException>).CancellationReasons;
  const [ownerFence, session, claimFence] = reasons ?? [];
  if (ownerFence?.Code === 'ConditionalCheckFailed' || (session?.Code === 'ConditionalCheckFailed' && session.Item?.deleted_at !== undefined)) throw new SessionDeletedError(sessionId);
  if (claimFence?.Code === 'ConditionalCheckFailed') throw new SessionClaimError(sessionId);
  if (session?.Code === 'ConditionalCheckFailed') {
    if (newUnbound) return true;
    throw new SessionProviderError(storedProvider(session.Item));
  }
  throw error;
}
