import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType, type WebSocketServerLike } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { HttpError, type AccountHistory } from './cartridge.js';
import { computerFilesRoutes } from './computer-files-routes.js';
import { localAgentComputer } from './local-agent-computer.js';
import { startLocalChromium, type LocalChromium } from './local-chromium.js';
import { AgentCdp } from '../test/agent-cdp.js';
import { testChromiumPath } from '../test/chromium.js';

const fixture = (name: string) => fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

const startupDiagnostics = vi.hoisted(() => ({
  capture: undefined as { stderr: string } | undefined,
  /** Run this executable instead of the one asked for, which `spawned` records with its arguments. */
  redirect: undefined as string | undefined,
  spawned: [] as unknown[],
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      startupDiagnostics.spawned.push(args.slice(0, 2));
      if (startupDiagnostics.redirect) args[0] = startupDiagnostics.redirect;
      const child = actual.spawn(...args);
      const capture = startupDiagnostics.capture;
      if (capture)
        child.stderr?.on('data', (chunk: Buffer) => {
          capture.stderr = (capture.stderr + chunk.toString()).slice(-65_536);
        });
      return child;
    },
  };
});

/** Hide the macOS installs, so a test sees only the Chromium on its PATH. */
const chromiumApps = vi.hoisted(() => ({ hidden: false }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    accessSync: (...args: Parameters<typeof actual.accessSync>) => {
      if (chromiumApps.hidden && String(args[0]).startsWith('/Applications/')) throw new Error('Hidden by the test');
      actual.accessSync(...args);
    },
  };
});

const cleanupFault = vi.hoisted(() => ({
  enabled: false,
  paths: [] as string[],
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (cleanupFault.enabled && String(args[0]).includes('agent-computer-')) {
        cleanupFault.paths.push(String(args[0]));
        throw new Error('Profile cleanup denied');
      }
      return actual.rm(...args);
    },
  };
});

const OWNER = 'computer-owner';
/** Requests act as the x-owner header's account. */
const requester = async (c: Context) => {
  const owner = c.req.header('x-owner');
  if (!owner) throw new HttpError(401, 'No account');
  return { owner };
};
const as = (owner = OWNER) => ({ headers: { 'x-owner': owner } });
const owning = (history: Partial<Pick<AccountHistory, 'owns' | 'ownsMainChat'>> = {}) => ({
  owns: async () => true,
  ownsMainChat: async () => false,
  ...history,
});

