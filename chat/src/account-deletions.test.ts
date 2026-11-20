import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, AccountDeletionIntent } from './account-record.js';
import { accountDeletions, serviceHealthy } from './account-deletions.js';

const intent: AccountDeletionIntent = { accountId: 'acct_1', operationId: 'op_1', authorizedAt: 1, sessionBinding: 'binding', status: 'authorized' };

function deletionStore() {
  const deletions = new Map([[intent.accountId, { ...intent }]]);
  return {
    deletions,
    heldElsewhere: false,
    async accountDeletionLockUnlessLive(_accountId: string, work: () => Promise<void>) {
      if (this.heldElsewhere) return false;
      await work();
      return true;
    },
    async accountDeletion(accountId: string) { return deletions.get(accountId) ?? null; },
    async loadAccount(_accountId: string): Promise<Account | null> { return null; },
    async completeAccountDeletion(authorized: AccountDeletionIntent) { deletions.set(authorized.accountId, { ...authorized, status: 'completed' }); },
    async pendingAccountDeletions() { return [...deletions.values()].filter(({ status }) => status === 'authorized'); },
    async expireGuests() {},
  };
}

function healthChecks(statuses: number[]) {
  const seen: number[] = [];
  const fetch = vi.fn(async (url: string) => {
    expect(url).toBe('http://credentials.test:8081/health');
    const status = statuses.shift() ?? 503;
    seen.push(status);
    if (status === 0) throw new TypeError('fetch failed');
    return new Response(null, { status });
  });
  return { fetch, seen };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => { vi.restoreAllMocks(); });

describe('the first deletion sweep after a wake', () => {
  it('sends no revoke until the Credential Service passes its health check, then finishes the pending deletion', async () => {
    const store = deletionStore();
    const checks = healthChecks([0, 503, 200]);
    const revoked: number[] = [];
    let clock = 0;
    const deletions = accountDeletions({
      store: () => store,
      deleteAccount: async () => { revoked.push(checks.seen.length); },
      credentialsReady: () => serviceHealthy('http://credentials.test:8081/rpc', {
        fetch: checks.fetch, now: () => clock, sleep: async (ms) => { clock += ms; }, within: 120_000, every: 5_000,
      }),
    });

    await deletions.recover();
    await vi.waitFor(() => expect(store.deletions.get(intent.accountId)?.status).toBe('completed'));

    expect(checks.seen).toEqual([0, 503, 200]);
    expect(revoked).toEqual([3]);
  });

  it('serves on while it waits: recover returns before the Credential Service is healthy', async () => {
    const store = deletionStore();
    let pass!: (healthy: boolean) => void;
    const deleteAccount = vi.fn(async () => {});
    const deletions = accountDeletions({ store: () => store, deleteAccount, credentialsReady: () => new Promise(resolve => { pass = resolve; }) });

    await deletions.recover();
    await settle();
    expect(deleteAccount).not.toHaveBeenCalled();

    pass(true);
    await vi.waitFor(() => expect(deleteAccount).toHaveBeenCalledWith(intent.accountId));
  });

  it('keeps the deletion authorized and logs one error when the health check never passes, and the next sweep retries', async () => {
    const store = deletionStore();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const checks = healthChecks([]);
    let clock = 0;
    const deleteAccount = vi.fn(async () => {});
    const deletions = accountDeletions({
      store: () => store, deleteAccount,
      credentialsReady: () => serviceHealthy('http://credentials.test:8081', {
        fetch: checks.fetch, now: () => clock, sleep: async (ms) => { clock += ms; }, within: 120_000, every: 5_000,
      }),
    });

    await expect(deletions.recover()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0]?.[0]).toMatch(/Credential Service did not pass its health check/);
    expect(checks.seen.length).toBe(25);
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(store.deletions.get(intent.accountId)?.status).toBe('authorized');

    checks.fetch.mockImplementation(async () => new Response(null, { status: 200 }));
    await deletions.recover();
    await vi.waitFor(() => expect(store.deletions.get(intent.accountId)?.status).toBe('completed'));
  });

  // While one task erases, another task's sweep waited out the 60 s lease deadline and logged an error every sweep.
  it('leaves a deletion to the task already erasing it, quietly, and finishes it once that task stops', async () => {
    const store = deletionStore();
    store.heldElsewhere = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const deleteAccount = vi.fn(async () => {});
    const deletions = accountDeletions({ store: () => store, deleteAccount });

    await deletions.recover();
    await settle();
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Account deletion continues on another task operation_id=op_1');
    expect(store.deletions.get(intent.accountId)?.status).toBe('authorized');

    store.heldElsewhere = false;
    await deletions.recover();
    await vi.waitFor(() => expect(store.deletions.get(intent.accountId)?.status).toBe('completed'));
  });

  // A live task whose erase hangs renews its lease, so only a sweep's own line shows the deletion still pending.
  it('logs each pending deletion every sweep, including one an erase is still finishing', async () => {
    const store = deletionStore();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const deletions = accountDeletions({ store: () => store, deleteAccount: () => new Promise<void>(() => {}) });

    const pendingLines = () => info.mock.calls.filter(([line]) => line === 'Account deletion pending operation_id=op_1').length;

    await deletions.recover();
    await settle();
    const first = pendingLines();
    await deletions.recover();
    await settle();

    expect(first).toBeGreaterThan(0);
    expect(pendingLines()).toBeGreaterThan(first);
  });
});
