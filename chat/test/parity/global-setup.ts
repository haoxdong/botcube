import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { TestProject } from 'vitest/node';
import setupMoto from '../fakes/global-setup.js';

declare module 'vitest' {
  export interface ProvidedContext {
    parityServiceCommand: string;
    fakeSiteServiceCommand: string;
  }
}

export default async function setup(project: TestProject) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-parity-service-'));
  const bundle = async (source: string) => {
    const entry = join(directory, source.replace(/^.*\//, '').replace(/\.ts$/, '.js'));
    await build({
      entryPoints: [fileURLToPath(new URL(source, import.meta.url))],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      banner: { js: "import{createRequire as __parityCreateRequire}from'node:module';const require=__parityCreateRequire(import.meta.url);" },
    });
    return `node ${entry}`;
  };
  const [parity, fakeSite] = await Promise.all([bundle('../../src/main.ts'), bundle('./fake-site-service.ts')]);
  project.provide('parityServiceCommand', parity);
  project.provide('fakeSiteServiceCommand', fakeSite);
  const stop = await setupMoto(project);
  return async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  };
}
