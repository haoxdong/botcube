import { randomUUID } from 'node:crypto';
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
  title: string;
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

/** The Turn's Session, or its owner's whole history, is deleted: it takes no more Turns. */
export class SessionDeletedError extends Error {}

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
  owner: string;
  accountActorId: string;
  filingUserId: string;
  sessionId: string;
  runId: string;
  jti: string;
  startedAt: string;
  expiresAt: number;
}

export interface SessionMetadata {
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
    turn: { filingUserId: string; title: string; provider?: string; running?: RunningTurn; messageId?: string | undefined },
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
  mainChat(owner: string): Promise<string>;
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

type SessionItem = SessionSummary & { pk: string; sk: string; deleted_at?: string; provider_pending?: true };
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
function runningWrite(running: RunningTurn | undefined) {
  return running === undefined
    ? { set: '', remove: ', turn_latest_run_id', values: {} }
    : {
        set: ', turn_running_since = :started_at, turn_run_id = :run_id, turn_latest_run_id = :run_id, turn_preparing = :preparing',
        remove: '',
        values: { ':started_at': running.startedAt, ':run_id': running.runId, ':preparing': true },
      };
}

function storedProvider(item: Record<string, AttributeValue> | undefined): string {
  return item?.provider?.S ?? 'anthropic';
}

/** The stored timestamp format: ISO 8601 with microseconds and a +00:00 offset. */
function now(): string {
  return new Date().toISOString().replace('Z', '000+00:00');
}

export class DynamoDBSessionMetadata implements SessionMetadata {
  private readonly client: DynamoDBClient;
  private readonly documents: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client = new DynamoDBClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' }),
  ) {
    this.client = client;
    this.documents = DynamoDBDocumentClient.from(client);
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

  async recordTurn(
    owner: string,
    sessionId: string,
    {
      filingUserId,
      title,
      provider,
      running,
      messageId,
    }: { filingUserId: string; title: string; provider?: string; running?: RunningTurn | undefined; messageId?: string | undefined },
  ): Promise<string> {
    const newUnbound = provider === undefined && (await this.get(owner, sessionId)) === null;
    const providerUpdate = providerWrite(provider, newUnbound);
    const runningUpdate = runningWrite(running);
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
                  'title = if_not_exists(title, :title), ' +
                  'filing_user_id = if_not_exists(filing_user_id, :filing_user_id)' +
                  (messageId === undefined ? '' : ', latest_message_id = :latest_message_id') +
                  runningUpdate.set +
                  providerUpdate.set + ' REMOVE turn_failure' + runningUpdate.remove + (provider === undefined ? '' : ', provider_pending'),
                ConditionExpression: `attribute_not_exists(deleted_at)${providerUpdate.condition}`,
                ExpressionAttributeValues: {
                  ':session_id': sessionId,
                  ':now': now(),
                  ':title': title,
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
          ],
        }),
      );
    } catch (error) {
      if (retryUnboundTurn(error, sessionId, newUnbound)) {
        return this.recordTurn(owner, sessionId, { filingUserId, title, running, messageId });
      }
    }
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
        if (!fenced(item)) sessions.push({ owner: item.pk.slice(OWNER.length), session: summaryOf(item) });
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
      .filter((item) => !fenced(item))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(summaryOf);
  }

  async get(owner: string, sessionId: string): Promise<SessionSummary | null> {
    const { Item } = await this.documents.send(
      new GetCommand({ TableName: this.tableName, Key: key(owner, sessionId), ConsistentRead: true }),
    );
    return Item === undefined || fenced(Item as SessionItem) ? null : summaryOf(Item as SessionItem);
  }

  /** A live Session moved by the Account Claim pinned to this source. */
  private async claimedSession(owner: string, sessionId: string): Promise<Readonly<{ owner: string; session: SessionSummary }> | null> {
    const { Item } = await this.documents.send(
      new GetCommand({ TableName: this.tableName, Key: claimFenceKey(owner), ConsistentRead: true }),
    );
    if (typeof Item?.destination !== 'string') return null;
    const session = await this.get(Item.destination, sessionId);
    return session === null ? null : { owner: Item.destination, session };
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

  async mainChat(owner: string): Promise<string> {
    const assigned = await this.mainChatId(owner);
    if (assigned !== null) return assigned;
    await this.assignMainChatIfAbsent(owner, randomUUID());
    return (await this.mainChatId(owner)) as string;
  }

  async fence(owner: string, sessionId: string): Promise<SessionSummary | null> {
    const fenced = await this.setFence(owner, sessionId);
    if (fenced === null) return null;
    const summaries = await this.queryPartition(turnSummariesPk(fenced.filing_user_id), turnSummaryPrefix(sessionId));
    // A longer Session ID can share the prefix.
    for (const { pk, sk } of summaries.filter((item) => item.session_id === sessionId)) {
      // eslint-disable-next-line no-await-in-loop -- stops at the first failure; deleting again retries
      await this.documents.send(new DeleteCommand({ TableName: this.tableName, Key: { pk, sk } }));
    }
    return fenced;
  }

  private async setFence(owner: string, sessionId: string): Promise<SessionSummary | null> {
    try {
      const { Attributes } = await this.documents.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key(owner, sessionId),
          UpdateExpression: 'SET deleted_at = if_not_exists(deleted_at, :now) REMOVE title',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':now': now() },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return summaryOf(Attributes as SessionItem);
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return null;
      throw error;
    }
  }

  async fenceOwner(owner: string): Promise<SessionSummary[]> {
    const deletedAt = now();
    const accounts = await this.answeringIds(owner);
    for (const account of accounts) {
      // eslint-disable-next-line no-await-in-loop -- stops at the first failure without sending the rest
      await this.documents.send(
        new PutCommand({ TableName: this.tableName, Item: { ...ownerFenceKey(account), deleted_at: deletedAt } }),
      );
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
      // eslint-disable-next-line no-await-in-loop -- stops at the first failure without sending the rest
      await this.documents.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { ...item, ...key(destination, item.session_id) },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Delete: {
                TableName: this.tableName,
                Key: key(source, item.session_id),
                ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(deleted_at)',
              },
            },
          ],
        }),
      );
    }
    const sourceMainChat = await this.mainChatId(source);
    if (sourceMainChat === null) return;
    // The destination keeps its own Main Chat; the source's becomes a Side Chat.
    await this.assignMainChatIfAbsent(destination, sourceMainChat);
  }

  private async mainChatId(owner: string): Promise<string | null> {
    const { Item } = await this.documents.send(
      new GetCommand({ TableName: this.tableName, Key: mainChatKey(owner), ConsistentRead: true }),
    );
    return Item === undefined ? null : (Item as { session_id: string }).session_id;
  }

  private async assignMainChatIfAbsent(owner: string, sessionId: string): Promise<void> {
    try {
      await this.documents.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...mainChatKey(owner), session_id: sessionId },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      // An existing Main Chat keeps its assignment.
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
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

  private async queryPartition(pk: string, prefix: string): Promise<SessionItem[]> {
    const items: SessionItem[] = [];
    const pages = paginateQuery(
      { client: this.documents },
      {
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
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

/** Classify a refused Turn write; only a raced first, model-less Turn can retry. */
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
