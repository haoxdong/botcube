import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { ConditionalCheckFailedException, TransactionConflictException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { AccountResources, AccountStoreError, OpenAIIdentityTaken } from './account-resources.js';
import type { AgentModel } from './cartridge.js';
import { pictureFromItem, pictureItem, type Picture } from './pictures.js';

export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_INACTIVITY_SECONDS = 60 * 60 * 24 * 30;
export const SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 365;
const LOCK_SECONDS = 60;

/** How a Cartridge names its accounts: `key` names its cookies and session records, `product` its messages. */
export interface AccountNaming {
  readonly key: string;
  readonly product: string;
}

/** An Account record; its shape is live production data. */
export interface Account {
  version: number;
  accountId: string;
  status: 'anonymous' | 'registered';
  rateTier: string;
  deletionOperationId?: string;
  /** The profile: seeded from the first login-capable Sign-in, then the user's; its photo is an item of its own. */
  displayName?: string;
  /** A scheduled run needed the user to sign in again; cleared when they do. */
  signInNeeded?: boolean;
  /** The OpenAI Sign-in's ChatGPT identity (its ID token's `sub`): the Account has Plan Usage (ADR 0078). */
  openaiIdentity?: string;
  /** The plan's models from its catalog's last fetch, which each model listing refreshes; cleared with each OpenAI Sign-in. */
  planModels?: AgentModel[];
  createdAt: number;
  updatedAt: number;
}

/** Freshly authorized deletion that survives removal of the account and its bearer tokens. */
export interface AccountDeletionIntent {
  accountId: string;
  operationId: string;
  authorizedAt: number;
  sessionBinding: string;
  status: 'authorized' | 'completed';
}

/** A token item's `record`: a session of kind `naming.key`, or a Cartridge's own kind of token. */
export type TokenRecord = { accountId: string; createdAt: number; expiresAt: number; kind: string } & Record<string, unknown>;
type SessionRecord = TokenRecord & { lastActivityAt: number; inactivityExpiresAt: number; absoluteExpiresAt: number };

export type Operation = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>[number];
export type PutOperation = { Put: NonNullable<Operation['Put']> };
type Item = Record<string, unknown>;

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const token = (bytes: number) => randomBytes(bytes).toString('base64url');
export const itemKey = (pk: string, sk = 'META') => ({ pk, sk });

export const isAccountId = (value: string | null | undefined): value is string => {
  const id = (value ?? '').trim();
  return id.startsWith('acct_') && id.length >= 10 && id.length <= 128;
};

/** A token's binding to the session that started it. */
export const sessionBinding = (sessionToken: string) =>
  createHash('sha256').update(sessionToken, 'utf8').digest('hex');

/** A conditional lease with renewal, fencing transactions after a takeover. */
export class Lease {
  readonly key: { pk: string; sk: string };
  private readonly holder = token(24);
  private failure: unknown = undefined;
  private renewal: NodeJS.Timeout | undefined;
  private renewing: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: AccountResources,
    name: string,
  ) {
    this.key = itemKey(`ACCOUNT_LOCK#${name}`);
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
    clearInterval(this.renewal);
    await this.renewing;
    // An expired or superseded owner may neither report success nor delete a new lease.
    await this.store.call('DeleteItem', new DeleteCommand(this.condition()));
  }
}

/** Seed the profile's name from a Sign-in unless the account has one; answers whether it did. */
export function seedName(account: Account, displayName: string | undefined): boolean {
  if (account.displayName !== undefined || !displayName) return false;
  account.displayName = displayName;
  return true;
}

/**
 * Accounts and their tokens in the shared `chat` table, in an item shape that is live production data:
 * `ACCOUNT#<id>/META` holds `record`, and `ACCOUNT#<id>/PHOTO` the user's photo; `OPENAI#<identity>/META`
 * is the OpenAI Sign-in, mapping the identity to one account by a conditional write; `TOKEN#<token>/META`
 * holds a session `record`, indexed under `ACCOUNT#<id>/TOKEN#<token>`; `ACCOUNT_DELETIONS/<id>` is an
 * authorized deletion.
 *
 * Mutations are serialized across all Chat Service tasks by one lease, and every write is fenced by it
 * and by the enclosing leases `fences` names; only a session's slide, which changes no account, writes
 * without it.
 */
export class AccountStore<A extends Account = Account> extends AccountResources {
  private readonly deletion = new AsyncLocalStorage<Lease>();

