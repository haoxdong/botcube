import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialSource } from './credential-source.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const OPTED_IN = { BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1' };
const START = Date.parse('2026-11-19T12:00:00Z');
const minutes = (count: number) => count * 60_000;

/** A token helper: a Node script run as `node <script>`, in its own directory, where it may keep a counter. */
function helper(script: string): [string, ...string[]] {
  const dir = mkdtempSync(join(tmpdir(), 'credential-command-'));
  dirs.push(dir);
  const path = join(dir, 'helper.mjs');
  writeFileSync(path, script);
  return [process.execPath, path];
}

const execCredential = (status: object) =>
  JSON.stringify({ kind: 'ExecCredential', status });
const printing = (status: object) => helper(`process.stdout.write(${JSON.stringify(execCredential(status))});`);
const commandSource = (command: [string, ...string[]], timeoutSeconds = 30) => ({ kind: 'command' as const, command, timeoutSeconds });

describe('a command credential source', () => {
  it("gives the token and expiry of the ExecCredential the command prints", async () => {
    const command = printing({ token: 'gw-token', expirationTimestamp: '2026-11-19T13:00:00Z' });
    const source = credentialSource('models', commandSource(command), { env: OPTED_IN, now: () => START });

    expect(await source.get()).toEqual({ value: 'gw-token', expiresAt: new Date('2026-11-19T13:00:00Z') });
  });

  it('keeps a token printed without an expiry', async () => {
    const source = credentialSource('models', commandSource(printing({ token: 'gw-token' })), { env: OPTED_IN });
    expect(await source.get()).toEqual({ value: 'gw-token', expiresAt: undefined });
  });

  it('runs the command again a minute before its token expires', async () => {
    const command = helper(`
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      const counter = new URL('./runs', import.meta.url);
      const runs = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
      writeFileSync(counter, String(runs));
      process.stdout.write(${JSON.stringify(execCredential({ expirationTimestamp: '2026-11-19T12:10:00Z' }))}.replace('"status":{', '"status":{"token":"gw-token-' + runs + '",'));
    `);
    let now = START;
    const source = credentialSource('models', commandSource(command), { env: OPTED_IN, now: () => now });

    expect((await source.get()).value).toBe('gw-token-1');
    now = START + minutes(8);
    expect((await source.get()).value).toBe('gw-token-1');
    now = START + minutes(9) + 1;
    expect((await source.get()).value).toBe('gw-token-2');
  });

  it('fails naming its seam and its program when the command fails, without its output', async () => {
    const command = helper(`process.stdout.write('sk-leaked'); process.stderr.write('sk-leaked'); process.exit(3);`);
    const failure = credentialSource('models', commandSource(command), { env: OPTED_IN }).get();

    await expect(failure).rejects.toThrow(`models credential (command ${process.execPath}): the command exited with code 3`);
    await expect(failure).rejects.not.toThrow('sk-leaked');
  });

  it('is refused unless the deploy sets BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1', () => {
    const command = printing({ token: 'gw-token' });
    for (const env of [{}, { BOTCUBE_ALLOW_COMMAND_CREDENTIALS: 'true' }]) {
      expect(() => credentialSource('models', commandSource(command), { env }))
        .toThrow(`models credential (command ${process.execPath}): a command credential runs only when BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1`);
    }
  });

  it('stops a command that runs past its timeout', async () => {
    const command = helper('setTimeout(() => {}, 60_000);');
    await expect(credentialSource('models', commandSource(command, 1), { env: OPTED_IN }).get())
      .rejects.toThrow(`models credential (command ${process.execPath}): the command did not finish within 1 s`);
  });

  it.each([
    ['output that is not JSON', 'sk-raw-token'],
    ['another kind of object', JSON.stringify({ kind: 'Secret', status: { token: 'sk-raw-token' } })],
    ['an ExecCredential without a token', execCredential({ expirationTimestamp: '2026-11-19T13:00:00Z' })],
    ['an expiry that is not a timestamp', execCredential({ token: 'sk-raw-token', expirationTimestamp: 'soon' })],
  ])('rejects %s, without echoing it', async (_, output) => {
    const failure = credentialSource('models', commandSource(helper(`process.stdout.write(${JSON.stringify(output)});`)), { env: OPTED_IN }).get();

    await expect(failure).rejects.toThrow(`models credential (command ${process.execPath}): the command did not print a Kubernetes ExecCredential with status.token`);
    await expect(failure).rejects.not.toThrow('sk-raw-token');
  });

  it("never passes the command's stderr on to the service's own", async () => {
    const command = helper(`process.stderr.write('sk-on-stderr\\n'); process.stdout.write(${JSON.stringify(execCredential({ token: 'gw-token' }))});`);
    const module = fileURLToPath(new URL('./credential-source.ts', import.meta.url));
    // Node runs the TypeScript source as it is, so a `.js` import of a sibling resolves to its `.ts`.
    const service = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        try { return next(specifier, context); } catch (error) {
          if (!/^\\.\\.?\\/.*\\.js$/.test(specifier)) throw error;
          return next(specifier.replace(/\\.js$/, '.ts'), context);
        }
      } });
      const { credentialSource } = await import(${JSON.stringify(module)});
      const { value } = await credentialSource('models', ${JSON.stringify(commandSource(command))}).get();
      console.log(value === 'gw-token' ? 'got the token' : 'wrong token');
    `;

    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', service], { env: { ...process.env, ...OPTED_IN } });

    expect(stdout).toBe('got the token\n');
    expect(stderr).not.toContain('sk-on-stderr');
  });
});
