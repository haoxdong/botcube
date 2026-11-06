import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { TEST_AWS_ENV } from './test/fakes/credentials.js';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  resolve: { alias: { 'botcube-chat': fileURLToPath(new URL('./src/index.ts', import.meta.url)) } },
  test: {
    include: ['chat/src/**/*.test.ts'],
    globalSetup: ['chat/test/fakes/global-setup.ts'],
    pool: 'forks',
    maxWorkers: 4,
    env: { TZ: 'UTC', ...TEST_AWS_ENV },
  },
});
