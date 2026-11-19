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

const START = Date.parse('2026-11-19T12:00:00Z');
const minutes = (count: number) => count * 60_000;

describe('a file credential source', () => {
  it("gives the mounted file's contents, without its trailing newline, until five minutes on", async () => {
    const path = keyFile('sk-mounted\n');
    const source = credentialSource('models', { kind: 'file', path }, { now: () => START });

    expect(await source.get()).toEqual({ value: 'sk-mounted', expiresAt: new Date(START + minutes(5)) });
  });

  it('reads the file again a minute before its value expires, picking up a rotated key', async () => {
    const path = keyFile('sk-first');
    let now = START;
    const source = credentialSource('models', { kind: 'file', path }, { now: () => now });
    await source.get();
    writeFileSync(path, 'sk-rotated');

    now = START + minutes(3);
    expect((await source.get()).value).toBe('sk-first');
    now = START + minutes(4) + 1;
    expect(await source.get()).toEqual({ value: 'sk-rotated', expiresAt: new Date(now + minutes(5)) });
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
