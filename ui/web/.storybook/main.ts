import { resolveRepositoryRoot } from '../src/config/repository-root.js';
import type { StorybookConfig } from '@storybook/nextjs-vite';
import { CHAT_SERVICE_ORIGIN } from './chat-origin';
import path from 'node:path';
import { createRequire } from 'node:module';
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

const visual = process.env.STORYBOOK_VISUAL_COMPARE === '1';

const config: StorybookConfig = {
  framework: visual ? path.dirname(fileURLToPath(import.meta.resolve('@storybook/nextjs-vite/package.json'))) : '@storybook/nextjs-vite',
  stories: visual
    ? (process.env.STORYBOOK_VISUAL_FILES?.split(',') ?? Object.keys(JSON.parse(readFileSync(path.join(repo, 'botcube/ui/web/visual/internal/coverage.json'), 'utf8')))).map(file => path.relative(path.join(app, '.storybook'), path.join(repo, file)))
    : cartridge.stories,
  previewAnnotations: cartridge.previewAnnotations,
  addons: ['@storybook/addon-a11y', '@storybook/addon-vitest'].map(name => visual ? path.dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`))) : name),
  staticDirs: ['public', ...(cartridge.staticDirs ?? [])],
  // The app's viewport (src/app/layout.tsx): viewport-fit=cover, so an iPhone draws the phone chat under its status bar.
  previewHead: (head) =>
    `${head}<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`,
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
      'process.env.STORYBOOK_VISUAL_COMPARE': JSON.stringify(process.env.STORYBOOK_VISUAL_COMPARE ?? ''),
      'process.env.NEXT_PUBLIC_ARTIFACTS': JSON.stringify('1'),
      'process.env.NEXT_PUBLIC_REMOTE_VIEWPORT_CLAMP': JSON.stringify(process.env.NEXT_PUBLIC_REMOTE_VIEWPORT_CLAMP ?? '1'),
      'process.env.NEXT_PUBLIC_CHAT_SERVICE_URL':
        JSON.stringify(CHAT_SERVICE_ORIGIN),
    };
    if (visual) {
      config.plugins ??= [];
      config.plugins.push({
        name: 'visual-sandbox-index',
        configureServer(server) {
          server.middlewares.use((request, _response, next) => {
            if (request.url === '/artifact-sandbox/') request.url = '/artifact-sandbox/index.html';
            next();
          });
        },
      });
    }
    config.css = { ...config.css, postcss: app };
    config.server = {
      ...config.server,
      fs: {
        ...config.server?.fs,
        allow: [...(config.server?.fs?.allow ?? []), repo, virtualStore],
      },
    };
    // Optimized in one pass so both entries share CopilotKit's context; found separately, the cartridge's headless
    // import got its own copy and threw "useCopilotKit must be used within CopilotKitProvider".
    config.optimizeDeps = {
      ...config.optimizeDeps,
      include: [...(config.optimizeDeps?.include ?? []), 'motion/react', '@copilotkit/react-core/v2', '@copilotkit/react-core/v2/headless', ...(visual ? ['@storybook/nextjs-vite > @storybook/react-vite > @storybook/react > @storybook/react-dom-shim', '@base-ui/react/radio', '@base-ui/react/radio-group', createRequire(cartridge.aliases['@cartridge-ui']).resolve('@radix-ui/react-focus-scope'), '@base-ui/react/popover', 'next/dynamic', 'rxjs', '@use-gesture/react', '@base-ui/react/context-menu', '@base-ui/react/menu', '@base-ui/react/use-render', '@univerjs/presets', '@univerjs/preset-sheets-core', '@univerjs/preset-sheets-core/locales/en-US', 'marked', 'cronstrue', '@streamdown/cjk', '@streamdown/code', '@streamdown/math', 'remark-breaks', 'streamdown', 'pdfjs-dist', '@streamdown/mermaid', '@base-ui/react/dialog'] : [])],
    };
    return config;
  },
};
export default config;
