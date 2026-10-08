import { resolveRepositoryRoot } from '../src/config/repository-root.js';
import type { StorybookConfig } from '@storybook/nextjs-vite';
import { CHAT_SERVICE_ORIGIN } from './chat-origin';
import path from 'node:path';
import { loadCartridgeConfig } from './cartridge-config.cjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolveRepositoryRoot(app, process.env.BOTCUBE_REPOSITORY_ROOT);
const modules = JSON.parse(
  readFileSync(path.join(repo, 'node_modules/.modules.yaml'), 'utf8')
) as { virtualStoreDir: string };
const virtualStore = path.resolve(
  repo,
  'node_modules',
  modules.virtualStoreDir
);
const cartridge = loadCartridgeConfig({ appRoot: app, repoRoot: repo });

const config: StorybookConfig = {
  framework: '@storybook/nextjs-vite',
  stories: cartridge.stories ?? ['../stories/**/*.stories.tsx'],
  previewAnnotations: cartridge.previewAnnotations ?? [],
  addons: ['@storybook/addon-a11y', '@storybook/addon-vitest'],
  staticDirs: ['public', ...(cartridge.staticDirs ?? [])],
  async viteFinal(config) {
    const aliases = config.resolve?.alias ?? [];
    config.resolve = {
      ...config.resolve,
      alias: [
        ...(Array.isArray(aliases)
          ? aliases
          : Object.entries(aliases).map(([find, replacement]) => ({
              find,
              replacement,
            }))),
        ...Object.entries({
          '@': path.join(app, 'src'),
          ...cartridge.aliases,
        }).map(([find, replacement]) => ({ find, replacement })),
      ],
    };
    config.define = {
      ...config.define,
      'process.env.NEXT_PUBLIC_CHAT_SERVICE_URL':
        JSON.stringify(CHAT_SERVICE_ORIGIN),
    };
    config.css = { ...config.css, postcss: app };
    config.server = {
      ...config.server,
      fs: {
        ...config.server?.fs,
        allow: [...(config.server?.fs?.allow ?? []), repo, virtualStore],
      },
    };
    return config;
  },
};
export default config;
