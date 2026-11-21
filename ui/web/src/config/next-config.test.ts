// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { webpack } from 'next/dist/compiled/webpack/webpack';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import createConfig from '../../next.config';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('keeps an alias into the app relative to the app', async () => {
  vi.stubEnv('BOTCUBE_UI_BUILD_CONFIG', fileURLToPath(new URL('../../tests/in-app-build-config.mjs', import.meta.url)));

  const config = await createConfig('phase-development-server');

  expect(config.turbopack?.resolveAlias?.dcv).toBe('./node_modules/bedrock-agentcore/dcv.js');
});

it('uses isolated production compilers with a custom webpack config', async () => {
  vi.stubEnv('BOTCUBE_UI_BUILD_CONFIG', fileURLToPath(new URL('../../tests/in-app-build-config.mjs', import.meta.url)));

  const config = await createConfig('phase-production-build');

  expect(config.webpack).toBeTypeOf('function');
  expect(config.experimental?.webpackBuildWorker).toBe(true);
  expect(config.experimental?.webpackMemoryOptimizations).toBe(true);
});

/** Next's own webpack, the one `next build` hands the config, typed as Next types it. */
const { webpack: nextWebpack } = createRequire(import.meta.url)('next/dist/compiled/webpack/webpack') as {
  webpack: (options: webpack.Configuration) => webpack.Compiler;
};

/** The errors of a browser bundle of `source`, built with the app's webpack config as `next build` builds the client. */
async function browserBundleErrors(source: string): Promise<string[]> {
  vi.stubEnv('BOTCUBE_UI_BUILD_CONFIG', fileURLToPath(new URL('../../tests/in-app-build-config.mjs', import.meta.url)));
  const config = await createConfig('phase-production-build');
  const dir = mkdtempSync(path.join(tmpdir(), 'browser-bundle-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'entry.js'), source);
  const app = fileURLToPath(new URL('../..', import.meta.url));
  const base = {
    mode: 'development', target: 'web', devtool: false, context: dir, entry: path.join(dir, 'entry.js'),
    output: { path: path.join(dir, 'out') }, resolve: { modules: [path.join(app, 'node_modules'), 'node_modules'] },
  } as const;
  const compiler = nextWebpack(config.webpack({ ...base, resolve: { ...base.resolve } }, { isServer: false, webpack: nextWebpack }));
  return new Promise((resolve, reject) => compiler.run((error: Error | null, stats?: webpack.Stats) => {
    if (error) reject(error);
    else resolve((stats?.toJson({ all: false, errors: true }).errors ?? []).map((error: { message: string }) => error.message));
  }));
}

// PptxGenJS's builds import node:fs and node:https, which webpack refuses in the browser bundle (UnhandledSchemeError).
it('bundles PptxGenJS, which the Slides PowerPoint Export loads, for the browser', async () => {
  expect(await browserBundleErrors("export const load = () => import('pptxgenjs');")).toEqual([]);
});

const webpackAliases = (config: Awaited<ReturnType<typeof createConfig>>) =>
  config.webpack({ resolve: {} }, { isServer: false, webpack: nextWebpack }).resolve?.alias;

it("builds the page with the example bot's settings when its build config names none", async () => {
  vi.stubEnv('BOTCUBE_UI_BUILD_CONFIG', fileURLToPath(new URL('../../tests/in-app-build-config.mjs', import.meta.url)));

  const config = await createConfig('phase-production-build');

  const generated = webpackAliases(config)['@bot-settings'];
  expect(JSON.parse(readFileSync(generated, 'utf8'))).toMatchObject({ agentIdentity: { name: 'BotCube' }, accountKey: 'template' });
  expect(config.turbopack?.resolveAlias?.['@bot-settings']).toBe(path.relative(fileURLToPath(new URL('../..', import.meta.url)), generated));
});

it('builds the page with the bot settings its build config names', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bot-build-config-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const settings = path.join(dir, 'bot.yaml');
  writeFileSync(settings, 'agentIdentity: { name: Quill, character: A drafting agent }\naccountKey: quill\nmodels: [{ key: echo, label: Echo, provider: echo }]\n');
  writeFileSync(path.join(dir, 'build-config.cjs'), `module.exports = () => ({ botSettings: ${JSON.stringify(settings)} });`);
  vi.stubEnv('BOTCUBE_UI_BUILD_CONFIG', path.join(dir, 'build-config.cjs'));

  const generated = webpackAliases(await createConfig('phase-production-build'))['@bot-settings'];
  expect(JSON.parse(readFileSync(generated, 'utf8'))).toMatchObject({ agentIdentity: { name: 'Quill' }, accountKey: 'quill' });
});
