import { expect, it } from 'vitest';
import { manifestAccessPoints } from './files-pool-manifest.js';
import { AccountResources as UserResources } from './account-resources.js';
import { memoryDocuments } from '../test/memory-documents.js';

const slots = [{ arn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0001', directory: '/accounts/00000000000000000000000000000001' }];

it('shares one manifest read across concurrent leases and directory lookups', async () => {
  const records = new UserResources('chat', memoryDocuments());
  let reads = 0;
  const pool = manifestAccessPoints(async () => { reads += 1; return slots; }, () => records);
  const results = await Promise.all([pool.create('/accounts/a', 'a', 'acct_a'), pool.create('/accounts/a', 'a', 'acct_a')]);
  expect(results).toEqual([slots[0]?.arn, slots[0]?.arn]);
  expect(await pool.directory?.(results[0])).toBe(slots[0]?.directory);
  expect(reads).toBe(1);
});

it('propagates unavailable or malformed manifests without runtime creation', async () => {
  const records = new UserResources('chat', memoryDocuments());
  const pool = manifestAccessPoints(async () => { throw new Error('S3 unavailable'); }, () => records);
  await expect(pool.create('/accounts/a', 'a', 'acct_a')).rejects.toThrow('S3 unavailable');
  const invalid = manifestAccessPoints(async () => [{ arn: 'not-an-access-point' }], () => records);
  await expect(invalid.create('/accounts/a', 'a', 'acct_a')).rejects.toThrow();
  expect(await records.filesPoolUsage()).toBe(0);
});

it('leases background additions without restarting the serving process', async () => {
  const records = new UserResources('chat', memoryDocuments());
  let published = slots;
  const pool = manifestAccessPoints(async () => published, () => records);
  await pool.create('/accounts/a', 'a', 'acct_a');
  published = [...slots, { arn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0002', directory: '/accounts/00000000000000000000000000000002' }];
  expect(await pool.create('/accounts/b', 'b', 'acct_b')).toBe(published[1]?.arn);
});
