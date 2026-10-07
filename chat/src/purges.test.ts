import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { purgeQueue } from './purges.js';
import type { SessionApi } from './session-api.js';
import type { SessionSummary } from './session-metadata.js';
import { defined } from '../test/defined.js';

const session = (sessionId: string): SessionSummary => ({
  session_id: sessionId,
  filing_user_id: 'filed-acct_owner',
  title: '',
  created_at: '2026-09-25T00:00:00Z',
  updated_at: '2026-09-25T00:00:00Z',
});

const purgeOf = (sessionId: string) => [{ operation: 'purge', sessionId, userId: 'filed-acct_owner' }, 900];

let consoleError: MockInstance<typeof console.error>;
let consoleWarn: MockInstance<typeof console.warn>;
beforeEach(() => {
  // Fake timers stand in for the backoff waits, so each retry happens exactly when the test says.
  vi.useFakeTimers();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a background Session purge', () => {
  it('purges each Session in turn, starting the next once the last is done', async () => {
    const done: (() => void)[] = [];
    const invoke = vi.fn<SessionApi>(() => new Promise((resolve) => done.push(() => resolve({}))));
    const purge = purgeQueue(invoke);

    purge([session('session-1'), session('session-2')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1')]);

    defined(done[0], 'a pending purge')();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1'), purgeOf('session-2')]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('queues a later batch behind the one still purging', async () => {
    const done: (() => void)[] = [];
    const invoke = vi.fn<SessionApi>(() => new Promise((resolve) => done.push(() => resolve({}))));
    const purge = purgeQueue(invoke);

    purge([session('session-1')]);
    purge([session('session-2')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1')]);

    defined(done[0], 'a pending purge')();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1'), purgeOf('session-2')]);
  });

  it('retries a failure after 5 s, 30 s and 2 min, then logs the line the Session-purge alarm matches', async () => {
    const failure = new Error('session API down');
    const invoke = vi.fn<SessionApi>(() => Promise.reject(failure));
    purgeQueue(invoke)([session('session-1')]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(invoke).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(invoke).toHaveBeenCalledTimes(3);
    // One timer at a time: were the retries unbounded, a longer advance would never return.
    await vi.advanceTimersToNextTimerAsync();

    expect(invoke.mock.calls).toEqual(Array(4).fill(purgeOf('session-1')));
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleWarn.mock.calls).toEqual([
      ['Session purge attempt failed; retrying in 5s. session_id=session-1', failure],
      ['Session purge attempt failed; retrying in 30s. session_id=session-1', failure],
      ['Session purge attempt failed; retrying in 120s. session_id=session-1', failure],
    ]);
    expect(consoleError.mock.calls).toEqual([
      ['Session purge failed; the Session stays fenced. session_id=session-1', failure],
    ]);
  });

  it('moves on to the next Session once a purge succeeds on retry', async () => {
    let failures = 1;
    const invoke = vi.fn<SessionApi>(async () => {
      if (failures-- > 0) throw new Error('throttled');
      return {};
    });
    purgeQueue(invoke, [10])([session('session-1'), session('session-2')]);

    await vi.advanceTimersByTimeAsync(10);

    expect(invoke.mock.calls).toEqual([purgeOf('session-1'), purgeOf('session-1'), purgeOf('session-2')]);
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