  constructor(
    tableName: string,
    readonly naming: AccountNaming,
    documents?: Pick<DynamoDBDocumentClient, 'send'>,
  ) {
    super(tableName, documents);
  }

  protected put(item: Item): PutOperation {
    return { Put: { TableName: this.tableName, Item: item } };
  }

  protected delete(pk: string, sk = 'META'): Operation {
    return { Delete: { TableName: this.tableName, Key: itemKey(pk, sk) } };
  }

  /** The enclosing leases every write is fenced by, beyond the mutation's own. */
  protected fences(): Lease[] {
    const deletion = this.deletion.getStore();
    return deletion === undefined ? [] : [deletion];
  }

  protected async commit(lease: Lease, operations: Operation[]): Promise<void> {
    await this.call(
      'TransactWriteItems',
      new TransactWriteCommand({
        TransactItems: [...[lease, ...this.fences()].map((fence) => ({ ConditionCheck: fence.condition() })), ...operations],
      }),
    );
  }

  protected async mutation<T>(body: (lease: Lease) => Promise<T>): Promise<T> {
    const lease = await new Lease(this, 'MUTATION').acquire();
    try {
      return await body(lease);
    } finally {
      await lease.release();
    }
  }

  async accountDeletionLock<T>(accountId: string, body: () => Promise<T>): Promise<T> {
    if (!isAccountId(accountId)) throw new AccountStoreError('Account deletion identity is invalid');
    const lease = await new Lease(this, `DELETION#${accountId}`).acquire();
    try {
      return await this.deletion.run(lease, body);
    } finally {
      await lease.release();
    }
  }

  async loadAccount(accountId: string | null | undefined): Promise<A | null> {
    if (!isAccountId(accountId)) return null;
    const item = await this.get(`ACCOUNT#${accountId}`);
    return item === undefined ? null : { ...(item.record as A) };
  }

  protected async requireAccount(accountId: string, { allowDeletion = false } = {}): Promise<A> {
    const account = await this.loadAccount(accountId);
    if (account === null) throw new AccountStoreError(`${this.naming.product} account not found`);
    if (!allowDeletion && account.deletionOperationId !== undefined) {
      throw new AccountStoreError(`${this.naming.product} account deletion is pending`);
    }
    return account;
  }

  protected accountItem(account: A): Item {
    return { ...itemKey(`ACCOUNT#${account.accountId}`), record: account };
  }

  /** A new anonymous account record. */
  protected newAccount(account: Account): A {
    return account as A;
  }

  /** The caller's anonymous account, or a new one; `created` says which. */
  anonymousAccount(accountId: string | undefined): Promise<{ account: A; created: boolean }> {
    return this.mutation(async (lease) => {
      const existing = await this.loadAccount(accountId);
      if (existing?.status === 'anonymous') return { account: existing, created: false };
      const now = nowSeconds();
      const account = this.newAccount({
        version: 1,
        accountId: `acct_${token(24)}`,
        status: 'anonymous',
        rateTier: 'anonymous',
        createdAt: now,
        updatedAt: now,
      });
      const operation = this.put(this.accountItem(account));
      operation.Put.ConditionExpression = 'attribute_not_exists(pk)';
      await this.commit(lease, [operation]);
      return { account, created: true };
    });
  }

  /** Write `change` to the account under the mutation lease. */
  private change(accountId: string, change: (account: A) => boolean | void): Promise<A> {
    return this.mutation(async (lease) => {
      const account = await this.requireAccount(accountId);
      if (change(account) === false) return account;
      account.updatedAt = nowSeconds();
      await this.commit(lease, [this.put(this.accountItem(account))]);
      return account;
    });
  }

  /**
   * Record the account's OpenAI Sign-in once its Durable Credential is vaulted; a
   * ChatGPT identity gives at most one account Plan Usage.
   */
  recordOpenAISignIn(accountId: string, identity: string): Promise<A> {
    return this.mutation(async (lease) => {
      const account = await this.requireAccount(accountId);
      await this.requireOpenAIIdentityFree(accountId, identity);
      const operations: Operation[] = [];
      const old = account.openaiIdentity;
      if (old && old !== identity) operations.push(this.delete(`OPENAI#${old}`));
      const signIn = this.put({ ...itemKey(`OPENAI#${identity}`), accountId });
      signIn.Put.ConditionExpression = 'attribute_not_exists(pk) OR accountId = :accountId';
      signIn.Put.ExpressionAttributeValues = { ':accountId': accountId };
      Object.assign(account, { openaiIdentity: identity, updatedAt: nowSeconds() });
      delete account.planModels;
      await this.commit(lease, [...operations, signIn, this.put(this.accountItem(account))]);
      return account;
    });
  }

