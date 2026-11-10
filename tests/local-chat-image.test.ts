import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const botcube = resolve(fileURLToPath(new URL('..', import.meta.url)));

const esbuild = createRequire(join(botcube, 'templates/always-on/chat/package.json')).resolve('esbuild/bin/esbuild');

it('builds a local Chat Service image bundle that Node can load', () => {
  const dockerfile = readFileSync(join(botcube, 'infra/local/chat.Dockerfile'), 'utf8');
  const command = /^RUN npx esbuild ([\s\S]*?--outfile=dist\/main\.js)$/m.exec(dockerfile)?.[1];
  expect(command, 'the image bundles the Chat Service with esbuild').toBeDefined();
  const directory = mkdtempSync(join(tmpdir(), 'local-chat-image-'));
  try {
    const bundle = join(directory, 'main.mjs');
    const script = `"$ESBUILD" ${command?.replaceAll('\\\n', ' ').replace('--outfile=dist/main.js', '--outfile="$BUNDLE"')} --log-level=warning`;
    execFileSync('sh', ['-c', script], { cwd: botcube, env: { ...process.env, ESBUILD: esbuild, BUNDLE: bundle }, stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', bundle], { stdio: 'pipe' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
