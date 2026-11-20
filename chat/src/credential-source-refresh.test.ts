import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialSource } from './credential-source.js';

const START = Date.parse('2026-11-20T12:00:00Z');
const minutes = (count: number) => count * 60_000;
const OPTED_IN = { BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1' };
const EXPIRES = new Date(START + minutes(5)).toISOString();

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

function tokenHelper() {
  const dir = mkdtempSync(join(tmpdir(), 'credential-refresh-'));
  dirs.push(dir);
  const script = join(dir, 'helper.mjs');
  writeFileSync(script, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    const at = (name) => new URL('./' + name, import.meta.url);
    const run = (existsSync(at('runs')) ? Number(readFileSync(at('runs'), 'utf8')) : 0) + 1;
    writeFileSync(at('runs'), String(run));
    const release = at('release-' + run);
    while (run > 1 && !existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 10));
    const outcome = run > 1 ? readFileSync(release, 'utf8') : ${JSON.stringify(EXPIRES)};
    if (outcome === 'fail') process.exit(1);
    process.stdout.write(JSON.stringify({ kind: 'ExecCredential', status: { token: 'token-' + run, expirationTimestamp: outcome } }));
  `);
  return {
    command: [process.execPath, script] as [string, ...string[]],
    runs: () => (existsSync(join(dir, 'runs')) ? Number(readFileSync(join(dir, 'runs'), 'utf8')) : 0),
    release: (run: number, outcome: string) => { writeFileSync(join(dir, `release-${run}`), outcome); },
  };
}

async function refreshingSource() {
  const clock = { now: START };
  const helper = tokenHelper();
  const source = credentialSource('models', { kind: 'command', command: helper.command, timeoutSeconds: 30 }, { env: OPTED_IN, now: () => clock.now });
  expect((await source.get()).value).toBe('token-1');
  return { clock, helper, source };
}

const settled = async <T>(promise: Promise<T>) => {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  return done;
};

describe('a credential source refreshing ahead of expiry', () => {
  it('serves its credential before half the lifetime without minting again', async () => {
    const { clock, helper, source } = await refreshingSource();
    clock.now = START + minutes(2);

    expect((await source.get()).value).toBe('token-1');
    expect(helper.runs()).toBe(1);
  });

  it('answers N concurrent reads in the advisory window at once, with one refresh between them', async () => {
    const { clock, helper, source } = await refreshingSource();
    clock.now = START + minutes(3);

    const answers = await Promise.all(Array.from({ length: 5 }, () => source.get()));

    expect(answers.map(({ value }) => value)).toEqual(Array.from({ length: 5 }, () => 'token-1'));
    await vi.waitFor(() => { expect(helper.runs()).toBe(2); });
    helper.release(2, new Date(START + minutes(8)).toISOString());
    await vi.waitFor(async () => { expect((await source.get()).value).toBe('token-2'); });
    expect(helper.runs()).toBe(2);
  });

  it('makes a read in the mandatory window wait for the refresh', async () => {
    const { clock, helper, source } = await refreshingSource();
    clock.now = START + minutes(4) + 1;

    const waiting = source.get();
    await vi.waitFor(() => { expect(helper.runs()).toBe(2); });

    expect(await settled(waiting)).toBe(false);
    helper.release(2, new Date(START + minutes(9)).toISOString());
    expect((await waiting).value).toBe('token-2');
  });

  it('keeps serving its credential when an advisory refresh fails, logging the failure once', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { clock, helper, source } = await refreshingSource();
    helper.release(2, 'fail');
    helper.release(3, new Date(START + minutes(8)).toISOString());
    clock.now = START + minutes(3);

    expect((await Promise.all([source.get(), source.get(), source.get()])).map(({ value }) => value)).toEqual(['token-1', 'token-1', 'token-1']);
    await vi.waitFor(() => { expect(warned).toHaveBeenCalled(); });
    await vi.waitFor(async () => { expect((await source.get()).value).toBe('token-3'); });

    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned).toHaveBeenCalledWith(`Credential refresh failed: models credential (command ${process.execPath}): the command exited with code 1`);
  });

  it('fails a read in the mandatory window when its refresh fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { clock, helper, source } = await refreshingSource();
    helper.release(2, 'fail');
    clock.now = START + minutes(4) + 1;

    await expect(source.get()).rejects.toThrow(`models credential (command ${process.execPath}): the command exited with code 1`);
  });

  it('opens the advisory window no earlier than fifteen minutes before a long-lived credential expires', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'credential-refresh-')), 'token');
    dirs.push(join(path, '..'));
    writeFileSync(path, 'token-1');
    const clock = { now: START };
    const source = credentialSource('models', { kind: 'command', command: [process.execPath, '-e', `
      const token = require('node:fs').readFileSync(${JSON.stringify(path)}, 'utf8');
      process.stdout.write(JSON.stringify({ kind: 'ExecCredential', status: { token, expirationTimestamp: ${JSON.stringify(new Date(START + minutes(60)).toISOString())} } }));
    `], timeoutSeconds: 30 }, { env: OPTED_IN, now: () => clock.now });
    await source.get();
    writeFileSync(path, 'token-2');

    clock.now = START + minutes(44);
    expect((await source.get()).value).toBe('token-1');
    await new Promise<void>((resolve) => { setTimeout(resolve, 300); });
    expect((await source.get()).value).toBe('token-1');
    clock.now = START + minutes(46);
    await vi.waitFor(async () => { expect((await source.get()).value).toBe('token-2'); });
  });

  it('sets no timer, so an idle service mints nothing', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'credential-refresh-')), 'key');
    dirs.push(join(path, '..'));
    writeFileSync(path, 'key-1');
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const clock = { now: START };
      const source = credentialSource('models', { kind: 'file', path }, { now: () => clock.now });
      await source.get();
      writeFileSync(path, 'key-2');
      clock.now = START + minutes(3);
      const refreshed = async (): Promise<string> => {
        const { value } = await source.get();
        if (value === 'key-2') return value;
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        return refreshed();
      };
      await refreshed();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
