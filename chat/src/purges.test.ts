import { accountDeletionFailureFilter } from '../../infra/ecs/cdk/lib/account-deletion-filter.js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { RuntimeAdmissionUnprovedError } from './session-lifecycle.js';
import { accountErasesRunning, purgeQueue } from './purges.js';
import type { SessionApi } from './session-api.js';
import { SessionDispatchPendingError, type SessionPurge, type SessionSummary } from './session-metadata.js';
import { defined } from '../test/defined.js';

const session = (sessionId: string): SessionSummary => ({
  session_id: sessionId,
  filing_user_id: 'filed-acct_owner',
  title: '',
  created_at: '2026-09-25T00:00:00Z',
  updated_at: '2026-09-25T00:00:00Z',
});

/** The filing user ID the test bot gives an account. */
const filed = (owner: string) => `filed-${owner}`;

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
  it('recovers serially without duplicating jobs when discovery repeats during a purge', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const completed: string[] = [];
    const invoke = vi.fn<SessionApi>(async (event) => {
      if (event.operation !== 'purge') throw new Error('expected a purge');
      if (event.sessionId === 'recovery-first') await blocked;
      return {};
    });
    const queue = purgeQueue(invoke, filed, async () => undefined, [], async ({ session_id }) => { completed.push(session_id); });
    queue.recover([session('recovery-first'), session('recovery-second')]);
    await vi.advanceTimersByTimeAsync(0);
    queue.recover([session('recovery-first'), session('recovery-second'), session('recovery-third')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls).toEqual([purgeOf('recovery-first')]);
    expect(completed).toEqual([]);

    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(completed).toEqual(['recovery-first', 'recovery-second', 'recovery-third']);
    expect(invoke.mock.calls).toEqual([purgeOf('recovery-first'), purgeOf('recovery-second'), purgeOf('recovery-third')]);
  });

  it('completes account erasure without waiting for unrelated queued purges', async () => {
    const completed: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const invoke: SessionApi = async (event) => {
      if (event.operation !== 'purge') throw new Error('expected a purge');
      if (event.sessionId === 'unrelated') await blocked;
      return {};
    };
    const queue = purgeQueue(invoke, filed, async () => undefined, [], async ({ session_id }) => {
      completed.push(session_id);
    });
    queue([session('unrelated'), session('also-unrelated')]);
    await vi.advanceTimersByTimeAsync(0);
    const erasure = queue.wait([{ ...session('account-session'), filing_user_id: 'filed-other-owner' }]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect([...completed]).toEqual(['account-session']);
      await erasure;
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
      await erasure;
    }
    expect(completed).toEqual(['account-session', 'unrelated', 'also-unrelated']);
  });

  // One at a time, a 1,948-Session account erase outlived every task that ran it.
  it('erases an account four Sessions at a time and logs its progress at most once a minute', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let running = 0;
    let most = 0;
    const queue = purgeQueue(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      running -= 1;
      return {};
    }, filed, async () => undefined, []);
    const erasure = queue.wait(Array.from({ length: 12 }, (_, index) => session(`session-${index}`)));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(most).toBe(4);
    expect(consoleInfo.mock.calls.filter(([line]) => String(line).startsWith('Account history erase'))).toEqual([
      ['Account history erase purged 9 of 12 Sessions'],
    ]);
    await erasure;
  });

  it('halves account erasure concurrency after a failure and retries the Session after its backoff', async () => {
    let running = 0;
    const startedWith: number[] = [];
    // Erases already running when the first one fails run on; none started after them overlaps more than two.
    const firstWave = Date.now() + 1_000;
    const afterFailure: number[] = [];
    let failed = false;
    const completed: string[] = [];
    const queue = purgeQueue(async (event) => {
      if (event.operation !== 'purge') throw new Error('expected a purge');
      running += 1;
      startedWith.push(running);
      if (Date.now() > firstWave) afterFailure.push(running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        if (event.sessionId === 'session-0' && !failed) {
          failed = true;
          throw new Error('throttled');
        }
        return {};
      } finally {
        running -= 1;
      }
    }, filed, async () => undefined, [5_000], async ({ session_id }) => { completed.push(session_id); });
    const erasure = queue.wait(Array.from({ length: 8 }, (_, index) => session(`session-${index}`)));
    await vi.advanceTimersByTimeAsync(30_000);
    await erasure;
    expect(completed.sort()).toEqual(Array.from({ length: 8 }, (_, index) => `session-${index}`).sort());
    expect(startedWith.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(afterFailure.length).toBeGreaterThan(0);
    expect(Math.max(...afterFailure)).toBeLessThanOrEqual(2);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('retrying in 5s with 2 at once. session_id=session-0'), expect.any(Error));
  });

  // A width that only halved held a 1,736-Session erase at one at a time after three throttles.
  it('regrows account erasure by one after each minute without a failure, up to four', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let running = 0;
    const widths: number[] = [];
    let failures = 0;
    const queue = purgeQueue(async (event) => {
      if (event.operation !== 'purge') throw new Error('expected a purge');
      running += 1;
      widths.push(running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        // The first two erases to finish fail once each: 4 → 2 → 1.
        if (failures < 2) {
          failures += 1;
          throw new Error('throttled');
        }
        return {};
      } finally {
        running -= 1;
      }
    }, filed, async () => undefined, [1_000, 1_000]);
    const erasure = queue.wait(Array.from({ length: 60 }, (_, index) => session(`session-${index}`)));
    await vi.advanceTimersByTimeAsync(10_000);
    const afterThrottles = widths.length;
    await vi.advanceTimersByTimeAsync(400_000);
    await erasure;
    const regrown = widths.slice(afterThrottles);
    expect(Math.min(...regrown)).toBe(1);
    expect(Math.max(...regrown)).toBe(4);
    expect(consoleInfo.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('regrew'))).toEqual([
      'Account history erase regrew to 2 at once',
      'Account history erase regrew to 3 at once',
      'Account history erase regrew to 4 at once',
    ]);
  });

  it('skips a Session whose writer is still registered, erases the rest, then rejects with that error', async () => {
    const pending = new SessionDispatchPendingError('Session dispatch is still registered');
    const completed: string[] = [];
    const queue = purgeQueue(async () => ({}), filed, async ({ session_id }) => {
      if (session_id === 'session-2') throw pending;
    }, [5_000], async ({ session_id }) => { completed.push(session_id); });
    const erasure = queue.wait(Array.from({ length: 10 }, (_, index) => session(`session-${index}`)));
    await expect(erasure).rejects.toBe(pending);
    expect(completed.sort()).toEqual(Array.from({ length: 10 }, (_, index) => `session-${index}`).filter((id) => id !== 'session-2').sort());
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  // Production parking idled origin out from under a running erase; it counts each running erase as activity.
  it('counts an account erase as running until it settles, whether it succeeds or fails', async () => {
    const failure = new Error('writer still running');
    const queue = purgeQueue(async () => ({}), filed, async ({ session_id }) => {
      if (session_id === 'fails') throw failure;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }, []);
    const erased = queue.wait([session('session-0')]);
    const failed = queue.wait([session('fails')]);
    expect(accountErasesRunning()).toBe(2);
    await expect(failed).rejects.toBe(failure);
    expect(accountErasesRunning()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await erased;
    expect(accountErasesRunning()).toBe(0);
  });

  it('stops starting Sessions once an account erase fails for good, and rejects', async () => {
    const failure = new Error('writer still running');
    const erased: string[] = [];
    const queue = purgeQueue(async (event) => {
      if (event.operation !== 'purge') throw new Error('expected a purge');
      erased.push(event.sessionId);
      return {};
    }, filed, async ({ session_id }) => {
      if (session_id === 'session-0') throw failure;
    }, []);
    await expect(queue.wait(Array.from({ length: 12 }, (_, index) => session(`session-${index}`)))).rejects.toBe(failure);
    expect(erased).not.toContain('session-11');
  });

  it('rejects account erasure when its writer cannot stop, without blocking background purges', async () => {
    const failure = new Error('writer still running');
    const erased: string[] = [];
    const completed: string[] = [];
    const queue = purgeQueue(async (event) => {
      if (event.operation !== 'purge') throw new Error('expected a purge');
      erased.push(event.sessionId);
      return {};
    }, filed, async ({ session_id }) => {
      if (session_id === 'account-session') throw failure;
    }, [], async ({ session_id }) => { completed.push(session_id); });

    await expect(queue.wait([session('account-session')])).rejects.toBe(failure);
    queue([session('unrelated')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(erased).toEqual(['unrelated']);
    expect(completed).toEqual(['unrelated']);
    expect(consoleError).toHaveBeenCalledWith('Session purge failed; account history deletion remains pending', failure);
    const [line] = defined(consoleError.mock.calls.find(([, error]) => error === failure), 'the emitted purge failure');
    const { logPatternString } = accountDeletionFailureFilter;
    expect(logPatternString).toMatch(/^\?"[^"]+"(?: \?"[^"]+")*$/);
    const terms = [...logPatternString.matchAll(/\?"([^"]+)"/g)].map(([, term]) => defined(term, 'a metric filter term'));
    expect(terms.some((term) => String(line).includes(term)),
      `Expected ${JSON.stringify(line)} to match ${logPatternString}`).toBe(true);
  });

  it('purges each Session in turn, starting the next once the last is done', async () => {
    const done: (() => void)[] = [];
    const invoke = vi.fn<SessionApi>(() => new Promise((resolve) => done.push(() => resolve({}))));
    const purge = purgeQueue(invoke, filed, async () => undefined);

    purge([session('session-1'), session('session-2')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1')]);

    defined(done[0], 'a pending purge')();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1'), purgeOf('session-2')]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('purges a claimed Session under its filing ID, then its owner\'s actor, before completing it', async () => {
    const done: (() => void)[] = [];
    const invoke = vi.fn<SessionApi>(() => new Promise((resolve) => done.push(() => resolve({}))));
    const complete = vi.fn(async () => undefined);
    const purge = purgeQueue(invoke, filed, async () => undefined, [], complete);

    purge([{ ...session('session-1'), owner: 'acct_claiming' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1')]);

    defined(done[0], 'a pending purge')();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls.at(-1)).toEqual([{ operation: 'purge', sessionId: 'session-1', userId: 'filed-acct_claiming' }, 900]);
    expect(complete).not.toHaveBeenCalled();

    defined(done[1], 'a pending purge')();
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('purges an unclaimed Session once, its owner filing under the filing ID', async () => {
    const invoke = vi.fn<SessionApi>(async () => ({}));

    purgeQueue(invoke, filed, async () => undefined)([{ ...session('session-1'), owner: 'acct_owner' }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke.mock.calls).toEqual([purgeOf('session-1')]);
  });

  it('queues a later batch behind the one still purging', async () => {
    const done: (() => void)[] = [];
    const invoke = vi.fn<SessionApi>(() => new Promise((resolve) => done.push(() => resolve({}))));
    const purge = purgeQueue(invoke, filed, async () => undefined);

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
    purgeQueue(invoke, filed, async () => undefined)([session('session-1')]);

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
    purgeQueue(invoke, filed, async () => undefined, [10])([session('session-1'), session('session-2')]);

    await vi.advanceTimersByTimeAsync(10);

    expect(invoke.mock.calls).toEqual([purgeOf('session-1'), purgeOf('session-1'), purgeOf('session-2')]);
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });
  it('waits for the Session writer to stop before purging its events', async () => {
    let stopped: (() => void) | undefined;
    const stop = vi.fn(() => new Promise<void>((resolve) => { stopped = resolve; }));
    const invoke = vi.fn<SessionApi>(async () => ({}));
    purgeQueue(invoke, filed, stop)([session('session-1')]);

    await vi.advanceTimersByTimeAsync(0);
    expect(stop.mock.calls).toEqual([[session('session-1')]]);
    expect(invoke).not.toHaveBeenCalled();
    defined(stopped, 'the pending Session stop')();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1')]);
  });

  it('retries a failed stop and never purges while the writer can still run', async () => {
    const failure = new Error('Runtime stop denied');
    const stop = vi.fn(async () => { throw failure; });
    const invoke = vi.fn<SessionApi>(async () => ({}));
    purgeQueue(invoke, filed, stop, [10])([session('session-1')]);

    await vi.advanceTimersByTimeAsync(10);
    expect(stop.mock.calls).toEqual(Array(2).fill([session('session-1')]));
    expect(invoke).not.toHaveBeenCalled();
    expect(consoleError.mock.calls).toEqual([
      ['Session purge failed; the Session stays fenced. session_id=session-1', failure],
    ]);
  });

  it('purges once stopping the writer succeeds on retry', async () => {
    const stop = vi.fn().mockRejectedValueOnce(new Error('stop conflict')).mockResolvedValue(undefined);
    const invoke = vi.fn<SessionApi>(async () => ({}));
    purgeQueue(invoke, filed, stop, [10])([session('session-1')]);

    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1')]);
  });

  it('keeps observing a live registration after 155 seconds and purges when it clears', async () => {
    let pending = true;
    const failure = new SessionDispatchPendingError('registered writer');
    const stop = vi.fn(async () => { if (pending) throw failure; });
    const invoke = vi.fn<SessionApi>(async () => ({}));
    purgeQueue(invoke, filed, stop)([session('session-1')]);

    await vi.advanceTimersByTimeAsync(155_000);
    expect(stop).toHaveBeenCalledTimes(4);
    expect(invoke).not.toHaveBeenCalled();
    expect(consoleError.mock.calls).toEqual([
      ['Session purge failed; the Session stays fenced. session_id=session-1', failure],
    ]);
    await vi.advanceTimersByTimeAsync(45_000);
    pending = false;
    await vi.advanceTimersByTimeAsync(75_000);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1')]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops observing a pending purge once the task drains, leaving it to the next revision', async () => {
    let draining = false;
    const stop = vi.fn(async () => { throw new SessionDispatchPendingError('registered writer'); });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    purgeQueue(vi.fn<SessionApi>(async () => ({})), filed, stop, undefined, undefined, undefined, async () => draining)([session('session-1')]);

    await vi.advanceTimersByTimeAsync(40_000);
    const observed = stop.mock.calls.length;
    draining = true;
    await vi.advanceTimersByTimeAsync(600_000);

    expect(observed).toBeGreaterThan(1);
    expect(stop).toHaveBeenCalledTimes(observed);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets another Session purge while a stranded registration waits, then resumes the first', async () => {
    let pending = true;
    const stop = vi.fn(async ({ session_id: sessionId }: SessionPurge) => {
      if (sessionId === 'session-1' && pending) throw new SessionDispatchPendingError('registered writer');
    });
    const invoke = vi.fn<SessionApi>(async () => ({}));
    purgeQueue(invoke, filed, stop)([session('session-1'), session('session-2')]);
    await vi.advanceTimersByTimeAsync(155_000);
    expect(invoke.mock.calls).toEqual([purgeOf('session-2')]);
    pending = false;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(invoke.mock.calls).toEqual([purgeOf('session-2'), purgeOf('session-1')]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains all four actual failure attempts after waiting for a registered writer', async () => {
    let pending = true;
    const failure = new Error('Runtime stop denied');
    const stop = vi.fn(async () => {
      if (pending) throw new SessionDispatchPendingError('registered writer');
      throw failure;
    });
    const invoke = vi.fn<SessionApi>(async () => ({}));
    purgeQueue(invoke, filed, stop)([session('session-1')]);
    await vi.advanceTimersByTimeAsync(155_000);
    pending = false;
    await vi.advanceTimersByTimeAsync(120_000 + 155_000);
    expect(stop).toHaveBeenCalledTimes(8);
    expect(invoke).not.toHaveBeenCalled();
    expect(consoleError.mock.calls.at(-1)).toEqual([
      'Session purge failed; the Session stays fenced. session_id=session-1', failure,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not acknowledge failed purge work and reports acknowledgment failures through the existing retries', async () => {
    const failure = new Error('durable acknowledgement failed');
    const invoke = vi.fn<SessionApi>().mockRejectedValueOnce(new Error('event purge failed')).mockResolvedValue({});
    const complete = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    purgeQueue(invoke, filed, async () => undefined, [10, 10], complete)([session('session-1')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(complete.mock.calls).toEqual([[session('session-1')]]);
    expect(consoleWarn.mock.calls.at(-1)).toEqual(['Session purge attempt failed; retrying in 0.01s. session_id=session-1', failure]);
    await vi.advanceTimersByTimeAsync(10);
    expect(complete.mock.calls).toEqual(Array(2).fill([session('session-1')]));
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deduplicates recovery while a dispatch is pending and permits a later explicit retry', async () => {
    let pending = true;
    const stop = vi.fn(async () => {
      if (pending) throw new SessionDispatchPendingError('session-1');
    });
    const invoke = vi.fn<SessionApi>(async () => ({}));
    const enqueue = purgeQueue(invoke, filed, stop, [10]);
    enqueue([session('session-1')]);
    await vi.advanceTimersByTimeAsync(0);
    enqueue([session('session-1')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledTimes(1);
    pending = false;
    await vi.advanceTimersByTimeAsync(10);
    expect(invoke).toHaveBeenCalledTimes(1);
    enqueue([session('session-1')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('alarms and permits recovery when recording an unproved fence fails', async () => {
    const failure = new RuntimeAdmissionUnprovedError();
    const persistenceError = new Error('DynamoDB unavailable');
    const stop = vi.fn(async () => { throw failure; });
    const invoke = vi.fn<SessionApi>(async () => ({}));
    const recordFence = vi.fn().mockRejectedValueOnce(persistenceError).mockResolvedValue(undefined);
    const queue = purgeQueue(invoke, filed, stop, [], async () => undefined, recordFence);
    queue([session('session-1')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(consoleError.mock.calls.at(-1)).toEqual([
      'Session purge failed; recording the unproved admission fence failed. session_id=session-1', persistenceError,
    ]);
    queue([session('session-1')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(recordFence).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports an absent Sandbox and purges its remaining durable events', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const invoke = vi.fn<SessionApi>(async () => ({}));
    purgeQueue(invoke, filed, async () => 'absent')([session('session-1')]);

    await vi.advanceTimersByTimeAsync(0);
    expect(info.mock.calls).toEqual([
      ['Session Sandbox is absent; purging remaining Session events. session_id=session-1'],
    ]);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1')]);
  });

});
