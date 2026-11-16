import { afterEach, expect, it, vi } from 'vitest';
import { ecsCleanupWorker } from './files-cleanup-worker.js';

afterEach(() => vi.restoreAllMocks());

it('reclaims only a stopped task or an explicitly aged-out task', async () => {
  const send = vi.fn<NonNullable<Parameters<typeof ecsCleanupWorker>[1]>>();
  const worker = ecsCleanupWorker(undefined, send);
  const claim = { token: 'owner', cluster: 'cluster', taskArn: 'task', createdAt: Date.now() };
  send.mockResolvedValueOnce({ tasks: [{ taskArn: 'task', desiredStatus: 'STOPPED', lastStatus: 'RUNNING' }] });
  expect(await worker.stopped(claim)).toBe(false);
  send.mockResolvedValueOnce({ tasks: [{ taskArn: 'task', lastStatus: 'STOPPED' }] });
  expect(await worker.stopped(claim)).toBe(true);
  send.mockResolvedValueOnce({ tasks: [] });
  expect(await worker.stopped(claim)).toBe(false);
  send.mockResolvedValueOnce({ failures: [{ arn: 'task', reason: 'MISSING' }] });
  expect(await worker.stopped(claim)).toBe(false);
  send.mockResolvedValueOnce({ failures: [{ arn: 'task', reason: 'MISSING' }] });
  expect(await worker.stopped({ ...claim, createdAt: Date.now() - 3 * 60 * 60 * 1000 })).toBe(true);
  send.mockRejectedValueOnce(new Error('ECS unavailable'));
  await expect(worker.stopped(claim)).rejects.toThrow('ECS unavailable');
});
