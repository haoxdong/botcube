import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialSource } from './credential-source.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function keyFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'credential-file-'));
  dirs.push(dir);
  const path = join(dir, 'models-api-key');
  writeFileSync(path, contents);
  return path;
}

describe('a file credential source', () => {
  it('reads the current file on each get and removes its trailing newline', async () => {
    const path = keyFile('sk-mounted\n');
    const source = credentialSource('models', { kind: 'file', path });

    expect((await source.get()).value).toBe('sk-mounted');
    writeFileSync(path, 'sk-rotated\n');
    expect(await source.get()).toEqual({ value: 'sk-rotated', expiresAt: undefined });
  });

  it('fails naming its seam and its file when the file is missing', async () => {
    const path = join(tmpdir(), 'absent-credential-file');
    await expect(credentialSource('models', { kind: 'file', path }).get()).rejects.toThrow(`models credential (file ${path}): ENOENT`);
  });

  it('fails naming its seam and its file when the file is empty', async () => {
    const path = keyFile('\n');
    await expect(credentialSource('models', { kind: 'file', path }).get()).rejects.toThrow(`models credential (file ${path}): the file is empty`);
  });
});
