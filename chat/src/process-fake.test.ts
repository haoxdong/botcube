import { expect, it } from 'vitest';
import { startProcess } from '../test/fakes/process.js';

// #4020: a restarted Harness that hung before printing anything failed local-smoke with blank output.
// After its 1 s window the fake waits up to 5 s for the aborted process to exit, then SIGTERMs it. On Linux CI
// Python is slow to exit after SIGABRT: this ran 3–4 s and twice passed vitest's 5 s default.
it('names where a silent start waits when it never answers', { timeout: 15_000 }, async () => {
  const start = startProcess({
    command: 'python3 -c "import time; time.sleep(60)"',
    env: { PATH: process.env.PATH, PYTHONFAULTHANDLER: '1' },
    url: 'http://127.0.0.1:9/never',
    listening: 'never printed',
    readyTimeoutMs: 1_000,
  });
  await expect(start).rejects.toThrow(/within 1000ms:\n[\s\S]*File "<string>", line 1 in <module>/);
});
