import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { ConditionalCheckFailedException, TransactionConflictException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, TransactWriteCommand, UpdateCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
export class AccountStoreError extends Error {}
export interface AgentComputerRecord { profileId: string | null; }
export interface RunningAgentComputer {
  accountId: string;
  threadId: string;
  sessionId: string | null;
  phase: 'starting' | 'awake' | 'sleeping' | 'failed';
  idleDeadline: number;
}
export interface AgentComputerStream {
  accountId: string;
  threadId: string;
  sessionId: string;
  holder: string;
  expiresAt: number;
}
const LOCK_SECONDS = 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);
type Item = Record<string, unknown>;
const key = (pk: string, sk = 'META') => ({ pk, sk });
/** A conditional lease with renewal, fencing transactions after a takeover. */
export class Lease {
  active = false;
  readonly key: { pk: string; sk: string };
  private readonly holder = randomBytes(24).toString('base64url');
  private failure: unknown = undefined;
  private renewal: NodeJS.Timeout | undefined;
  private renewing: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: AccountResources,
    name: string,
  ) {
    this.key = key(`ACCOUNT_LOCK#${name}`);
  }

  async acquire(): Promise<this> {
    const deadline = Date.now() + LOCK_SECONDS * 1000;
    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop -- retries until the lock is acquired
        await this.store.documents.send(
          new PutCommand({
            TableName: this.store.tableName,
            Item: { ...this.key, holder: this.holder, expiresAt: nowSeconds() + LOCK_SECONDS },
            ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
            ExpressionAttributeValues: { ':now': nowSeconds() },
          }),
        );
        break;
      } catch (error) {
        // The holder's fenced commit checks the lock item, so DynamoDB rejects this Put until that transaction ends.
        const contended =
          error instanceof ConditionalCheckFailedException || error instanceof TransactionConflictException;
        if (!contended || Date.now() >= deadline) {
          throw new AccountStoreError('Could not acquire account operation lock', { cause: error });
        }
        // eslint-disable-next-line no-await-in-loop -- retries until the lock is acquired
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    this.active = true;
    this.renewal = setInterval(() => {
      this.renewing = this.renew();
    }, (LOCK_SECONDS / 3) * 1000);
    this.renewal.unref();
    return this;
  }

  condition() {
    if (this.failure !== undefined) {
      throw new AccountStoreError('Account operation lock renewal failed', { cause: this.failure });
    }
    return {
      TableName: this.store.tableName,
      Key: this.key,
      ConditionExpression: 'holder = :holder AND expiresAt > :now',
      ExpressionAttributeValues: { ':holder': this.holder, ':now': nowSeconds() } as Item,
    };
  }

  private async renew(): Promise<void> {
    try {
      const condition = this.condition();
      condition.ExpressionAttributeValues[':expiry'] = nowSeconds() + LOCK_SECONDS;
      await this.store.documents.send(new UpdateCommand({ ...condition, UpdateExpression: 'SET expiresAt = :expiry' }));
    } catch (error) {
      this.failure = error;
      clearInterval(this.renewal);
    }
  }

  async release(): Promise<void> {
    this.active = false;
    clearInterval(this.renewal);
    await this.renewing;
    // An expired or superseded owner may neither report success nor delete a new lease.
    await this.store.call('DeleteItem', new DeleteCommand(this.condition()));
  }
}

/** The account's browser profiles, screenshots, and Files access points. */
export class AccountResources {
  private readonly computerLease = new AsyncLocalStorage<Lease[]>();
  private readonly computerOperations = new Map<string, Promise<unknown>>();

  async withAgentComputerLease<T>(accountId: string, body: () => Promise<T>, threadId?: string): Promise<T> {
    const name = JSON.stringify([accountId, threadId ?? null]);
    const previous = this.computerOperations.get(name);
    const done = (async () => {
      await previous?.catch(() => undefined);
      const lease = await new Lease(this, `AGENT_COMPUTER#${name}`).acquire();
      try {
        return await this.computerLease.run([...(this.computerLease.getStore() ?? []).filter((held) => held.active), lease], body);
      } finally {
        await lease.release();
      }
    })();
    this.computerOperations.set(name, done);
    try { return await done; }
    finally { if (this.computerOperations.get(name) === done) this.computerOperations.delete(name); }
  }

  async agentComputerStream(sessionId: string): Promise<AgentComputerStream | null> {
    const item = await this.get('AGENT_COMPUTER_STREAM', sessionId);
    return item === undefined ? null : { ...item.record as AgentComputerStream, expiresAt: item.expiresAt as number };
  }

  async claimAgentComputerStream(record: AgentComputerStream): Promise<boolean> {
    return this.streamWrite(new PutCommand({
      TableName: this.tableName,
      Item: { ...key('AGENT_COMPUTER_STREAM', record.sessionId), record, holder: record.holder, expiresAt: record.expiresAt },
      ConditionExpression: 'attribute_not_exists(pk) OR expiresAt <= :now',
      ExpressionAttributeValues: { ':now': Date.now() },
    }));
  }