let site: Server | undefined;
let browser: LocalChromium | undefined;
let computer: ReturnType<typeof localAgentComputer> | undefined;
let service: ServerType | undefined;
let executableDirectory: string | undefined;
afterEach(async () => {
  startupDiagnostics.capture = undefined;
  startupDiagnostics.redirect = undefined;
  startupDiagnostics.spawned = [];
  chromiumApps.hidden = false;
  try {
    if (cleanupFault.enabled)
      await expect(computer?.stop()).rejects.toMatchObject({
        status: 503,
        detail: 'Agent Computer profile cleanup failed',
      });
    else await computer?.stop();
  } finally {
    cleanupFault.enabled = false;
    await Promise.all(cleanupFault.paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    await browser?.stop();
    if (service) {
      const closing = service;
      if ('closeAllConnections' in closing) closing.closeAllConnections();
      await new Promise<void>((resolve, reject) => closing.close((error) => (error ? reject(error) : resolve())));
    }
    if (site) await new Promise<void>((resolve, reject) => site?.close((error) => (error ? reject(error) : resolve())));
    site = undefined;
    browser = undefined;
    computer = undefined;
    service = undefined;
    if (executableDirectory) await rm(executableDirectory, { recursive: true, force: true });
    executableDirectory = undefined;
  }
});

function newComputer({
  history = owning(),
  chromiumPath = testChromiumPath(),
  startPage,
}: { history?: Pick<AccountHistory, 'owns' | 'ownsMainChat'>; chromiumPath?: string; startPage?: string } = {}) {
  computer = localAgentComputer({
    history,
    requester,
    env: { BOTCUBE_CHROMIUM_PATH: chromiumPath, BOTCUBE_AGENT_COMPUTER_CDP_URL: 'ws://127.0.0.1/computer' },
    startPage,
  });
  return computer;
}

/** The computer's routes with the Computer tab's, as a Cartridge mounts them. */
function computerApp(local: ReturnType<typeof localAgentComputer>, history: Pick<AccountHistory, 'owns'> = owning()) {
  const app = new Hono()
    .route('/', local.routes)
    .route('/', computerFilesRoutes({ requester, history, computers: local, files: () => { throw new Error('This test has no Files'); } }));
  app.onError((error, c) =>
    error instanceof HttpError ? c.json({ detail: error.detail }, error.status as 503) : c.json({ detail: error.message }, 500)
  );
  return app;
}

/** Serve the app on a free port, WebSocket upgrades included; answers its origin. */
async function served(app: Hono): Promise<string> {
  const started = await new Promise<ServerType>((resolve) => {
    const server: ServerType = serve(
      {
        fetch: app.fetch,
        port: 0,
        hostname: '127.0.0.1',
        overrideGlobalObjects: false,
        websocket: { server: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike },
      },
      () => resolve(server)
    );
  });
  service = started;
  return `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
}

const cdpUrlOf = (origin: string, token: string) =>
  `${origin.replace('http:', 'ws:')}/agent-computer/cdp?${new URLSearchParams({ token })}`;
const tokenOf = (props: { agentComputerCdpUrl: string }) =>
  new URL(props.agentComputerCdpUrl).searchParams.get('token') ?? '';

async function fakeSite(visited: () => void = () => undefined, documentGate: Promise<void> = Promise.resolve()) {
  site = createServer(async (_request, response) => {
    await documentGate;
    visited();
    response.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': 'site_session=fixture-cookie-secret; HttpOnly; Path=/',
    });
    response.end('<h1>Template site</h1>');
  });
  await new Promise<void>((resolve) => site?.listen(0, '127.0.0.1', resolve));
  const address = site.address();
  if (!address || typeof address === 'string') throw new Error('Fake site has no port');
  return `http://127.0.0.1:${address.port}/login`;
}

it("with zero env, runs the Chromium on PATH on a blank page and answers on this Chat Service's CDP endpoint", { timeout: 15_000 }, async () => {
  executableDirectory = await mkdtemp(resolve(tmpdir(), 'agent-browser-path-'));
  const executable = resolve(executableDirectory, 'chromium');
  // A wrapper, not a symlink: macOS Chrome finds its framework only from its own path.
  await writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(testChromiumPath())} "$@"\n`, { mode: 0o755 });
  computer = localAgentComputer({ history: owning(), requester, env: { PATH: executableDirectory } });
  expect((await computer.forwardedProps(OWNER, 'default-session')).agentComputerCdpUrl)
    .toMatch(/^ws:\/\/127\.0\.0\.1:8123\/agent-computer\/cdp\?token=[\w-]+\.[\w-]+$/);
  await computer.warmSession({ owner: OWNER }, 'default-session');
  expect(await computer.state(OWNER, 'default-session')).toMatchObject({ state: 'awake' });
  expect(startupDiagnostics.spawned).toEqual([[executable, expect.arrayContaining(['about:blank'])]]);
});

it('with no Chromium on PATH or in /Applications, fails the start naming the fix', async () => {
  executableDirectory = await mkdtemp(resolve(tmpdir(), 'agent-browser-empty-'));
  chromiumApps.hidden = true;
  computer = localAgentComputer({ history: owning(), requester, env: { PATH: executableDirectory } });
  await expect(computer.warmSession({ owner: OWNER }, 'default-session')).rejects.toMatchObject({
    status: 503,
    detail:
      'Agent Computer failed to start: No Chromium found on PATH (chromium, chromium-browser, google-chrome-stable, google-chrome) ' +
      'or in /Applications: install Chromium or set BOTCUBE_CHROMIUM_PATH',
  });
  expect(startupDiagnostics.spawned).toEqual([]);
  await expect(computer.stop()).rejects.toMatchObject({ status: 503 });
  computer = undefined;
});

it('answers on the CDP endpoint PORT or BOTCUBE_AGENT_COMPUTER_CDP_URL names', async () => {
  const port = localAgentComputer({ history: owning(), requester, env: { PORT: '9000' } });
  expect((await port.forwardedProps(OWNER, 'default-session')).agentComputerCdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1:9000\/agent-computer\/cdp\?token=/);
  const named = localAgentComputer({ history: owning(), requester, env: { BOTCUBE_AGENT_COMPUTER_CDP_URL: 'ws://chat-service:8123/agent-computer/cdp' } });
  expect((await named.forwardedProps(OWNER, 'default-session')).agentComputerCdpUrl).toMatch(/^ws:\/\/chat-service:8123\/agent-computer\/cdp\?token=/);
});

it('refuses a start page or CDP URL that is not a URL', () => {
  expect(() => localAgentComputer({ history: owning(), requester, env: {}, startPage: 'login' })).toThrow('Invalid URL');
  expect(() => localAgentComputer({ history: owning(), requester, env: { BOTCUBE_AGENT_COMPUTER_CDP_URL: 'chat-service' } })).toThrow('Invalid URL');
});

it('refuses an unowned Session before starting its browser', async () => {
  newComputer({ history: owning({ owns: async () => false }) });
  await expect(computer?.forwardedProps('unowned-account', 'unknown-session')).rejects.toMatchObject({
    status: 404,
    message: 'This account does not own the Session',
  });
  expect(await computer?.browserLiveView({ owner: 'unowned-account' }, 'unknown-session')).toBeNull();
  expect(startupDiagnostics.spawned).toEqual([]);
});

it('authorizes an assigned Main Chat before its first Turn and denies every entry after fencing', { timeout: 15_000 }, async () => {
  let active = true;
  const history = {
    owns: async () => false,
    ownsMainChat: async (_owner: string, sessionId: string) => active && sessionId === 'assigned-main-chat',
  };
  const local = newComputer({ history, startPage: await fakeSite() });
  const origin = await served(computerApp(local, history));
  const capture = { stderr: '' };
  const startedAt = performance.now();
  let protocol = '';
  const record = (event: string, data = '') => {
    protocol = `${protocol}${Math.round(performance.now() - startedAt)}ms ${event} ${data}\n`.slice(-65_536);
  };
  const NativeWebSocket = globalThis.WebSocket;
  class StartupWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      record('connect', String(url));
      this.addEventListener('open', () => record('open'));
      this.addEventListener('error', () => record('error'));
      this.addEventListener('close', (event) => record('close', String(event.code)));
      this.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            id?: number;
            method?: string;
            result?: object;
            error?: { message: string };
            params?: { targetInfo?: { type?: string } };
          };
          record('receive', JSON.stringify({
            id: message.id,
            method: message.method,
            type: message.params?.targetInfo?.type,
            acknowledged: message.result !== undefined,
            error: message.error?.message,
          }));
        } catch (error) {
          record('unparseable', String(error));
        }
      });
    }
    override send(data: Parameters<WebSocket['send']>[0]) {
      record('send', typeof data === 'string' ? data : data.constructor.name);
      super.send(data);
    }
  }
  vi.stubGlobal('WebSocket', StartupWebSocket);
  startupDiagnostics.capture = capture;
  try {
    await local.warmSession({ owner: OWNER }, 'assigned-main-chat');
  } catch (error) {
    console.error('Fixture Chromium startup stderr:', capture.stderr);
    console.error('Fixture Chromium startup CDP:', protocol);
    throw error;
  } finally {
    startupDiagnostics.capture = undefined;
    vi.stubGlobal('WebSocket', NativeWebSocket);
  }
  const cdpUrl = cdpUrlOf(origin, tokenOf(await local.forwardedProps(OWNER, 'assigned-main-chat')));
  const response = await fetch(`${origin}/agent-computer?thread_id=assigned-main-chat`, as());
  expect(response.status).toBe(200);
  const state = (await response.json()) as { state: string; browserSessionId: string };
  expect(state.state).toBe('awake');
  const cdp = await AgentCdp.connect(cdpUrl);
  try {
    expect(await cdp.send('Browser.getVersion')).toMatchObject({ result: { protocolVersion: '1.3' } });
  } finally {
    cdp.close();
    await cdp.closed;
  }
  active = false;
  await expect(local.forwardedProps(OWNER, 'assigned-main-chat')).rejects.toMatchObject({ status: 404 });
  await expect(local.warmSession({ owner: OWNER }, 'assigned-main-chat')).rejects.toMatchObject({ status: 404 });
  expect(await local.browserLiveView({ owner: OWNER }, 'assigned-main-chat')).toBeNull();
  await Promise.all(([
    ['/agent-computer?thread_id=assigned-main-chat', 'GET', 404],
    ['/agent-computer/view?thread_id=assigned-main-chat', 'GET', 404],
    ['/agent-computer/wake?thread_id=assigned-main-chat', 'POST', 404],
    [`/browser-live-view-url?session_id=${state.browserSessionId}`, 'GET', 403],
    [`/browser-take-over?session_id=${state.browserSessionId}`, 'POST', 403],
    [`/browser-hand-back?session_id=${state.browserSessionId}`, 'POST', 403],
  ] as const).map(async ([path, method, status]) => {
    expect((await fetch(`${origin}${path}`, { method, ...as() })).status).toBe(status);
  }));
  const fenced = await AgentCdp.connect(cdpUrl);
  expect(await fenced.closed).toEqual({ code: 1011, reason: 'This account does not own the Session' });
});

it('retries a failed browser start when the executable becomes available', { timeout: 15_000 }, async () => {
  executableDirectory = await mkdtemp(resolve(tmpdir(), 'agent-browser-retry-'));
  const executable = resolve(executableDirectory, 'chromium');
  const app = computerApp(newComputer({ chromiumPath: executable, startPage: await fakeSite() }));
  const failed = await app.request('/agent-computer/wake?thread_id=retry-session', { method: 'POST', ...as() });
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({
    detail: `Agent Computer failed to start: Chromium is not installed at ${executable} (ENOENT): install it or set BOTCUBE_CHROMIUM_PATH`,
  });
  // A wrapper, not a symlink: macOS Chrome finds its framework only from its own path.
  await writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(testChromiumPath())} "$@"\n`, { mode: 0o755 });
  const retried = await app.request('/agent-computer/wake?thread_id=retry-session', { method: 'POST', ...as() });
  expect(retried.status).toBe(200);
  expect(await retried.json()).toMatchObject({ state: 'awake', control: 'agent' });
});

