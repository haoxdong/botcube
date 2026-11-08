import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { TEST_AWS_ENV } from '../fakes/credentials.js';

export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    include: ['chat/test/parity/*.test.ts'],
    globalSetup: ['chat/test/fakes/global-setup.ts'],
    pool: 'forks',
    env: { TZ: 'UTC', ...TEST_AWS_ENV },
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
