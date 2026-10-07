import type { NextConfig } from 'next';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRepositoryRoot } from './src/config/repository-root.js';

type CartridgeBuildConfig = {
  cartridgeUiEntry?: string;
  transpilePackages?: string[];
  turbopackAliases?: Record<string, string>;
  webpackAliases?: Record<string, string>;
};

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepositoryRoot(
  appRoot,
  process.env.BOTCUBE_REPOSITORY_ROOT,
);
const cartridgeUiPackage = process.env.CARTRIDGE_UI_PACKAGE
  ?? 'botcube-ui-web/cartridge-default';

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
// Turbopack aliases take app-relative paths; build-config paths may be absolute.
const turbopackTarget = (target: string) =>
  path.isAbsolute(target) ? path.relative(appRoot, target) : target;

export default async function createConfig(): Promise<NextConfig> {
  const cartridgeBuildConfig = process.env.CARTRIDGE_UI_BUILD_CONFIG
    ? await import(path.resolve(repoRoot, process.env.CARTRIDGE_UI_BUILD_CONFIG))
      .then((module) => (module.default ?? module)({ appRoot, repoRoot }) as CartridgeBuildConfig)
    : {};

  const cartridgeUi = cartridgeBuildConfig.cartridgeUiEntry ?? cartridgeUiPackage;

  const config: NextConfig = {
    output: 'export',
    distDir: process.env.CARTRIDGE_UI_PACKAGE ? '.next-cartridge' : '.next-standalone',
    devIndicators: {
      position: 'top-right',
    },
    transpilePackages: cartridgeBuildConfig.transpilePackages ?? [],
    // Empty turbopack config marks turbopack (the dev bundler) as intentional —
    // Next 16.3 hard-errors on a `webpack` config with no `turbopack` config.
    // The webpack config below is used only by `next build --webpack`.
    turbopack: {
      root: turbopackRoot,
      resolveAlias: {
        'botcube-ui-web/cartridge': './src/cartridge/index.ts',
        'botcube-ui-web/cartridge-default': './src/cartridge/default.tsx',
        'botcube-ui-web/load-state': './src/app/load-state.tsx',
        ...Object.fromEntries(
          Object.entries(cartridgeBuildConfig.turbopackAliases ?? {})
            .map(([name, target]) => [name, turbopackTarget(target)]),
        ),
        '@cartridge-ui': turbopackTarget(cartridgeUi),
      },
    },
    // Don't let Next auto-generate AGENTS.md/CLAUDE.md — the repo manages its own.
    agentRules: false,
    experimental: {
      // Next 16.3+ turns on turbopack's dev filesystem cache AND in-memory cache
      // eviction (`turbopackMemoryEviction: 'full'`) by default — that's the real
      // dev-memory lever: it evicts inactive-route cache and bounds long-session
      // growth (the original 7GB-over-32h problem). No flag needed for it.
      // Extra tweaks: don't preload every page's JS modules into memory at start;
      // webpackMemoryOptimizations applies to the `next build --webpack` path.
      preloadEntriesOnStart: false,
      webpackMemoryOptimizations: true,
    },
    webpack: (webpackConfig) => {
      webpackConfig.resolve ??= {};
      webpackConfig.resolve.alias = {
        ...(webpackConfig.resolve.alias ?? {}),
        'botcube-ui-web/cartridge': path.join(appRoot, 'src/cartridge/index.ts'),
        'botcube-ui-web/cartridge-default': path.join(appRoot, 'src/cartridge/default.tsx'),
        'botcube-ui-web/load-state': path.join(appRoot, 'src/app/load-state.tsx'),
        ...(cartridgeBuildConfig.webpackAliases ?? {}),
        '@cartridge-ui': cartridgeUi,
      };
      webpackConfig.resolve.extensionAlias = {
        ...(webpackConfig.resolve.extensionAlias ?? {}),
        '.js': ['.ts', '.tsx', '.js', '.jsx'],
      };
      return webpackConfig;
    },
  };

  return config;
}
