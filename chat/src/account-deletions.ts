import type { Account, AccountDeletionIntent } from './account-record.js';
import type { AccountStore } from './account-store.js';
import { HttpError } from './cartridge.js';

/**
 * Finish every recorded account deletion, a Guest's expiry among them, through the one erase. An erase that fails,
 * its credential revoke included, leaves the deletion authorized, so the next sweep takes it again.
 */
export function accountDeletions<A extends Account>({ store, deleteAccount }: {
  store: () => AccountStore<A>;
  deleteAccount: (accountId: string) => Promise<void>;
}) {
  const finishing = new Set<string>();
  let expiring: Promise<void> | undefined;

  async function finish(intent: AccountDeletionIntent): Promise<void> {
    await store().accountDeletionLock(intent.accountId, async () => {
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
    /** Record expired Guests' deletions in the background, then enqueue every pending deletion without waiting on it. */
    async recover(): Promise<void> {
      expiring ??= Promise.resolve().then(() => store().expireGuests()).then(enqueuePending).catch((error: unknown) => {
        console.error('Guest expiry failed; it remains pending', error);
      }).finally(() => { expiring = undefined; });
      await enqueuePending();
    },
  };
}