it(
  "wakes a replacement for an exited browser on its Session's next CDP connection",
  { timeout: 15_000 },
  async () => {
    let releaseDocument: () => void = () => undefined;
    const documentGate = new Promise<void>((resolve) => { releaseDocument = resolve; });
    const siteUrl = await fakeSite(() => undefined, documentGate);
    const local = newComputer({ startPage: siteUrl });
    const origin = await served(computerApp(local));
    await local.warmSession({ owner: OWNER }, 'exit-session');
    const initialView = await local.browserLiveView({ owner: OWNER }, 'exit-session');
    if (!initialView) throw new Error('Computer did not wake');
    const token = tokenOf(await local.forwardedProps(OWNER, 'exit-session'));
    const tampered = `${token.slice(0, -2)}xx`;
    expect((await fetch(`${origin}/agent-computer/cdp?${new URLSearchParams({ token: tampered })}`)).status).toBe(401);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 60 * 1000);
    try {
      expect((await fetch(`${origin}/agent-computer/cdp?${new URLSearchParams({ token })}`)).status).toBe(401);
    } finally {
      now.mockRestore();
    }
    const cdp = await AgentCdp.connect(cdpUrlOf(origin, token));
    try {
      expect(await cdp.send('Browser.getVersion')).toMatchObject({ result: { protocolVersion: '1.3' } });
      const targets = await cdp.send('Target.getTargets');
      const pages = targets.result?.targetInfos as { targetId: string; type: string }[];
      const page = pages.find((target) => target.type === 'page');
      if (!page) throw new Error('Computer has no page target');
      const attached = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      const pageSession = String(attached.result?.sessionId);
      expect(await cdp.send('Runtime.evaluate', { expression: '6 * 7' }, pageSession)).toMatchObject({
        result: { result: { value: 42 } },
      });
      // Page discovery precedes initial navigation completion. Cancel that
      // document and wait for the fixture navigation before mutating its DOM.
      await cdp.send('Page.enable', {}, pageSession);
      await cdp.send('Page.stopLoading', {}, pageSession);
      releaseDocument();
      const loaded = cdp.event('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: siteUrl }, pageSession);
      await loaded;
      executableDirectory = await mkdtemp(resolve(tmpdir(), 'agent-upload-control-'));
      await Promise.all(
        ['Browser.setDownloadBehavior', 'Page.setDownloadBehavior'].map(async (method) => {
          expect.soft(await cdp.send(method, { behavior: 'allow', downloadPath: executableDirectory }, pageSession)).toMatchObject({
            error: { message: `${method} is not allowed on the Agent Computer` },
          });
        })
      );
      const upload = resolve(executableDirectory, 'safe-marker.txt');
      await writeFile(upload, 'public-test-marker');
      await cdp.send('Runtime.evaluate', {
        expression: "document.body.insertAdjacentHTML('beforeend', '<input id=upload type=file>')",
      }, pageSession);
      const document = await cdp.send('DOM.getDocument', {}, pageSession);
      const root = document.result?.root as { nodeId: number };
      const input = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#upload' }, pageSession);
      expect(await cdp.send('DOM.setFileInputFiles', { nodeId: input.result?.nodeId, files: [upload] }, pageSession))
        .toMatchObject({ error: { message: expect.stringContaining('not allowed') } });
      expect(await cdp.send('Runtime.evaluate', { expression: "document.querySelector('#upload').files.length" }, pageSession))
        .toMatchObject({ result: { result: { value: 0 } } });
      const drag = { type: 'dragEnter', x: 10, y: 10 };
      expect(await cdp.send('Input.dispatchDragEvent', {
        ...drag,
        data: { items: [], files: [upload], dragOperationsMask: 1 },
      }, pageSession)).toMatchObject({
        error: { message: 'Input.dispatchDragEvent is not allowed on the Agent Computer' },
      });
      expect(await cdp.send('Input.dispatchDragEvent', {
        ...drag,
        data: { items: [{ mimeType: 'text/plain', data: 'public-drag-marker' }], dragOperationsMask: 1 },
      }, pageSession)).toMatchObject({ result: {} });
      await cdp.send('Network.enable', {}, pageSession);
      expect(await cdp.send('Page.navigate', { url: siteUrl }, pageSession)).toMatchObject({
        result: { frameId: expect.any(String) },
      });
      await cdp.event('Network.responseReceived');
      expect(JSON.stringify(cdp.received)).not.toContain('fixture-cookie-secret');
      expect(cdp.received.map((message) => message.method)).not.toContain('Network.responseReceivedExtraInfo');
      await Promise.all(
        (
          [
            ['Network.getAllCookies', {}],
            ['Storage.getCookies', {}],
            ['Network.getResponseBody', { requestId: 'fixture-request' }],
            ['Page.navigate', { url: 'file:///etc/passwd' }],
            ['Target.attachToTarget', { targetId: page.targetId }],
          ] as const
        ).map(async ([method, params]) => {
          expect(await cdp.send(method, params, pageSession)).toMatchObject({
            sessionId: pageSession,
            error: { code: -32000, message: `${method} is not allowed on the Agent Computer` },
          });
        })
      );
      await cdp.send('Browser.close');
      await cdp.closed;
      await expect
        .poll(async () => (await fetch(`${origin}/agent-computer?thread_id=exit-session`, as())).json(), {
          interval: 10,
          timeout: 1000,
        })
        .toEqual({ state: 'asleep', screenshot: null });
      const again = await AgentCdp.connect(cdpUrlOf(origin, token));
      try {
        expect(await again.send('Browser.getVersion')).toMatchObject({ result: { protocolVersion: '1.3' } });
      } finally {
        again.close();
      }
      expect(await (await fetch(`${origin}/agent-computer?thread_id=exit-session`, as())).json()).toMatchObject({
        state: 'awake',
        browserSessionId: expect.not.stringMatching(initialView.sessionId),
      });
    } finally {
      releaseDocument();
      cdp.close();
    }
  }
);

