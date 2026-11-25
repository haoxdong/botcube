import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountResources as UserResources } from './account-resources.js';
import { memoryDocuments } from '../test/memory-documents.js';
import { pooledAccessPoints } from './files-pool.js';
import { accountFilesEfs as userFilesEfs } from './files-efs.js';
import { MOUNT_SECONDS, RETIREMENT_GRACE_MS } from './files-shared.js';

const arn = 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0001';
const directory = '/accounts/00000000000000000000000000000001';
const records = () => {
  const documents = memoryDocuments();
  for (const user of ['acct_a', 'acct_b', 'acct_c']) {
    documents.items.set(`ACCOUNT#${user}\u0000META`, { pk: `ACCOUNT#${user}`, sk: 'META', record: { accountId: user } });
  }
  return new UserResources('chat', documents);
};
afterEach(() => vi.restoreAllMocks());

it('leases one slot for concurrent wakes and refuses a second User when full', async () => {
  const store = records();
  const pool = pooledAccessPoints([{ arn, directory }], () => store, { startingSlot: () => 0 });
  expect(await Promise.all(Array.from({ length: 8 }, () => pool.create('/accounts/a', 'a', 'acct_a')))).toEqual(Array(8).fill(arn));
  expect(await store.filesPoolUsage()).toBe(1);
  await expect(pool.create('/accounts/b', 'b', 'acct_b')).rejects.toThrow('pool is full');
  expect(await store.filesAccessPoint('acct_b')).toBeNull();
});

it('never leases one slot to two Users', async () => {
  const store = records();
  const pool = pooledAccessPoints([{ arn, directory }], () => store, { startingSlot: () => 0 });
  const results = await Promise.allSettled(['acct_a', 'acct_b'].map(user => pool.create(`/accounts/${user}`, user, user)));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
});

it('refuses retirement and propagates storage failures', async () => {
  const store = records();
  const pool = pooledAccessPoints([{ arn, directory }], () => store, { startingSlot: () => 0 });
  await store.retireFiles('acct_a', null, Date.now());
  await expect(pool.create('/accounts/a', 'a', 'acct_a')).rejects.toThrow('pool is full');
  vi.spyOn(store, 'claimFilesPoolSlot').mockRejectedValue(new Error('DynamoDB unavailable'));
  await expect(pool.create('/accounts/b', 'b', 'acct_b')).rejects.toThrow('DynamoDB unavailable');
});

it('quarantines retirement, wipes late writes, and reuses an empty slot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'files-pool-'));
  const store = records();
  const pool = pooledAccessPoints([{ arn, directory }], () => store, { startingSlot: () => 0 });
  const files = userFilesEfs({
    root, fileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0001',
    mountTargetIp: '192.0.2.1', accessPoints: pool, records: () => store,
    linkKey: 'key',
    mountCredentials: async () => ({ accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'token', expiration: new Date().toISOString() }),
  });
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const slot = path.join(root, path.basename(directory));
  try {
    await files.mount('acct_a');
    await mkdir(slot);
    await writeFile(path.join(slot, 'agent.txt'), 'agent output');
    expect(await files.list('acct_a')).toEqual([expect.objectContaining({ name: 'agent.txt', size: 12 })]);
    const link = new URL(await files.downloadUrl('acct_a', 'agent.txt'), 'https://chat.test');
    const download = () => files.link({ method: 'GET', query: Object.fromEntries(link.searchParams), range: undefined });
    const response = await download();
    expect([response.status, await response.text()]).toEqual([200, 'agent output']);
    await files.delete('acct_a');
    expect((await download()).status).toBe(403);
    await expect(files.mount('acct_b')).rejects.toThrow('pool is full');
    await mkdir(slot);
    await writeFile(path.join(slot, 'late.txt'), 'late writer');
    vi.spyOn(Date, 'now').mockReturnValue(now + MOUNT_SECONDS * 1000 + RETIREMENT_GRACE_MS);
    await files.recoverCleanup();
    expect(await store.filesPoolUsage()).toBe(0);
    await files.mount('acct_b');
    expect(await files.list('acct_b')).toEqual([]);
    await expect(readFile(path.join(slot, 'late.txt'))).rejects.toThrow();
    await pool.delete(arn, 'acct_a');
    expect(await store.filesAccessPoint('acct_b')).toBe(arn);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps ownership when an access point is replaced at the same directory', async () => {
  const store = records();
  const old = pooledAccessPoints([{ arn, directory }], () => store, { startingSlot: () => 0 });
  await old.create('/accounts/a', 'a', 'acct_a');
  const replacement = pooledAccessPoints([{ arn: `${arn}2`, directory }], () => store, { startingSlot: () => 0 });
  await expect(replacement.create('/accounts/b', 'b', 'acct_b')).rejects.toThrow('pool is full');
});

