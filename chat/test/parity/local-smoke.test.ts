import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, it } from 'vitest';
import { readConfig } from '../../../config/read.cjs';
import { required } from '../required.js';
import { startLocalStack, type LocalStack } from './local-stack.js';
import { startOnFreePort, type RunningProcess } from '../fakes/process.js';

const execute = promisify(execFile);
const cube = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/** The public example's BotCube Config, its web origins this test's UI port. */
async function webOriginsConfig(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'local-smoke-deployment-')), 'botcube.yaml');
  const config = readConfig(cube('examples/public/botcube.yaml'));
  await writeFile(path, JSON.stringify({ ...config, domains: { web: 'http://localhost:4001', webAliases: ['http://127.0.0.1:4001'], chatService: 'http://localhost:8123' } }));
  return path;
}
let stack: LocalStack | undefined;
let ui: RunningProcess | undefined;
let home: string | undefined;
let app: string | undefined;
const restartRequests: string[][] = [];
let failRestart = false;
const control = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  restartRequests.push(JSON.parse(body));
  if (failRestart) {
    response.writeHead(503).end('Harness restart failed');
    return;
  }
  try {
    await required(stack, 'Local stack').restartHarness();
    response.end('Harness restarted');
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
afterAll(async () => {
  await stack?.stop();
  await ui?.stop();
  if (control.listening) await new Promise<void>((done) => control.close(() => done()));
  await Promise.all([home, app].filter((dir) => dir !== undefined).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('runs the documented smoke entrypoint with a retained account through a real Harness restart and fails loudly on restart failure', { timeout: 180_000 }, async () => {
  home = await mkdtemp(join(tmpdir(), 'local-smoke-'));
  await mkdir(cube('.tmp'), { recursive: true });
  app = await mkdtemp(cube('.tmp/local-smoke-ui-'));
  await cp(cube('ui/web'), app, { recursive: true, filter: (source) => !['node_modules', '.next', '.next-bot', '.next-standalone'].includes(basename(source)) });
  await symlink(cube('ui/web/node_modules'), join(app, 'node_modules'), 'dir');
  await rename(join(app, 'next.config.ts'), join(app, 'next.smoke-base.ts'));
  await writeFile(join(app, 'next.config.ts'), `import configure from './next.smoke-base.ts';
export default async function smokeConfig(phase: string) {
  const config = await configure(phase);
  return { ...config, experimental: { ...config.experimental, turbopackLazyDynamicImports: true, turbopackLazyDynamicImportsSSR: true } };
}
`);
  const dcvSdk = '/nice-dcv-web-client-sdk/dcvjs-esm/dcv.js';
  // Unset, the app builds with its default UI plugin.
  const { BOTCUBE_UI_PACKAGE: _package, BOTCUBE_UI_BUILD_CONFIG: _buildConfig, ...uiEnv } = process.env;
  const starts = await Promise.allSettled([
    webOriginsConfig().then((botcubeConfig) => startLocalStack({ botcubeConfig })).then((started) => (stack = started)),
    startOnFreePort((port) => ({
      command: `cd ${app} && node ${cube('ui/web/node_modules/next/dist/bin/next')} dev --port ${port}`,
      env: { ...uiEnv, NODE_OPTIONS: '', BOTCUBE_REPOSITORY_ROOT: cube('.') },
      url: `http://127.0.0.1:${port}${dcvSdk}`,
      listening: `localhost:${port}`,
      readyTimeoutMs: 120_000,
    })).then((started) => (ui = started)),
  ]);
  for (const start of starts) if (start.status === 'rejected') throw start.reason;
  stack = required(stack, 'Local stack');
  ui = required(ui, 'UI');
  await new Promise<void>((done) => control.listen(0, '127.0.0.1', done));
  const address = control.address();
  if (!address || typeof address === 'string') throw new Error('Missing restart control port');
  await writeFile(join(home, 'curl'), `#!/usr/bin/env bash
chat=http://localhost:8123 ui=http://localhost:3001
args=("\${@/"$chat"/$SMOKE_CHAT_URL}")
exec /usr/bin/curl "\${args[@]/"$ui"/$SMOKE_UI_URL}"
`, { mode: 0o755 });
  await writeFile(join(home, 'docker'), `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args.at(-1)!=='harness'){console.error('Unsupported restart actor');process.exit(1);}
fetch(process.env.SMOKE_RESTART_URL,{method:'POST',body:JSON.stringify(args)}).then(async response=>{console.log(await response.text());process.exit(response.ok?0:1);}).catch(error=>{console.error(error);process.exit(1);});
`, { mode: 0o755 });
  const env = { ...process.env, BOTCUBE_LOCAL_UI_PORT: '4001', BOTCUBE_LOCAL_UI_URL: 'http://localhost:3001', PATH: `${home}:${process.env.PATH ?? ''}`, SMOKE_CHAT_URL: stack.url, SMOKE_UI_URL: new URL(ui.url).origin, SMOKE_RESTART_URL: `http://127.0.0.1:${address.port}/` };
  const script = cube('infra/local/smoke.sh');
  const [result, page] = await Promise.all([
    execute('bash', [script], { env }).catch((error: { message: string; stdout?: string; stderr?: string }) => {
      throw new Error(`${error.message}\nstdout:\n${error.stdout ?? ''}\nstderr:\n${error.stderr ?? ''}`, { cause: error });
    }),
    fetch(new URL('/', ui.url)).then((response) => response.text()),
  ]);
  expect(result.stdout).toContain('Local Session smoke passed');
  expect(page).toContain('<title>BotCube</title>');
  expect((await fetch(new URL(dcvSdk, ui.url))).status).toBe(200);
  expect(restartRequests).toEqual([['compose', '-f', cube('infra/local/compose.yml'), 'restart', 'harness']]);
  const visitor = stack.browser();
  expect((await visitor.get('/account/session')).status).toBe(200);
  expect((await (await visitor.get('/threads')).json()).threads).toEqual([]);
  await expect(execute(join(home, 'docker'), ['compose', 'restart', 'chat-service'], { env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Unsupported restart actor') });
  await expect(execute('bash', [script], { env: { ...env, BOTCUBE_LOCAL_UI_PORT: '4002' } })).rejects.toMatchObject({ code: 22, stderr: expect.stringContaining('400') });
  expect(restartRequests).toHaveLength(1);
  failRestart = true;
  await expect(execute('bash', [script], { env })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('Harness restart failed') });
});
