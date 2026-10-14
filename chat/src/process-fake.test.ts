import { expect, it } from 'vitest';
import { startProcess } from '../test/fakes/process.js';

// #4020: a restarted Harness that hung before printing anything failed local-smoke with blank output.
it('names where a silent start waits when it never answers', async () => {
  const start = startProcess({
    command: 'python3 -c "import time; time.sleep(60)"',
    env: { PATH: process.env.PATH, PYTHONFAULTHANDLER: '1' },
    url: 'http://127.0.0.1:9/never',
    listening: 'never printed',
    readyTimeoutMs: 1_000,
  });
  await expect(start).rejects.toThrow(/within 1000ms:\n[\s\S]*File "<string>", line 1 in <module>/);
});
