import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sweepEvery } from './task-drain.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('sweeps on its interval until the task drains, then never again', async () => {
  let draining = false;
  const sweep = vi.fn(async () => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);

  sweepEvery(1000, async () => draining, sweep);
  await vi.advanceTimersByTimeAsync(3000);
  expect(sweep).toHaveBeenCalledTimes(3);

  draining = true;
  await vi.advanceTimersByTimeAsync(10_000);
  draining = false;
  await vi.advanceTimersByTimeAsync(10_000);

  expect(sweep).toHaveBeenCalledTimes(3);
  expect(console.log).toHaveBeenCalledWith('This Chat Service task is draining; its background sweeps stop');
});

it('keeps sweeping, and says so, when it cannot tell whether the task drains', async () => {
  const sweep = vi.fn(async () => undefined);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  sweepEvery(1000, async () => { throw new Error('ECS task metadata answered HTTP 500'); }, sweep);
  await vi.advanceTimersByTimeAsync(2000);

  expect(sweep).toHaveBeenCalledTimes(2);
  expect(errors).toHaveBeenCalledWith('Cannot tell whether this Chat Service task is draining; its background sweeps go on', expect.objectContaining({ message: 'ECS task metadata answered HTTP 500' }));
});

it('sweeps no more once stopped', async () => {
  const sweep = vi.fn(async () => undefined);

  const stop = sweepEvery(1000, async () => false, sweep);
  await vi.advanceTimersByTimeAsync(1000);
  stop();
  await vi.advanceTimersByTimeAsync(5000);

  expect(sweep).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps its interval after a failed sweep', async () => {
  const sweep = vi.fn(async () => { throw new Error('sweep failed'); });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  sweepEvery(1000, async () => false, sweep);
  await vi.advanceTimersByTimeAsync(2000);

  expect(sweep).toHaveBeenCalledTimes(2);
  expect(errors).toHaveBeenCalledWith('Background sweep failed', expect.objectContaining({ message: 'sweep failed' }));
});
