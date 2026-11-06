import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { startProcess } from '../test/fakes/process.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each([0, 20_000])('names where a silent start waits when its child exits after %i ms', async (exitDelayMs) => {
  vi.useFakeTimers();
  const child = Object.assign(new ChildProcess(), {
    pid: 1234,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValue(child);
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 'SIGABRT') {
      child.stderr.write('Current thread (most recent call first):\n  File "<string>", line 1 in <module>\n');
      setTimeout(() => {
        Object.assign(child, { signalCode: 'SIGABRT' });
        child.emit('close', null, 'SIGABRT');
      }, exitDelayMs);
    }
    return true;
  });

  const start = startProcess({
    command: 'python3 -c "import time; time.sleep(60)"',
    env: { PYTHONFAULTHANDLER: '1' },
    url: 'http://127.0.0.1:9/never',
    listening: 'never printed',
    readyTimeoutMs: 1_000,
  });
  expect(spawn).toHaveBeenCalledWith(
    'python3 -c "import time; time.sleep(60)"',
    expect.objectContaining({ env: { PYTHONFAULTHANDLER: '1' } }),
  );
  const diagnostic = start.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(22_000);
  expect(await diagnostic).toEqual(new Error(
    '`python3 -c "import time; time.sleep(60)"` did not print "never printed" and answer http://127.0.0.1:9/never within 1000ms:\n' +
      'Current thread (most recent call first):\n  File "<string>", line 1 in <module>\n',
  ));
});