it('stops the actual local Chromium protocol and process', { timeout: 15_000 }, async () => {
  browser = await startLocalChromium(testChromiumPath(), await fakeSite(), new AbortController().signal);
  const cdp = await AgentCdp.connect(browser.endpoint);
  try {
    expect(await cdp.send('Browser.getVersion')).toMatchObject({ result: { protocolVersion: '1.3' } });
    expect(await cdp.send('Unknown.method')).toMatchObject({ error: { code: -32601 } });
    await browser.stop();
    expect(await cdp.closed).toMatchObject({ code: 1006 });
    await browser.closed;
    const url = new URL(browser.endpoint);
    url.protocol = 'http:';
    url.pathname = '/json/version';
    await expect(fetch(url)).rejects.toThrow('fetch failed');
  } finally {
    cdp.close();
  }
});

it('cancels a pending computer start at task stop', { timeout: 15_000 }, async () => {
  let entered: () => void = () => undefined;
  const starting = new Promise<void>((resolve) => { entered = resolve; });
  const local = newComputer({ chromiumPath: fixture('blocked-computer-start.py'), startPage: await fakeSite(entered) });
  const wake = computerApp(local).request('/agent-computer/wake?thread_id=pending-session', { method: 'POST', ...as() });
  await starting;
  await local.stop();
  const cancelled = await wake;
  expect(cancelled.status).toBe(503);
  expect(await cancelled.json()).toEqual({ detail: 'Agent Computer startup was cancelled' });
});

