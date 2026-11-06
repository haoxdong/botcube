import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export function setup(): () => void {
  for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE']) delete process.env[key];
  process.env.UV_CACHE_DIR ??= join(homedir(), '.cache', 'uv');
  const home = mkdtempSync(join(tmpdir(), 'botcube-test-home-'));
  writeFileSync(join(home, '.gitconfig'), '[maintenance]\n\tauto = false\n');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => rmSync(home, { recursive: true, force: true });
}
