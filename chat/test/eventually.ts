import { setTimeout } from 'node:timers/promises';
import { getCurrentTest } from 'vitest/suite';

const STALLED = Symbol('stalled');
const DEADLINE_BEFORE_TIMEOUT_MS = 250;

/**
 * Retry `check` every 50 ms until it passes, and return what it returns. A loaded machine outlasts any fixed deadline,
 * so it gives up just before the running test's own timeout, with the check's last error.
 */
export async function eventually<T>(check: () => T | Promise<T>): Promise<T> {
  const deadline = testDeadline();
  const stalled = new Promise<typeof STALLED>((resolve) => deadline.addEventListener('abort', () => resolve(STALLED), { once: true }));
  let lastError: unknown;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop -- retries until the check passes
      const result = await Promise.race([(async () => check())(), stalled]);
      if (result !== STALLED) return result;
      throw new Error(`The check was still running at the test's deadline; it last failed with: ${String(lastError)}`, { cause: lastError });
    } catch (error) {
      if (deadline.aborted) throw error;
      lastError = error;
    }
    // eslint-disable-next-line no-await-in-loop -- retries until the check passes
    await setTimeout(50, undefined, { signal: deadline }).catch(() => {
      throw lastError;
    });
  }
}

function testDeadline(): AbortSignal {
  const test = getCurrentTest();
  const started = test?.result?.startTime;
  if (test === undefined || started === undefined) throw new Error('eventually() waits only inside a running test');
  const remaining = started + test.timeout - DEADLINE_BEFORE_TIMEOUT_MS - (performance.timeOrigin + performance.now());
  return AbortSignal.any([test.context.signal, AbortSignal.timeout(Math.max(0, Math.floor(remaining)))]);
}
