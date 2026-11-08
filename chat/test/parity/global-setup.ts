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
  }
}

export default async function setup(project: TestProject) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-parity-service-'));
  const entry = join(directory, 'main.js');
  await build({
    entryPoints: [fileURLToPath(new URL('./service.ts', import.meta.url))],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: "import{createRequire as __parityCreateRequire}from'node:module';const require=__parityCreateRequire(import.meta.url);" },
  });
  project.provide('parityServiceCommand', `node ${entry}`);
  const stop = await setupMoto(project);
  return async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  };
}