  /** Throw OpenAIIdentityTaken when another account's OpenAI Sign-in holds this ChatGPT identity. */
  async requireOpenAIIdentityFree(accountId: string, identity: string): Promise<void> {
    const reservation = await this.get(`OPENAI#${identity}`);
    if (reservation && reservation.accountId !== accountId) throw new OpenAIIdentityTaken();
  }

  /** Remove the account's OpenAI Sign-in, if it holds one: it no longer has Plan Usage. */
  removeOpenAISignIn(accountId: string): Promise<A> {
    return this.mutation(async (lease) => {
      const account = await this.requireAccount(accountId);
      const identity = account.openaiIdentity;
      if (!identity) return account;
      delete account.openaiIdentity;
      delete account.planModels;
      account.updatedAt = nowSeconds();
      await this.commit(lease, [this.delete(`OPENAI#${identity}`), this.put(this.accountItem(account))]);
      return account;
    });
  }

  /** Keep the plan catalog's models just fetched for an account that still has Plan Usage. */
  recordPlanModels(accountId: string, openaiIdentity: string, planModels: AgentModel[]): Promise<A | null> {
    return this.mutation(async (lease) => {
      const account = await this.requireAccount(accountId);
      if (account.openaiIdentity !== openaiIdentity) return null;
      Object.assign(account, { planModels, updatedAt: nowSeconds() });
      await this.commit(lease, [this.put(this.accountItem(account))]);
      return account;
    });
  }

  /** Record that a scheduled run needed the user to sign in. */
  markSignInNeeded(accountId: string): Promise<A> {
    return this.change(accountId, (account) => {
      account.signInNeeded = true;
    });
  }

  /** The user signed in again: no run waits on them. */
  clearSignInNeeded(accountId: string): Promise<A> {
    return this.change(accountId, (account) => {
      if (!account.signInNeeded) return false;
      delete account.signInNeeded;
      return true;
    });
  }

  /** Set the account's display name. */
  updateProfile(accountId: string, profile: { displayName: string }): Promise<A> {
    return this.change(accountId, (account) => {
      account.displayName = profile.displayName;
    });
  }

  /** The user's photo, or null without one. */
  async photo(accountId: string): Promise<Picture | null> {
    return pictureFromItem(await this.get(`ACCOUNT#${accountId}`, 'PHOTO'));
  }

  /** Last writer wins: keep this photo as the user's, or clear it with null. */
  savePhoto(accountId: string, photo: Picture | null): Promise<void> {
    return this.mutation(async (lease) => {
      await this.requireAccount(accountId);
      const photoKey = itemKey(`ACCOUNT#${accountId}`, 'PHOTO');
      await this.commit(lease, [photo === null
        ? this.delete(photoKey.pk, photoKey.sk)
        : this.put({ ...photoKey, ...pictureItem(photo) })]);
    });
  }

  protected tokenItems(tokenValue: string, record: TokenRecord): [token: PutOperation, index: PutOperation] {
    return [
      this.put({ ...itemKey(`TOKEN#${tokenValue}`), record, expiresAt: record.expiresAt }),
      this.put({ ...itemKey(`ACCOUNT#${record.accountId}`, `TOKEN#${tokenValue}`), expiresAt: record.expiresAt }),
    ];
  }

  protected tokenDeletes(tokenValue: string, record: TokenRecord): Operation[] {
    return [this.delete(`TOKEN#${tokenValue}`), this.delete(`ACCOUNT#${record.accountId}`, `TOKEN#${tokenValue}`)];
  }

  protected async session(tokenValue: string): Promise<TokenRecord | null> {
    const item = tokenValue ? await this.get(`TOKEN#${tokenValue}`) : undefined;
    return item ? (item.record as TokenRecord) : null;
  }

  /** The live session behind this token, or null. */
  protected async activeSession(tokenValue: string): Promise<TokenRecord | null> {
    const record = await this.session(tokenValue);
    return record && record.expiresAt > nowSeconds() && record.kind === this.naming.key ? record : null;
  }

  protected newSession(accountId: string): [string, Operation[]] {
    const now = nowSeconds();
    const tokenValue = `sess_${token(32)}`;
    const record: SessionRecord = {
      accountId,
      kind: this.naming.key,
      createdAt: now,
      lastActivityAt: now,
      inactivityExpiresAt: now + SESSION_INACTIVITY_SECONDS,
      absoluteExpiresAt: now + SESSION_ABSOLUTE_SECONDS,
      expiresAt: now + SESSION_INACTIVITY_SECONDS,
    };
    return [tokenValue, this.tokenItems(tokenValue, record)];
  }

