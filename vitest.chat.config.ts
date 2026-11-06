import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { TEST_AWS_ENV } from './chat/test/fakes/credentials.js';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['chat/src/**/*.test.ts', 'chat/test/local-smoke.test.ts'],
    globalSetup: ['chat/test/fakes/global-setup.ts'],
    pool: 'forks',
    env: { TZ: 'UTC', ...TEST_AWS_ENV },
    maxWorkers: 4,
  },
});
