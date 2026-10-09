import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { purgeQueue } from './purges.js';
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
    const purge = purgeQueue(invoke, async () => undefined);

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
    const purge = purgeQueue(invoke, async () => undefined);

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
    purgeQueue(invoke, async () => undefined)([session('session-1')]);

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
    purgeQueue(invoke, async () => undefined, [10])([session('session-1'), session('session-2')]);

    await vi.advanceTimersByTimeAsync(10);

    expect(invoke.mock.calls).toEqual([purgeOf('session-1'), purgeOf('session-1'), purgeOf('session-2')]);
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });
  it('waits for the Session writer to stop before purging its events', async () => {
    let stopped: (() => void) | undefined;
    const stop = vi.fn(() => new Promise<void>((resolve) => { stopped = resolve; }));
    const invoke = vi.fn<SessionApi>(async () => ({}));
    purgeQueue(invoke, stop)([session('session-1')]);

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
    purgeQueue(invoke, stop, [10])([session('session-1')]);

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
    purgeQueue(invoke, stop, [10])([session('session-1')]);

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
    purgeQueue(invoke, stop)([session('session-1')]);

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

  it('lets another Session purge while a stranded registration waits, then resumes the first', async () => {
    let pending = true;
    const stop = vi.fn(async ({ session_id: sessionId }: SessionPurge) => {
      if (sessionId === 'session-1' && pending) throw new SessionDispatchPendingError('registered writer');
    });
    const invoke = vi.fn<SessionApi>(async () => ({}));
    purgeQueue(invoke, stop)([session('session-1'), session('session-2')]);
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
    purgeQueue(invoke, stop)([session('session-1')]);
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
    purgeQueue(invoke, async () => undefined, [10, 10], complete)([session('session-1')]);
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
    const enqueue = purgeQueue(invoke, stop, [10]);
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

  it('reports an absent Sandbox and purges its remaining durable events', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const invoke = vi.fn<SessionApi>(async () => ({}));
    purgeQueue(invoke, async () => 'absent')([session('session-1')]);

    await vi.advanceTimersByTimeAsync(0);
    expect(info.mock.calls).toEqual([
      ['Session Sandbox is absent; purging remaining Session events. session_id=session-1'],
    ]);
    expect(invoke.mock.calls).toEqual([purgeOf('session-1')]);
  });

});
