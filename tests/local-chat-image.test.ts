import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';

const chat = fileURLToPath(new URL('../chat/', import.meta.url));

it('builds a Chat Service image bundle that Node can load', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chat-image-'));
  try {
    execFileSync('npm', ['--prefix', chat, 'run', 'build', '--', `--outdir=${directory}`, '--out-extension:.js=.mjs'], {
      stdio: 'pipe',
    });
    execFileSync(process.execPath, ['--check', join(directory, 'main.mjs')], { stdio: 'pipe' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
