import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import { TEST_AWS_ENV } from './chat/test/fakes/credentials.js';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const node = { pool: 'forks', env: { TZ: 'UTC' } } as const;
const liveView = 'ui/web/node_modules/bedrock-agentcore/dist/src/tools/browser/live-view/nice-dcv-web-client-sdk';
const uiWebMarkdown = ['ui/web/src/app/markdown.test.tsx'];

const uiWeb = (name: string, include: string[], exclude: string[], groupOrder: number) => ({
  test: {
    ...node,
    name,
    sequence: { groupOrder },
    include,
    exclude: [...configDefaults.exclude, ...exclude],
    environment: 'happy-dom',
    server: { deps: { inline: ['@copilotkit/react-core', 'bedrock-agentcore'] } },
    setupFiles: ['ui/web/tests/setup.ts'],
  },
  resolve: {
    alias: {
      vitest: at('node_modules/vitest'),
      '@/': at('ui/web/src/'),
      dcv: at(`${liveView}/dcvjs-esm/dcv.js`),
      'dcv-ui': at(`${liveView}/dcv-ui/dcv-ui.js`),
      '@cartridge-ui': at('ui/web/src/cartridge/default.tsx'),
    },
  },
});

export default defineConfig({
  root: at('.'),
  test: {
    pool: 'forks',
    maxWorkers: '100%',
    globalSetup: ['./vitest.global-setup.ts'],
    projects: [
      { extends: './chat/test/parity/vitest.config.ts', test: { name: 'parity', sequence: { groupOrder: 1 } } },
      {
        resolve: { alias: { 'botcube-chat': at('chat/src/index.ts') } },
        test: {
          ...node,
          name: 'chat',
          restoreMocks: true,
          include: ['chat/src/**/*.test.ts', 'infra/ecs/parking/**/*.test.ts', 'infra/ecs/files/**/*.test.ts'],
          globalSetup: ['chat/test/fakes/global-setup.ts'],
          env: { ...node.env, ...TEST_AWS_ENV },
        },
      },
      {
        test: {
          ...node,
          name: 'node',
          include: ['templates/always-on/chat/src/**/*.test.ts', 'infra/ecs/origin-provider/**/*.test.ts'],
        },
      },
      uiWeb('ui-web', ['ui/web/src/**/*.test.{ts,tsx}', 'ui/web/.storybook/*.test.ts', 'templates/always-on/ui/web/src/**/*.test.tsx'], uiWebMarkdown, 0),
      uiWeb('ui-web-markdown', uiWebMarkdown, [], 2),
    ],
  },
});