it('allows only one cleanup worker until its filesystem work is complete', async () => {
  const documents = memoryDocuments();
  const a = new UserResources('chat', documents);
  const b = new UserResources('chat', documents);
  expect(await a.claimFilesCleanup('acct_a')).toBe(true);
  expect(await b.claimFilesCleanup('acct_a')).toBe(false);
  await a.releaseFilesCleanup('acct_a');
  expect(await b.claimFilesCleanup('acct_a')).toBe(true);
});

it('blocks a competing cleanup worker before it can wipe a reassigned directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'files-pool-workers-'));
  const store = records();
  const pool = pooledAccessPoints([{ arn, directory }], () => store, { startingSlot: () => 0 });
  const files = userFilesEfs({
    root, fileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0001',
    mountTargetIp: '192.0.2.1', accessPoints: pool, records: () => store,
    linkKey: 'key',
    mountCredentials: async () => ({ accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'token', expiration: new Date().toISOString() }),
  });
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const slot = path.join(root, path.basename(directory));
  try {
    await files.mount('acct_a');
    await files.delete('acct_a');
    vi.spyOn(Date, 'now').mockReturnValue(now + MOUNT_SECONDS * 1000 + RETIREMENT_GRACE_MS);
    let resume: () => void = () => undefined;
    let acquired: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const started = new Promise<void>(resolve => { acquired = resolve; });
    const claim = store.claimFilesCleanup.bind(store);
    vi.spyOn(store, 'claimFilesCleanup').mockImplementationOnce(async (user, ...ownership) => {
      const held = await claim(user, ...ownership);
      acquired();
      await gate;
      return held;
    });
    const first = files.recoverCleanup();
    await started;
    await expect(files.recoverCleanup()).rejects.toThrow('cleanup remains pending');
    resume();
    await first;
    await files.mount('acct_b');
    await mkdir(slot);
    await writeFile(path.join(slot, 'new.txt'), 'new User');
    await files.recoverCleanup();
    expect(await readFile(path.join(slot, 'new.txt'), 'utf8')).toBe('new User');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('prevents destination retirement while an incoming transfer is writing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'files-pool-transfer-'));
  const store = records();
  const second = '/accounts/00000000000000000000000000000002';
  const pool = pooledAccessPoints([{ arn, directory }, { arn: `${arn}2`, directory: second }], () => store, { startingSlot: () => 0 });
  const files = userFilesEfs({
    root, fileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0001',
    mountTargetIp: '192.0.2.1', accessPoints: pool, records: () => store,
    linkKey: 'key',
    mountCredentials: async () => ({ accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'token', expiration: new Date().toISOString() }),
  });
  let resume: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    await files.mount('acct_a');
    await files.mount('acct_b');
    const source = path.join(root, path.basename(directory));
    await mkdir(source);
    await writeFile(path.join(source, 'incoming.txt'), 'incoming');
    const retirement = store.filesRetirement.bind(store);
    let first = true;
    vi.spyOn(store, 'filesRetirement').mockImplementation(async user => {
      if (user === 'acct_b' && first) {
        first = false;
        entered();
        await gate;
      }
      return retirement(user);
    });
    const transfer = files.transfer('acct_a', 'acct_b');
    await started;
    await expect(files.delete('acct_b')).rejects.toThrow('cleanup is already running');
    expect(await retirement('acct_b')).toBeNull();
    resume();
    await transfer;
    expect(await readFile(path.join(root, path.basename(second), 'incoming.txt'), 'utf8')).toBe('incoming');
  } finally {
    resume();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains capacity when a retirement wipe fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'files-pool-wipe-'));
  const store = records();
  const pool = pooledAccessPoints([{ arn, directory }], () => store, { startingSlot: () => 0 });
  const files = userFilesEfs({
    root, fileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0001',
    mountTargetIp: '192.0.2.1', accessPoints: pool, records: () => store,
    linkKey: 'key',
    mountCredentials: async () => ({ accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'token', expiration: new Date().toISOString() }),
  });
  try {
    await files.mount('acct_a');
    await rm(root, { recursive: true });
    await writeFile(root, 'unavailable mount');
    await expect(files.delete('acct_a')).rejects.toThrow();
    expect(await store.filesPoolUsage()).toBe(1);
    await expect(files.mount('acct_b')).rejects.toThrow('pool is full');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses credentials from a paused wake after retirement and slot reuse', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'files-pool-paused-wake-'));
  const store = records();
  const pool = pooledAccessPoints([{ arn, directory }], () => store, { startingSlot: () => 0 });
  let resume: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const files = userFilesEfs({
    root, fileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0001',
    mountTargetIp: '192.0.2.1', accessPoints: pool, records: () => store,
    linkKey: 'key',
    mountCredentials: async () => {
      entered();
      await gate;
      return { accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'token', expiration: new Date().toISOString() };
    },
  });
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const waking = files.mountBinding('acct_a');
    await started;
    await files.delete('acct_a');
    vi.spyOn(Date, 'now').mockReturnValue(now + MOUNT_SECONDS * 1000 + RETIREMENT_GRACE_MS);
    await files.recoverCleanup();
    await files.mount('acct_b');
    const refused = expect(waking).rejects.toThrow('lease is no longer active');
    resume();
    await refused;
    expect(await store.filesAccessPoint('acct_a')).toBeNull();
    expect(await store.filesAccessPoint('acct_b')).toBe(arn);
  } finally {
    resume();
    await rm(root, { recursive: true, force: true });
  }
});

