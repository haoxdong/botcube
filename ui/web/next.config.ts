import botSettingsModule from './src/config/bot-settings.cjs';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRepositoryRoot } from './src/config/repository-root.js';

type UiBuildConfig = {
  botUiEntry?: string;
  transpilePackages?: string[];
  turbopackAliases?: Record<string, string>;
  webpackAliases?: Record<string, string>;
  /** The bot settings file the page is built with; the example bot's without one. */
  botSettings?: string;
};

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepositoryRoot(
  appRoot,
  process.env.BOTCUBE_REPOSITORY_ROOT,
);
const botUiPackage = process.env.BOTCUBE_UI_PACKAGE
  ?? 'botcube-ui-web/plugin-default';

// Turbopack only resolves files under its root; pnpm's global virtual store
// keeps packages outside the repository, so widen the root to cover both.
function commonAncestor(a: string, b: string): string {
  const relative = path.relative(a, b);
  return relative.startsWith('..') ? commonAncestor(path.dirname(a), b) : a;
}
const nextPackageRoot = realpathSync(
  path.dirname(createRequire(import.meta.url).resolve('next/package.json')),
);
const turbopackRoot = commonAncestor(repoRoot, nextPackageRoot);
// Turbopack aliases take app-relative paths; build-config paths may be absolute. A path into the app needs its `./`,
// or Turbopack reads `node_modules/…` as a package named node_modules.
function turbopackTarget(target: string): string {
  if (!path.isAbsolute(target)) return target;
  const relative = path.relative(appRoot, target);
  return relative.startsWith('..') ? relative : `./${relative}`;
}

type NextWebpack = NonNullable<NextConfig['webpack']>;
/** The app's webpack hook, which reads only these two of the context Next hands it. */
type AppWebpack = (
  webpackConfig: Parameters<NextWebpack>[0],
  context: Pick<Parameters<NextWebpack>[1], 'isServer' | 'webpack'>,
) => ReturnType<NextWebpack>;
type AppConfig = Omit<NextConfig, 'webpack'> & { webpack: AppWebpack };

export default async function createConfig(phase: string): Promise<AppConfig> {
  const uiBuildConfig: UiBuildConfig = process.env.BOTCUBE_UI_BUILD_CONFIG
    ? await import(path.resolve(repoRoot, process.env.BOTCUBE_UI_BUILD_CONFIG))
      .then((module) => (module.default ?? module)({ appRoot, repoRoot }) as UiBuildConfig)
    : await import('./src/config/dcv-assets.mjs').then(({ dcvAliases, materializeDcvAssets }) => {
      materializeDcvAssets(appRoot);
      return { turbopackAliases: dcvAliases, webpackAliases: dcvAliases };
    });

  const botUi = uiBuildConfig.botUiEntry ?? botUiPackage;
  const botSettings = botSettingsModule(uiBuildConfig.botSettings ?? path.join(appRoot, '../../examples/bot/bot.yaml'));

  const config: AppConfig = {
    output: 'export',
    typescript: { ignoreBuildErrors: process.env.COLLECTIVE_PRIVATE_CI === 'true' },
    distDir: phase === PHASE_DEVELOPMENT_SERVER
      ? '.next'
      : process.env.BOTCUBE_UI_PACKAGE ? '.next-bot' : '.next-standalone',
    devIndicators: false,
    transpilePackages: uiBuildConfig.transpilePackages ?? [],
    // Empty turbopack config marks turbopack (the dev bundler) as intentional —
    // Next 16.3 hard-errors on a `webpack` config with no `turbopack` config.
    // The webpack config below is used only by `next build --webpack`.
    turbopack: {
      root: turbopackRoot,
      resolveAlias: {
        'botcube-ui-web/plugin': './src/plugin/index.ts',
        'botcube-ui-web/plugin-default': './src/plugin/default.tsx',
        'botcube-ui-web/load-state': './src/app/load-state.tsx',
        ...Object.fromEntries(
          Object.entries(uiBuildConfig.turbopackAliases ?? {})
            .map(([name, target]) => [name, turbopackTarget(target)]),
        ),
        '@bot-ui': turbopackTarget(botUi),
        '@bot-settings': turbopackTarget(botSettings),
      },
    },
    // Don't let Next auto-generate AGENTS.md/CLAUDE.md — the repo manages its own.
    agentRules: false,
    experimental: {
      turbopackFileSystemCacheForBuild: process.env.COLLECTIVE_PRIVATE_CI !== 'true',
      // Private CI only checks that the export builds; minifying it cost about 30 CPU-s of each build.
      // Deploys and the nightly cold-open export set no COLLECTIVE_PRIVATE_CI, so they stay minified.
      turbopackMinify: process.env.COLLECTIVE_PRIVATE_CI !== 'true',
      // Next 16.3+ turns on turbopack's dev filesystem cache AND in-memory cache
      // eviction (`turbopackMemoryEviction: 'full'`) by default — that's the real
      // dev-memory lever: it evicts inactive-route cache and bounds long-session
      // growth (the original 7GB-over-32h problem). No flag needed for it.
      // Extra tweaks: don't preload every page's JS modules into memory at start;
      // webpackMemoryOptimizations applies to the `next build --webpack` path.
      preloadEntriesOnStart: false,
      webpackMemoryOptimizations: true,
      webpackBuildWorker: true,
    },
    webpack: (webpackConfig, { isServer, webpack }) => {
      webpackConfig.resolve ??= {};
      webpackConfig.resolve.alias = {
        ...(webpackConfig.resolve.alias ?? {}),
        'botcube-ui-web/plugin': path.join(appRoot, 'src/plugin/index.ts'),
        'botcube-ui-web/plugin-default': path.join(appRoot, 'src/plugin/default.tsx'),
        'botcube-ui-web/load-state': path.join(appRoot, 'src/app/load-state.tsx'),
        ...(uiBuildConfig.webpackAliases ?? {}),
        '@bot-ui': botUi,
        '@bot-settings': botSettings,
      };
      webpackConfig.resolve.extensionAlias = {
        ...(webpackConfig.resolve.extensionAlias ?? {}),
        '.js': ['.ts', '.tsx', '.js', '.jsx'],
      };
      // Every PptxGenJS 4.0.1 build, its browser bundles too, holds `import('node:fs')` and `import('node:https')`,
      // which it runs only in Node. Webpack refuses the `node:` scheme before an alias or the `browser` field can
      // apply, so in the browser bundle, and in PptxGenJS alone, the two lose the scheme; its package.json's `browser`
      // field then maps `fs` and `https` to nothing.
      if (!isServer) {
        webpackConfig.plugins ??= [];
        webpackConfig.plugins.push(new webpack.NormalModuleReplacementPlugin(/^node:(fs|https)$/, (resource: { context: string; request: string }) => {
          if (/[\\/]pptxgenjs[\\/]dist$/.test(resource.context)) resource.request = resource.request.slice('node:'.length);
        }));
      }
      return webpackConfig;
    },
  };

  return config;
}