  async renewAgentComputerStream(sessionId: string, holder: string, expiresAt: number): Promise<boolean> {
    return this.streamWrite(new UpdateCommand({
      TableName: this.tableName, Key: key('AGENT_COMPUTER_STREAM', sessionId),
      ConditionExpression: 'holder = :holder AND expiresAt > :now',
      ExpressionAttributeValues: { ':holder': holder, ':now': Date.now(), ':expiry': expiresAt },
      UpdateExpression: 'SET expiresAt = :expiry',
    }));
  }

  async releaseAgentComputerStream(sessionId: string, holder: string): Promise<boolean> {
    return this.streamWrite(new DeleteCommand({
      TableName: this.tableName, Key: key('AGENT_COMPUTER_STREAM', sessionId),
      ConditionExpression: 'holder = :holder',
      ExpressionAttributeValues: { ':holder': holder },
    }));
  }

  private async streamWrite(command: PutCommand | UpdateCommand | DeleteCommand): Promise<boolean> {
    try {
      await this.call('stream mutation', command);
      return true;
    } catch (error) {
      if (error instanceof AccountStoreError && error.cause instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  async runningAgentComputer(accountId: string, threadId: string): Promise<RunningAgentComputer | null> {
    const item = await this.get('AGENT_COMPUTER_RUNNING', `${encodeURIComponent(accountId)}#${threadId}`);
    return item === undefined ? null : item.record as RunningAgentComputer;
  }

  async runningAgentComputers(accountId?: string): Promise<RunningAgentComputer[]> {
    // DynamoDB rejects begins_with(sk, '') because a key attribute value can't be empty.
    const items = await this.query(accountId === undefined
      ? { KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'AGENT_COMPUTER_RUNNING' } }
      : { KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': 'AGENT_COMPUTER_RUNNING', ':prefix': `${encodeURIComponent(accountId)}#` } });
    return items.map((item) => item.record as RunningAgentComputer);
  }

  async saveRunningAgentComputer(record: RunningAgentComputer): Promise<void> {
    await this.writeRunningAgentComputer({ Put: {
      TableName: this.tableName,
      Item: { ...key('AGENT_COMPUTER_RUNNING', `${encodeURIComponent(record.accountId)}#${record.threadId}`), record },
    } });
  }

  async deleteRunningAgentComputer(accountId: string, threadId: string): Promise<void> {
    await this.writeRunningAgentComputer({ Delete: {
      TableName: this.tableName,
      Key: key('AGENT_COMPUTER_RUNNING', `${encodeURIComponent(accountId)}#${threadId}`),
    } });
  }

  private async writeRunningAgentComputer(operation: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>[number]): Promise<void> {
    const leases = this.computerLease.getStore();
    if (leases === undefined) throw new AccountStoreError('Agent Computer writes require its account lease');
    await this.call('TransactWriteItems', new TransactWriteCommand({
      TransactItems: [...leases.map((lease) => ({ ConditionCheck: lease.condition() })), operation],
    }));
  }

  constructor(
    readonly tableName: string,
    readonly documents: Pick<DynamoDBDocumentClient, 'send'> = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1' }),
    ),
  ) {}

  /** Send a DynamoDB command; a failure is an AccountStoreError naming the DynamoDB operation. */
  async call<T>(operation: string, command: { input: object }): Promise<T> {
    try {
      return (await this.documents.send(command as never)) as T;
    } catch (error) {
      throw new AccountStoreError(`DynamoDB account storage ${operation} failed`, { cause: error });
    }
  }

  /** Every page of a strongly consistent Query. */
  protected async query(input: Pick<QueryCommandInput, 'KeyConditionExpression' | 'ExpressionAttributeValues'>): Promise<Item[]> {
    const items: Item[] = [];
    let ExclusiveStartKey: Item | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- DynamoDB pages depend on the previous key
      const page = await this.call<{ Items?: Item[]; LastEvaluatedKey?: Item }>('Query', new QueryCommand({ ...input, TableName: this.tableName, ConsistentRead: true, ExclusiveStartKey }));
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey !== undefined);
    return items;
  }

  protected async get(pk: string, sk = 'META'): Promise<Item | undefined> {
    const { Item } = await this.call<{ Item?: Item }>(
      'GetItem',
      new GetCommand({ TableName: this.tableName, Key: key(pk, sk), ConsistentRead: true }),
    );
    return Item;
  }

  async agentComputer(accountId: string): Promise<AgentComputerRecord> {
    const item = await this.get(`AGENT_COMPUTER#${accountId}`);
    return item === undefined ? { profileId: null } : { profileId: (item.record as AgentComputerRecord).profileId };
  }

  /** The Session's last Agent Computer screen, a JPEG data URL, once its browser has slept. */
  async agentComputerScreenshot(accountId: string, threadId: string): Promise<string | null> {
    const item = await this.get(`AGENT_COMPUTER#${accountId}`, `SCREENSHOT#${threadId}`);
    return typeof item?.screenshot === 'string' ? item.screenshot : null;
  }

  /** Last writer wins, as for the Agent Computer's record. */
  async saveAgentComputerScreenshot(accountId: string, threadId: string, screenshot: string): Promise<void> {
    await this.call(
      'PutItem',
      new PutCommand({
        TableName: this.tableName,
        Item: { ...key(`AGENT_COMPUTER#${accountId}`, `SCREENSHOT#${threadId}`), screenshot },
      }),
    );
  }

  /** Last writer wins: an Agent Computer's record is no account state, so no lease fences it. */
  async saveAgentComputer(accountId: string, record: AgentComputerRecord): Promise<void> {
    await this.call(
      'PutItem',
      new PutCommand({ TableName: this.tableName, Item: { ...key(`AGENT_COMPUTER#${accountId}`), record } }),
    );
  }

  async deleteAgentComputer(accountId: string): Promise<void> {
    const pk = `AGENT_COMPUTER#${accountId}`;
    const screenshots = await this.query({ KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': pk, ':prefix': 'SCREENSHOT#' } });
    for (const item of screenshots) {
      // eslint-disable-next-line no-await-in-loop -- one screenshot at a time: a retried deletion removes what is left
      await this.call('DeleteItem', new DeleteCommand({ TableName: this.tableName, Key: key(pk, item.sk as string) }));
    }
    await this.call('DeleteItem', new DeleteCommand({ TableName: this.tableName, Key: key(pk) }));
  }

  async filesRetirement(accountId: string): Promise<{ destinationAccountId: string | null; lastCredentialExpiresAt: number } | null> {
    const item = await this.get('FILES_CLEANUP', accountId);
    return item === undefined ? null : { destinationAccountId: item.destinationAccountId as string | null, lastCredentialExpiresAt: item.lastCredentialExpiresAt as number };
  }

  async retireFiles(accountId: string, destinationAccountId: string | null, notBefore: number): Promise<void> {
    if (await this.filesRetirement(accountId) !== null) return;
    await this.call('PutItem', new PutCommand({
      TableName: this.tableName,
      Item: { ...key('FILES_CLEANUP', accountId), destinationAccountId, notBefore, lastCredentialExpiresAt: notBefore },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }

  async scheduleFilesCleanup(accountId: string, notBefore: number, lastCredentialExpiresAt: number): Promise<void> {
    await this.call('UpdateItem', new UpdateCommand({
      TableName: this.tableName, Key: key('FILES_CLEANUP', accountId),
      UpdateExpression: 'SET notBefore = :time',
      ConditionExpression: 'lastCredentialExpiresAt = :expiry',
      ExpressionAttributeValues: { ':time': notBefore, ':expiry': lastCredentialExpiresAt },
    }));
  }

  async completeFilesCleanup(accountId: string, lastCredentialExpiresAt: number): Promise<void> {
    await this.call('DeleteItem', new DeleteCommand({
      TableName: this.tableName, Key: key('FILES_CLEANUP', accountId),
      ConditionExpression: 'lastCredentialExpiresAt = :expiry',
      ExpressionAttributeValues: { ':expiry': lastCredentialExpiresAt },
    }));
  }

  async filesAccountActive(accountId: string): Promise<boolean> {
    const item = await this.get(`ACCOUNT#${accountId}`);
    const account = item?.record as { deletionOperationId?: string } | undefined;
    return account !== undefined && account.deletionOperationId === undefined;
  }

  async pendingFilesCleanup(): Promise<string[]> {
    const items = await this.query({ KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': 'FILES_CLEANUP', ':prefix': 'acct_' } });
    return items.filter((item) => (item.notBefore as number) <= Date.now()).map((item) => item.sk as string);
  }

  /** The S3 Files access point of the account's Files, once created. */
  async filesAccessPoint(accountId: string): Promise<string | null> {
    const item = await this.get(`FILES#${accountId}`);
    return typeof item?.accessPointArn === 'string' ? item.accessPointArn : null;
  }

  /** Forget the account's Files access point once it is deleted. */
  async deleteFilesAccessPoint(accountId: string): Promise<void> {
    await this.call('DeleteItem', new DeleteCommand({ TableName: this.tableName, Key: key(`FILES#${accountId}`) }));
  }

  /** Concurrent creations made the same access point, so the last writer stores what the first did. */
  async saveFilesAccessPoint(accountId: string, accessPointArn: string): Promise<void> {
    await this.call(
      'PutItem',
      new PutCommand({ TableName: this.tableName, Item: { ...key(`FILES#${accountId}`), accessPointArn } }),
    );
  }

}
/** The ChatGPT identity is another account's OpenAI Sign-in. */
export class OpenAIIdentityTaken extends AccountStoreError {
  constructor() {
    super('This ChatGPT identity already gives another Account Plan Usage');
  }
}