it('puts every computer to sleep at task stop and refuses a later wake', { timeout: 15_000 }, async () => {
  const local = newComputer({ startPage: await fakeSite() });
  const app = computerApp(local);
  const awake = await app.request('/agent-computer/wake?thread_id=stop-session', { method: 'POST', ...as() });
  expect(await awake.json()).toMatchObject({ state: 'awake', control: 'agent' });
  await local.stop();
  const asleep = await app.request('/agent-computer?thread_id=stop-session', as());
  expect(await asleep.json()).toEqual({ state: 'asleep', screenshot: null });
  const refused = await app.request('/agent-computer/wake?thread_id=stop-session', { method: 'POST', ...as() });
  expect(refused.status).toBe(503);
  expect(await refused.json()).toEqual({ detail: 'Agent Computer task is stopping' });
});

it.each(['task stop', 'idle'])(
  'reports failed profile cleanup after %s on HTTP reads, wake, handoff, and task stop',
  { timeout: 15_000 },
  async (retirement) => {
    const local = newComputer({ startPage: await fakeSite() });
    const app = computerApp(local);
    await local.warmSession({ owner: OWNER }, 'cleanup-session');
    cleanupFault.enabled = true;
    if (retirement === 'idle') {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        local.turnStarting({ owner: OWNER }, 'cleanup-session');
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      } finally {
        vi.useRealTimers();
      }
      await expect
        .poll(async () => (await app.request('/agent-computer?thread_id=cleanup-session', as())).status, { timeout: 1000 })
        .toBe(503);
    }
    await expect(local.stop()).rejects.toMatchObject({ status: 503, detail: 'Agent Computer profile cleanup failed' });
    const expectCleanupFailure = async (path: string, method: 'GET' | 'POST') => {
      const response = await app.request(`${path}?thread_id=cleanup-session`, { method, ...as() });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ detail: 'Agent Computer profile cleanup failed' });
    };
    await expectCleanupFailure('/agent-computer', 'GET');
    await expectCleanupFailure('/agent-computer/wake', 'POST');
    await expect(local.forwardedProps(OWNER, 'cleanup-session')).rejects.toMatchObject({ status: 503 });
    await expect(local.stop()).rejects.toMatchObject({ status: 503, detail: 'Agent Computer profile cleanup failed' });
  }
);