it('starts at the chosen slot and wraps around occupied slots', async () => {
  const store = records();
  const second = { arn: `${arn}2`, directory: '/accounts/00000000000000000000000000000002' };
  const pool = pooledAccessPoints([{ arn, directory }, second], () => store, { startingSlot: () => 1 });
  expect(await pool.create('/accounts/a', 'a', 'acct_a')).toBe(second.arn);
  expect(await pool.create('/accounts/b', 'b', 'acct_b')).toBe(arn);
});

it('recovers both claims of a crashed transfer without a DynamoDB edit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'files-pool-crash-'));
  const store = records();
  const second = { arn: `${arn}2`, directory: '/accounts/00000000000000000000000000000002' };
  const pool = pooledAccessPoints([{ arn, directory }, second], () => store, { startingSlot: () => 0 });
  const files = userFilesEfs({ root, fileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0001', mountTargetIp: '192.0.2.1', accessPoints: pool, records: () => store, linkKey: 'key', mountCredentials: async () => ({ accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'token', expiration: new Date().toISOString() }), cleanupWorker: { identity: async () => ({ cluster: 'cluster', taskArn: 'new-task' }), stopped: async claim => claim.taskArn === 'dead-task' } });
  try {
    await files.mount('acct_a');
    await files.mount('acct_b');
    await mkdir(path.join(root, path.basename(directory)));
    await writeFile(path.join(root, path.basename(directory), 'remaining.txt'), 'preserved');
    const now = Date.now();
    await store.retireFiles('acct_a', 'acct_b', now);
    const dead = { token: 'dead', cluster: 'cluster', taskArn: 'dead-task', createdAt: now };
    await store.claimFilesCleanup('acct_a', dead);
    await store.claimFilesCleanup('acct_b', dead);
    vi.spyOn(Date, 'now').mockReturnValue(now + MOUNT_SECONDS * 1000 + RETIREMENT_GRACE_MS);
    await files.recoverCleanup();
    expect(await readFile(path.join(root, path.basename(second.directory), 'remaining.txt'), 'utf8')).toBe('preserved');
    expect(await store.filesCleanupClaim('acct_a')).toBeNull();
    expect(await store.filesCleanupClaim('acct_b')).toBeNull();
    expect(await store.filesAccessPoint('acct_a')).toBeNull();
    expect(await store.filesPoolUsage()).toBe(1);
    await files.mount('acct_c');
    expect(await files.list('acct_c')).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
