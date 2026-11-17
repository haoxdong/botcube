import { QueryCommand, ScanCommand, type TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { AccountResources, nowSeconds, type Lease } from './account-resources.js';

export type Operation = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>[number];
export type PutOperation = { Put: NonNullable<Operation['Put']> };
interface GuestAccount {
  accountId: string;
  status: string;
  deletionOperationId?: string;
  lastActiveAt?: number;
}

const GUEST_EXPIRY_SECONDS = 60 * 60 * 24 * 30;
const GUEST_ACTIVITY_SECONDS = 60 * 60 * 24;
const GUEST_EXPIRY_SESSION_STAND_IN = 'guest-expiry';
const GUEST_ACTIVITY = 'GUEST_ACTIVITY';
const GUEST_ACTIVITY_BACKFILL = { pk: 'GUEST_ACTIVITY_BACKFILL', sk: 'META' };
const ACCOUNT_PK_PREFIX = 'ACCOUNT#';
type Item = Record<string, unknown>;

const guestActivity = {
  key: (accountId: string, lastActiveAt: number) => ({ pk: GUEST_ACTIVITY, sk: `${String(lastActiveAt).padStart(12, '0')}#${accountId}` }),
  accountId: (sk: string) => sk.slice(sk.indexOf('#') + 1),
};

export abstract class GuestExpiry<A extends GuestAccount> extends AccountResources {
  protected abstract put(item: Item): PutOperation;
  protected abstract delete(pk: string, sk?: string): Operation;
  protected abstract commit(lease: Lease, operations: Operation[]): Promise<void>;
  protected abstract mutation<T>(body: (lease: Lease) => Promise<T>): Promise<T>;
  abstract loadAccount(accountId: string | null | undefined): Promise<A | null>;
  protected abstract requireAccount(accountId: string): Promise<A>;
  protected abstract accountItem(account: A): Item;
  protected abstract deletionAuthorization(account: A, sessionToken: string): Promise<[unknown, Operation[]]>;

  protected guestActivityPut(accountId: string, lastActiveAt: number): PutOperation {
    return this.put(guestActivity.key(accountId, lastActiveAt));
  }

  async recordGuestActivity(account: A): Promise<void> {
    if (account.status !== 'anonymous' || (account.lastActiveAt ?? 0) > nowSeconds() - GUEST_ACTIVITY_SECONDS) return;
    await this.mutation(async (lease) => {
      const current = await this.requireAccount(account.accountId);
      if (current.status === 'anonymous') await this.markActive(lease, current);
    });
  }

  private markActive(lease: Lease, account: A): Promise<void> {
    const previous = account.lastActiveAt;
    const now = nowSeconds();
    Object.assign(account, { lastActiveAt: now, updatedAt: now });
    return this.commit(lease, [
      ...(previous === undefined ? [] : [this.delete(GUEST_ACTIVITY, guestActivity.key(account.accountId, previous).sk)]),
      this.put(this.accountItem(account)),
      this.guestActivityPut(account.accountId, now),
    ]);
  }

  async expireGuests(): Promise<void> {
    await this.backfillGuestActivity();
    const cutoff = guestActivity.key('', nowSeconds() - GUEST_EXPIRY_SECONDS).sk;
    const inactive = this.pages('Query', (ExclusiveStartKey) => new QueryCommand({
      TableName: this.tableName, ConsistentRead: true,
      KeyConditionExpression: 'pk = :pk AND sk <= :cutoff',
      ExpressionAttributeValues: { ':pk': GUEST_ACTIVITY, ':cutoff': cutoff },
      ExclusiveStartKey,
    }));
    for await (const page of inactive) {
      for (const item of page) {
        // eslint-disable-next-line no-await-in-loop -- each expiry commits under the one mutation lease
        await this.expireGuest(String(item.sk));
      }
    }
  }

  private async backfillGuestActivity(): Promise<void> {
    if (await this.get(GUEST_ACTIVITY_BACKFILL.pk) !== undefined) return;
    const unindexed = this.pages('Scan', (ExclusiveStartKey) => new ScanCommand({
      TableName: this.tableName, ConsistentRead: true,
      FilterExpression: 'begins_with(pk, :account) AND sk = :meta AND #record.#status = :anonymous AND attribute_not_exists(#record.lastActiveAt)',
      ExpressionAttributeNames: { '#record': 'record', '#status': 'status' },
      ExpressionAttributeValues: { ':account': ACCOUNT_PK_PREFIX, ':meta': 'META', ':anonymous': 'anonymous' },
      ExclusiveStartKey,
    }));
    for await (const page of unindexed) {
      for (const item of page) {
        // eslint-disable-next-line no-await-in-loop -- each Guest commits under the one mutation lease
        await this.indexLegacyGuest(String(item.pk).slice(ACCOUNT_PK_PREFIX.length));
      }
    }
    await this.mutation((lease) => this.commit(lease, [this.put(GUEST_ACTIVITY_BACKFILL)]));
  }

  private indexLegacyGuest(accountId: string): Promise<void> {
    return this.mutation(async (lease) => {
      const account = await this.loadAccount(accountId);
      if (account?.status === 'anonymous' && account.lastActiveAt === undefined) await this.markActive(lease, account);
    });
  }

  private expireGuest(activitySk: string): Promise<void> {
    const accountId = guestActivity.accountId(activitySk);
    return this.mutation(async (lease) => {
      const account = await this.loadAccount(accountId);
      const dropIndex = this.delete(GUEST_ACTIVITY, activitySk);
      const expired = account?.status === 'anonymous' && account.deletionOperationId === undefined &&
        account.lastActiveAt !== undefined && guestActivity.key(accountId, account.lastActiveAt).sk === activitySk;
      if (!expired) {
        await this.commit(lease, [dropIndex]);
        return;
      }
      const [, operations] = await this.deletionAuthorization(account, GUEST_EXPIRY_SESSION_STAND_IN);
      await this.commit(lease, [...operations, dropIndex]);
    });
  }
}