it('retires an idle computer and refreshes it on CDP activity', { timeout: 15_000 }, async () => {
  const local = newComputer({ startPage: await fakeSite() });
  const app = computerApp(local);
  const origin = await served(app);
  await local.warmSession({ owner: OWNER }, 'idle-session');
  const initial = await local.browserLiveView({ owner: OWNER }, 'idle-session');
  const cdp = await AgentCdp.connect(cdpUrlOf(origin, tokenOf(await local.forwardedProps(OWNER, 'idle-session'))));
  try {
    expect(await cdp.send('Browser.getVersion')).toMatchObject({ result: { protocolVersion: '1.3' } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    local.turnStarting({ owner: OWNER }, 'idle-session');
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    expect(await cdp.send('Browser.getVersion')).toMatchObject({ result: { protocolVersion: '1.3' } });
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
    expect(await (await app.request('/agent-computer?thread_id=idle-session', as())).json()).toMatchObject({ state: 'awake' });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    vi.useRealTimers();
    expect(await (await app.request('/agent-computer?thread_id=idle-session', as())).json()).toEqual({
      state: 'asleep',
      screenshot: null,
    });
    expect((await app.request('/agent-computer/view?thread_id=idle-session', as())).status).toBe(409);
    expect(await cdp.closed).toMatchObject({ code: 1011 });
    const replacement = await app.request('/agent-computer/wake?thread_id=idle-session', { method: 'POST', ...as() });
    expect(await replacement.json()).toMatchObject({
      state: 'awake',
      browserSessionId: expect.not.stringMatching(initial?.sessionId ?? ''),
    });
  } finally {
    vi.useRealTimers();
    cdp.close();
  }
});

it('answers a usable page when Chromium exposes DevTools before creating its startup page', async () => {
  vi.stubEnv('REAL_CHROMIUM', testChromiumPath());
  try {
    browser = await startLocalChromium(fixture('delayed-computer-page.py'), await fakeSite(), new AbortController().signal);
    const cdp = await AgentCdp.connect(browser.endpoint);
    try {
      const targets = await cdp.send('Target.getTargets');
      const pages = targets.result?.targetInfos as { type: string }[];
      expect(pages.map((target) => target.type)).toContain('page');
    } finally {
      cdp.close();
      await cdp.closed;
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

it('cleans a browser fixture whose profile cleanup first fails during teardown', async () => {
  const local = newComputer({ startPage: await fakeSite() });
  await local.warmSession({ owner: 'fixture-owner' }, 'fixture-session');
  expect(await local.browserLiveView({ owner: 'fixture-owner' }, 'fixture-session')).toMatchObject({ open: true });
  cleanupFault.enabled = true;
});

it('classifies a Chromium startup that never creates a page', { timeout: 15_000 }, async () => {
  executableDirectory = await mkdtemp(resolve(tmpdir(), 'agent-browser-retry-'));
  const executable = resolve(executableDirectory, 'chromium');
  await writeFile(executable, `#!/usr/bin/env python3\nimport os, sys\nchromium = ${JSON.stringify(testChromiumPath())}\nos.execv(chromium, [chromium, *[arg for arg in sys.argv[1:] if not arg.startswith('http')], '--no-startup-window'])\n`, { mode: 0o755 });
  await expect(startLocalChromium(executable, await fakeSite(), new AbortController().signal)).rejects.toThrow(
    'Agent Computer Chromium startup timed out while waiting for a page target'
  );
});