  protected async cleanTokens(lease: Lease, accountId: string, { expiredOnly = false } = {}): Promise<void> {
    let exclusiveStartKey: Item | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- pagination: each page starts after the previous page's LastEvaluatedKey
      const page = await this.call<{ Items?: Item[]; LastEvaluatedKey?: Item }>(
        'Query',
        new QueryCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': `ACCOUNT#${accountId}`, ':prefix': 'TOKEN#' },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      let operations: Operation[] = [];
      for (const item of page.Items ?? []) {
        if (!expiredOnly || (item.expiresAt as number) <= nowSeconds()) {
          operations.push(this.delete(item.sk as string), this.delete(item.pk as string, item.sk as string));
        }
        if (operations.length >= 96) {
          // eslint-disable-next-line no-await-in-loop -- commits one batch at a time under the account lease
          await this.commit(lease, operations);
          operations = [];
        }
      }
      // eslint-disable-next-line no-await-in-loop -- commits one batch at a time under the account lease
      if (operations.length > 0) await this.commit(lease, operations);
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
  }

  /** A new session for the account. */
  createSession(accountId: string): Promise<string> {
    return this.mutation(async (lease) => {
      await this.requireAccount(accountId);
      await this.cleanTokens(lease, accountId, { expiredOnly: true });
      const [tokenValue, operations] = this.newSession(accountId);
      await this.commit(lease, operations);
      return tokenValue;
    });
  }

  /** The deletes of the account's session this token names, when it is the account's. */
  protected async replacedSessionDeletes(sessionTokenToReplace: string | undefined, accountId: string): Promise<Operation[]> {
    const replacing = (sessionTokenToReplace ?? '').trim();
    const oldSession = replacing.startsWith('sess_') ? await this.session(replacing) : null;
    return oldSession && oldSession.accountId === accountId ? this.tokenDeletes(replacing, oldSession) : [];
  }

  /** Delete a session; true when it was still live. */
  async deleteTrustedSession(sessionToken: string | undefined): Promise<boolean> {
    const tokenValue = (sessionToken ?? '').trim();
    if (!tokenValue.startsWith('sess_')) return false;
    return this.mutation(async (lease) => {
      const record = await this.session(tokenValue);
      if (record === null) return false;
      await this.commit(lease, this.tokenDeletes(tokenValue, record));
      return record.expiresAt > nowSeconds();
    });
  }

  /**
   * The registered account a live session token belongs to. Using the
   * session slides its inactivity expiry, up to its absolute expiry; an expired
   * token is deleted.
   */
  async sessionAccount(sessionToken: string | undefined): Promise<A | null> {
    const tokenValue = (sessionToken ?? '').trim();
    if (!tokenValue.startsWith('sess_')) return null;
    let record = await this.session(tokenValue);
    if (record === null) return null;
    if (record.expiresAt <= nowSeconds()) {
      record = await this.mutation(async (lease) => {
        // Another read may have renewed the token while this snapshot was in flight.
        const current = await this.session(tokenValue);
        if (current === null || current.expiresAt > nowSeconds()) return current;
        await this.commit(lease, this.tokenDeletes(tokenValue, current));
        return null;
      });
      if (record === null) return null;
    }
    if (record.kind !== this.naming.key) return null;
    const account = await this.loadAccount(record.accountId);
    if (account?.status !== 'registered') return null;
    const session = record as SessionRecord;
    const now = nowSeconds();
    Object.assign(session, {
      lastActivityAt: now,
      inactivityExpiresAt: now + SESSION_INACTIVITY_SECONDS,
      expiresAt: Math.min(now + SESSION_INACTIVITY_SECONDS, session.absoluteExpiresAt),
    });
    // The slide takes no account lock, so page reads do not queue on one global item; each write replaces a
    // token item only while it is still live, so a sign-out between the read and the slide stays signed out.
    // The index goes first: cleanup reads its expiry, and must never see a live session as expired.
    const [tokenItem, index] = this.tokenItems(tokenValue, session);
    return (await this.replaceLive(index)) && (await this.replaceLive(tokenItem)) ? account : null;
  }

  /** The registered account ID a live session token belongs to. */
  async sessionAccountId(sessionToken: string | undefined): Promise<string | null> {
    return (await this.sessionAccount(sessionToken))?.accountId ?? null;
  }

  /** Replace a token item that is still live; false when it has expired or been deleted since it was read. */
  private async replaceLive({ Put }: PutOperation): Promise<boolean> {
    try {
      await this.documents.send(
        new PutCommand({
          ...Put,
          ConditionExpression: 'expiresAt > :now',
          ExpressionAttributeValues: { ':now': nowSeconds() },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw new AccountStoreError('DynamoDB account storage PutItem failed', { cause: error });
    }
  }

  /** The operations that authorize the account's deletion for the session, keeping an authorization already given. */
  protected async deletionAuthorization(
    account: A,
    sessionToken: string,
  ): Promise<[AccountDeletionIntent, Operation[]]> {
    const previous = await this.accountDeletion(account.accountId);
    if (previous !== null && (previous.status !== 'authorized' || account.deletionOperationId !== previous.operationId)) {
      throw new AccountStoreError('Account deletion authorization no longer matches');
    }
    if (previous === null && account.deletionOperationId !== undefined) {
      throw new AccountStoreError('Account deletion authorization is missing');
    }
    const intent: AccountDeletionIntent = previous ?? {
      accountId: account.accountId, operationId: `adelete_${token(24)}`, authorizedAt: nowSeconds(),
      sessionBinding: sessionBinding(sessionToken), status: 'authorized',
    };
    account.deletionOperationId = intent.operationId;
    return [intent, [
      this.put(this.accountItem(account)),
      this.put({ ...itemKey('ACCOUNT_DELETIONS', account.accountId), ...intent }),
    ]];
  }

  async accountDeletion(accountId: string): Promise<AccountDeletionIntent | null> {
    const item = await this.get('ACCOUNT_DELETIONS', accountId);
    if (item === undefined) return null;
    if (item.accountId !== accountId || !isAccountId(accountId) ||
        typeof item.operationId !== 'string' || !item.operationId.startsWith('adelete_') ||
        typeof item.authorizedAt !== 'number' || !Number.isFinite(item.authorizedAt) ||
        typeof item.sessionBinding !== 'string' || !/^[a-f0-9]{64}$/.test(item.sessionBinding) ||
        (item.status !== 'authorized' && item.status !== 'completed')) {
      throw new AccountStoreError('Account deletion authorization is invalid');
    }
    const { operationId, authorizedAt, sessionBinding: binding, status } = item;
    return { accountId, operationId, authorizedAt, sessionBinding: binding, status };
  }

  async pendingAccountDeletions(): Promise<AccountDeletionIntent[]> {
    const intents: AccountDeletionIntent[] = [];
    let exclusiveStartKey: Item | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- the next page uses the previous page's continuation key
      const page = await this.call<{ Items?: Item[]; LastEvaluatedKey?: Item }>('Query', new QueryCommand({
        TableName: this.tableName, ConsistentRead: true,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': 'ACCOUNT_DELETIONS', ':prefix': 'acct_' },
        ExclusiveStartKey: exclusiveStartKey,
      }));
      // eslint-disable-next-line no-await-in-loop -- each page depends on its continuation key
      const current = await Promise.all((page.Items ?? []).map((item) => this.accountDeletion(String(item.sk))));
      intents.push(...current.filter((intent): intent is AccountDeletionIntent => intent?.status === 'authorized'));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return intents;
  }

  completeAccountDeletion(intent: AccountDeletionIntent): Promise<void> {
    return this.mutation(async (lease) => {
      await this.commit(lease, [{ Put: {
        TableName: this.tableName,
        Item: { ...itemKey('ACCOUNT_DELETIONS', intent.accountId), ...intent, status: 'completed' },
        ConditionExpression: 'operationId = :operation AND #status = :authorized',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':operation': intent.operationId, ':authorized': 'authorized' },
      } }]);
    });
  }

  /** The account's Sign-in items, which its deletion frees for other accounts. */
  protected signInDeletes(account: A): Operation[] {
    return account.openaiIdentity ? [this.delete(`OPENAI#${account.openaiIdentity}`)] : [];
  }

  deleteAccount(accountId: string): Promise<boolean> {
    return this.mutation(async (lease) => {
      const account = await this.loadAccount(accountId);
      if (account) {
        await this.commit(lease, [
          this.delete(`ACCOUNT#${accountId}`),
          this.delete(`ACCOUNT#${accountId}`, 'PHOTO'),
          ...this.signInDeletes(account),
        ]);
      }
      // Retry cleanup even after a previous attempt removed the account.
      await this.cleanTokens(lease, accountId);
      return account !== null;
    });
  }
}
