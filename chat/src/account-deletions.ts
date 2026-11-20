import type { Account, AccountDeletionIntent } from './account-record.js';
import type { AccountStore } from './account-store.js';
import { HttpError } from './http-error.js';

type DeletionStore<A extends Account> = Pick<AccountStore<A>,
  'accountDeletionLockUnlessLive' | 'accountDeletion' | 'loadAccount' | 'completeAccountDeletion' | 'pendingAccountDeletions' | 'expireGuests'>;

/** Whether a service answers `/health` with 2xx within `within` ms, checked every `every` ms. */
export async function serviceHealthy(serviceUrl: string, {
  fetch: get = fetch, now = Date.now, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)), within = 120_000, every = 5_000,
}: {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  within?: number;
  every?: number;
} = {}): Promise<boolean> {
  const health = `${new URL(serviceUrl).origin}/health`;
  const deadline = now() + within;
  const check = async (): Promise<boolean> => {
    // A refused or timed-out check means not answering yet.
    if (await get(health, { signal: AbortSignal.timeout(every) }).then(response => response.ok, () => false)) return true;
    if (now() >= deadline) return false;
    await sleep(every);
    return check();
  };
  return check();
}

/**
 * Finish every recorded account deletion, a Guest's expiry among them, through the one erase. An erase that fails,
 * its credential revoke included, leaves the deletion authorized, so the next sweep takes it again. With
 * `credentialsReady`, no deletion starts until it first resolves true: a waking Chat Service serves meanwhile,
 * and a false leaves every deletion authorized for the next sweep.
 */
export function accountDeletions<A extends Account>({ store, deleteAccount, credentialsReady }: {
  store: () => DeletionStore<A>;
  deleteAccount: (accountId: string) => Promise<void>;
  credentialsReady?: () => Promise<boolean>;
}) {
  const finishing = new Set<string>();
  let expiring: Promise<void> | undefined;
  let ready = credentialsReady === undefined;
  let waiting: Promise<boolean> | undefined;

  function untilReady(): Promise<boolean> {
    if (ready || credentialsReady === undefined) return Promise.resolve(true);
    waiting ??= credentialsReady().then((healthy) => {
      ready = healthy;
      if (!healthy) console.error('Account deletion waits for the next sweep; the Credential Service did not pass its health check');
      return healthy;
    }).finally(() => { waiting = undefined; });
    return waiting;
  }

  async function sweep(): Promise<void> {
    if (await untilReady()) await enqueuePending();
  }

  async function finish(intent: AccountDeletionIntent): Promise<void> {
    // Another task erasing this account renews its lease; this sweep leaves the deletion to it.
    const ran = await store().accountDeletionLockUnlessLive(intent.accountId, async () => {
      const authorized = await store().accountDeletion(intent.accountId);
      if (authorized?.status !== 'authorized') return;
      if (authorized.operationId !== intent.operationId) throw new HttpError(409, 'Account deletion authorization no longer matches');
      const account = await store().loadAccount(intent.accountId);
      if (account !== null && account.deletionOperationId !== intent.operationId) {
        throw new HttpError(409, 'Account deletion authorization no longer matches');
      }
      await deleteAccount(intent.accountId);
      await store().completeAccountDeletion(authorized);
      console.info(`Account deletion completed operation_id=${intent.operationId}`);
    });
    if (!ran) console.info(`Account deletion continues on another task operation_id=${intent.operationId}`);
  }

  async function enqueuePending(): Promise<void> {
    for (const intent of await store().pendingAccountDeletions()) {
      if (finishing.has(intent.accountId)) continue;
      finishing.add(intent.accountId);
      void finish(intent).catch((error: unknown) => {
        console.error('Account deletion failed; it remains pending', intent.accountId, error);
      }).finally(() => { finishing.delete(intent.accountId); });
    }
  }

  return {
    /** Record expired Guests' deletions in the background, then enqueue every pending deletion without waiting on it or on the Credential Service. */
    async recover(): Promise<void> {
      expiring ??= Promise.resolve().then(() => store().expireGuests()).then(sweep).catch((error: unknown) => {
        console.error('Guest expiry failed; it remains pending', error);
      }).finally(() => { expiring = undefined; });
      if (ready) {
        await enqueuePending();
        return;
      }
      void sweep().catch((error: unknown) => { console.error('Account deletion failed; it remains pending', error); });
    },
  };
}
