import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HttpError, serveChatService, type AccountHistory } from 'botcube-chat';
import { templateChromiumPath } from '../../../../tests/chat/fakes/template-chromium.js';
import { AgentCdp } from '../../../../tests/chat/fakes/agent-cdp.js';
import { templateRequester } from './account.js';
import { templateComputer } from './computer.js';
import { startLocalComputer, type LocalComputer } from './local-computer.js';
import { templateCartridgeFactory } from './cartridge.js';

const startupDiagnostics = vi.hoisted(() => ({
  capture: undefined as { stderr: string } | undefined,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
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

const cleanupFault = vi.hoisted(() => ({
  enabled: false,
  paths: [] as string[],
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (
        cleanupFault.enabled &&
        String(args[0]).includes('template-computer-')
      ) {
        cleanupFault.paths.push(String(args[0]));
        throw new Error('Profile cleanup denied');
      }
      return actual.rm(...args);
    },
  };
});

let site: Server | undefined;
let browser: LocalComputer | undefined;
let computer: ReturnType<typeof templateComputer> | undefined;
let service: ReturnType<typeof serveChatService> | undefined;
let executableDirectory: string | undefined;
afterEach(async () => {
  startupDiagnostics.capture = undefined;
  try {
    if (cleanupFault.enabled)
      await expect(computer?.stop()).rejects.toMatchObject({
        status: 503,
        detail: 'Agent Computer profile cleanup failed',
      });
    else await computer?.stop();
  } finally {
    cleanupFault.enabled = false;
    await Promise.all(
      cleanupFault.paths
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true }))
    );
    await browser?.stop();
    if (service)
      await new Promise<void>((resolve, reject) =>
        service?.close((error) => (error ? reject(error) : resolve()))
      );
    if (site)
      await new Promise<void>((resolve, reject) =>
        site?.close((error) => (error ? reject(error) : resolve()))
      );
    site = undefined;
    browser = undefined;
    computer = undefined;
    service = undefined;
    if (executableDirectory)
      await rm(executableDirectory, { recursive: true, force: true });
    executableDirectory = undefined;
  }
});

it('refuses an unowned Session before starting its browser', async () => {
  const history: AccountHistory = {
    ownsMainChat: async () => false,
      owns: async () => false,
    delete: async () => undefined,
    transfer: async () => undefined,
  };
  computer = templateComputer({
    history,
    requester: templateRequester,
    siteUrl: 'http://127.0.0.1:1/login',
    chromiumPath: templateChromiumPath(),
    cdpUrl: 'ws://127.0.0.1/computer',
  });
  await expect(computer.forwardedProps('unowned-account', 'unknown-session'))
    .rejects.toMatchObject({ status: 404, message: 'This account does not own the Session' });
  expect(await computer.browserLiveView({ owner: 'unowned-account' }, 'unknown-session')).toBeNull();
});

it('authorizes an assigned Main Chat before its first Turn and denies every entry after fencing', { timeout: 15_000 }, async () => {
  let active = true;
  const history: AccountHistory = {
    owns: async () => false,
    ownsMainChat: async (_owner, sessionId) => active && sessionId === 'assigned-main-chat',
    delete: async () => undefined,
    transfer: async () => undefined,
  };
  computer = templateComputer({
    history, requester: templateRequester, siteUrl: await fakeSite(),
    chromiumPath: templateChromiumPath(), cdpUrl: 'ws://127.0.0.1/computer',
  });
  const baseline = templateCartridgeFactory({}, () => undefined)(history);
  service = serveChatService(() => ({ ...baseline, routes: computer ? computer.routes : baseline.routes }), { PORT: '0' });
  if (!service.listening) await new Promise<void>((resolve) => service?.once('listening', resolve));
  const address = service.address();
  if (!address || typeof address === 'string') throw new Error('Computer service has no port');
  const origin = `http://127.0.0.1:${address.port}`;
  const session = await new Hono().get('/account/session', async (c) => c.json(await templateRequester(c))).request('/account/session');
  const { owner } = await session.json() as { owner: string };
  const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
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
    await computer.warmSession({ owner }, 'assigned-main-chat');
  } catch (error) {
    console.error('Fixture Chromium startup stderr:', capture.stderr);
    console.error('Fixture Chromium startup CDP:', protocol);
    throw error;
  } finally {
    startupDiagnostics.capture = undefined;
    vi.stubGlobal('WebSocket', NativeWebSocket);
  }
  const props = await computer.forwardedProps(owner, 'assigned-main-chat');
  const response = await fetch(`${origin}/agent-computer?thread_id=assigned-main-chat`, { headers: { cookie } });
  expect(response.status).toBe(200);
  const state = await response.json() as { state: string; browserSessionId: string };
  expect(state.state).toBe('awake');
  const token = new URL(props.agentComputerCdpUrl).searchParams.get('token') ?? '';
  const cdpPath = `/agent-computer/cdp?${new URLSearchParams({ token })}`;
  const cdp = await AgentCdp.connect(`${origin.replace('http:', 'ws:')}${cdpPath}`);
  try { expect(await cdp.send('Browser.getVersion')).toMatchObject({ result: { protocolVersion: '1.3' } }); }
  finally { cdp.close(); await cdp.closed; }
  active = false;
  await expect(computer.forwardedProps(owner, 'assigned-main-chat')).rejects.toMatchObject({ status: 404 });
  await expect(computer.warmSession({ owner }, 'assigned-main-chat')).rejects.toMatchObject({ status: 404 });
  expect(await computer.browserLiveView({ owner }, 'assigned-main-chat')).toBeNull();
  await Promise.all(([
    ['/agent-computer?thread_id=assigned-main-chat', 'GET', 404],
    ['/agent-computer/view?thread_id=assigned-main-chat', 'GET', 404],
    ['/agent-computer/wake?thread_id=assigned-main-chat', 'POST', 404],
    [`/browser-live-view-url?session_id=${state.browserSessionId}`, 'GET', 403],
    [`/browser-take-over?session_id=${state.browserSessionId}`, 'POST', 403],
    [`/browser-hand-back?session_id=${state.browserSessionId}`, 'POST', 403],
    [cdpPath, 'GET', 404],
  ] as const).map(async ([path, method, status]) => {
    expect((await fetch(`${origin}${path}`, { method, headers: { cookie } })).status).toBe(status);
  }));
});

it(
  'retries a failed browser start when the executable becomes available',
  { timeout: 15_000 },
  async () => {
    executableDirectory = await mkdtemp(
      resolve(tmpdir(), 'template-browser-retry-')
    );
    const executable = resolve(executableDirectory, 'chromium');
    const history: AccountHistory = {
      ownsMainChat: async () => false,
      owns: async () => true,
      delete: async () => undefined,
      transfer: async () => undefined,
    };
    computer = templateComputer({
      history,
      requester: templateRequester,
      siteUrl: await fakeSite(),
      chromiumPath: executable,
      cdpUrl: 'ws://127.0.0.1/computer',
    });
    const app = new Hono()
      .get('/account/session', async (c) => c.json(await templateRequester(c)))
      .route('/', computer.routes);
    app.onError((error, c) => c.json({ detail: error.message }, 500));
    const account = await app.request('/account/session');
    const cookie = account.headers.get('set-cookie')?.split(';')[0] ?? '';
    const failed = await app.request(
      '/agent-computer/wake?thread_id=retry-session',
      { method: 'POST', headers: { cookie } }
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({
      detail: expect.stringContaining('ENOENT'),
    });
    await symlink(templateChromiumPath(), executable);
    const retried = await app.request(
      '/agent-computer/wake?thread_id=retry-session',
      { method: 'POST', headers: { cookie } }
    );
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      state: 'awake',
      control: 'agent',
    });
  }
);

it(
  'retires an exited browser and its signed CDP capability before waking a replacement',
  { timeout: 15_000 },
  async () => {
    const siteUrl = await fakeSite();
    const history: AccountHistory = {
      ownsMainChat: async () => false,
      owns: async () => true,
      delete: async () => undefined,
      transfer: async () => undefined,
    };
    computer = templateComputer({
      history,
      requester: templateRequester,
      siteUrl,
      chromiumPath: templateChromiumPath(),
      cdpUrl: 'ws://127.0.0.1/computer',
    });
    const routes = computer.routes;
    const baseline = templateCartridgeFactory({}, () => undefined)(history);
    service = serveChatService(() => ({ ...baseline, routes }), { PORT: '0' });
    if (!service.listening)
      await new Promise<void>((resolve) => service?.once('listening', resolve));
    const address = service.address();
    if (!address || typeof address === 'string')
      throw new Error('Computer service has no port');
    const origin = `http://127.0.0.1:${address.port}`;
    const accountApp = new Hono().get('/account/session', async (c) =>
      c.json(await templateRequester(c))
    );
    const session = await accountApp.request('/account/session');
    const { owner } = (await session.json()) as { owner: string };
    const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
    const props = await computer.forwardedProps(owner, 'exit-session');
    const initialView = await computer.browserLiveView(
      { owner },
      'exit-session'
    );
    if (!initialView) throw new Error('Computer did not wake');
    const signed = new URL(props.agentComputerCdpUrl);
    const token = signed.searchParams.get('token') ?? '';
    const tampered = `${token.slice(0, -2)}xx`;
    expect(
      (
        await fetch(
          `${origin}/agent-computer/cdp?${new URLSearchParams({ token: tampered })}`
        )
      ).status
    ).toBe(401);
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 11 * 60 * 1000);
    try {
      expect(
        (
          await fetch(
            `${origin}/agent-computer/cdp?${new URLSearchParams({ token })}`
          )
        ).status
      ).toBe(401);
    } finally {
      now.mockRestore();
    }
    const cdpUrl = `${origin.replace('http:', 'ws:')}/agent-computer/cdp?${new URLSearchParams({ token })}`;
    const cdp = await AgentCdp.connect(cdpUrl);
    try {
      expect(await cdp.send('Browser.getVersion')).toMatchObject({
        result: { protocolVersion: '1.3' },
      });
      const targets = await cdp.send('Target.getTargets');
      const pages = targets.result?.targetInfos as {
        targetId: string;
        type: string;
      }[];
      const page = pages.find((target) => target.type === 'page');
      if (!page) throw new Error('Computer has no page target');
      const attached = await cdp.send('Target.attachToTarget', {
        targetId: page.targetId,
        flatten: true,
      });
      const pageSession = String(attached.result?.sessionId);
      expect(
        await cdp.send('Runtime.evaluate', { expression: '6 * 7' }, pageSession)
      ).toMatchObject({ result: { result: { value: 42 } } });
      executableDirectory = await mkdtemp(resolve(tmpdir(), 'template-upload-control-'));
      await Promise.all(
        ['Browser.setDownloadBehavior', 'Page.setDownloadBehavior'].map(async (method) => {
          expect.soft(await cdp.send(method, {
            behavior: 'allow', downloadPath: executableDirectory,
          }, pageSession)).toMatchObject({
            error: { message: `${method} is not allowed on the Agent Computer` },
          });
        })
      );
      const fixture = resolve(executableDirectory, 'safe-marker.txt');
      await writeFile(fixture, 'public-test-marker');
      await cdp.send('Runtime.evaluate', {
        expression: "document.body.insertAdjacentHTML('beforeend', '<input id=upload type=file>')",
      }, pageSession);
      const document = await cdp.send('DOM.getDocument', {}, pageSession);
      const root = document.result?.root as { nodeId: number };
      const input = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#upload' }, pageSession);
      expect(await cdp.send('DOM.setFileInputFiles', {
        nodeId: input.result?.nodeId, files: [fixture],
      }, pageSession)).toMatchObject({ error: { message: expect.stringContaining('not allowed') } });
      expect(await cdp.send('Runtime.evaluate', {
        expression: "document.querySelector('#upload').files.length",
      }, pageSession)).toMatchObject({ result: { result: { value: 0 } } });
      const drag = { type: 'dragEnter', x: 10, y: 10 };
      expect(await cdp.send('Input.dispatchDragEvent', {
        ...drag,
        data: { items: [], files: [fixture], dragOperationsMask: 1 },
      }, pageSession)).toMatchObject({
        error: { message: 'Input.dispatchDragEvent is not allowed on the Agent Computer' },
      });
      expect(await cdp.send('Input.dispatchDragEvent', {
        ...drag,
        data: {
          items: [{ mimeType: 'text/plain', data: 'public-drag-marker' }],
          dragOperationsMask: 1,
        },
      }, pageSession)).toMatchObject({ result: {} });
      await cdp.send('Network.enable', {}, pageSession);
      expect(
        await cdp.send('Page.navigate', { url: siteUrl }, pageSession)
      ).toMatchObject({ result: { frameId: expect.any(String) } });
      await cdp.event('Network.responseReceived');
      expect(JSON.stringify(cdp.received)).not.toContain(
        'fixture-cookie-secret'
      );
      expect(cdp.received.map((message) => message.method)).not.toContain(
        'Network.responseReceivedExtraInfo'
      );
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
            error: {
              code: -32000,
              message: `${method} is not allowed on the Agent Computer`,
            },
          });
        })
      );
      await cdp.send('Browser.close');
      await cdp.closed;
      await expect
        .poll(
          async () =>
            (
              await fetch(`${origin}/agent-computer?thread_id=exit-session`, {
                headers: { cookie },
              })
            ).json(),
          { interval: 10, timeout: 1000 }
        )
        .toEqual({ state: 'asleep', screenshot: null });
      expect(
        (
          await fetch(
            `${origin}/agent-computer/cdp?${new URLSearchParams({ token })}`
          )
        ).status
      ).toBe(401);
      const replacement = await fetch(
        `${origin}/agent-computer/wake?thread_id=exit-session`,
        { method: 'POST', headers: { cookie } }
      );
      expect(await replacement.json()).toMatchObject({
        state: 'awake',
        browserSessionId: expect.not.stringMatching(initialView.sessionId),
      });
    } finally {
      cdp.close();
    }
  }
);

async function fakeSite(visited: () => void = () => undefined) {
  site = createServer((_request, response) => {
    visited();
    response.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': 'site_session=fixture-cookie-secret; HttpOnly; Path=/',
    });
    response.end('<h1>Template site</h1>');
  });
  await new Promise<void>((resolve) => site?.listen(0, '127.0.0.1', resolve));
  const address = site.address();
  if (!address || typeof address === 'string')
    throw new Error('Fake site has no port');
  return `http://127.0.0.1:${address.port}`;
}

it(
  'stops the actual local computer protocol and process',
  { timeout: 15_000 },
  async () => {
    browser = await startLocalComputer(
      templateChromiumPath(),
      await fakeSite(),
      new AbortController().signal
    );
    const cdp = await AgentCdp.connect(browser.endpoint);
    try {
      expect(await cdp.send('Browser.getVersion')).toMatchObject({
        result: { protocolVersion: '1.3' },
      });
      expect(await cdp.send('Template.unsupported')).toMatchObject({
        error: { code: -32601 },
      });
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
  }
);

it(
  'cancels a pending computer start at task stop',
  { timeout: 15_000 },
  async () => {
    let entered: () => void = () => undefined;
    const starting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const history: AccountHistory = {
      ownsMainChat: async () => false,
      owns: async () => true,
      delete: async () => undefined,
      transfer: async () => undefined,
    };
    computer = templateComputer({
      history,
      requester: templateRequester,
      siteUrl: await fakeSite(entered),
      chromiumPath: resolve('tests/chat/fakes/blocked-computer-start.py'),
      cdpUrl: 'ws://127.0.0.1/computer',
    });
    const app = new Hono().route('/', computer.routes);
    app.onError((error, c) =>
      error instanceof HttpError
        ? c.json({ detail: error.detail }, error.status as 503)
        : c.json({ detail: error.message }, 500)
    );
    const wake = app.request('/agent-computer/wake?thread_id=pending-session', {
      method: 'POST',
    });
    await starting;
    await computer.stop();
    const cancelled = await wake;
    expect(cancelled.status).toBe(503);
    expect(await cancelled.json()).toEqual({
      detail: 'Agent Computer startup was cancelled',
    });
  }
);

it(
  'puts the owner computer to sleep through the task stop callback and refuses later wake',
  { timeout: 15_000 },
  async () => {
    const history: AccountHistory = {
      ownsMainChat: async () => false,
      owns: async () => true,
      delete: async () => undefined,
      transfer: async () => undefined,
    };
    computer = templateComputer({
      history,
      requester: templateRequester,
      siteUrl: await fakeSite(),
      chromiumPath: templateChromiumPath(),
      cdpUrl: 'ws://127.0.0.1/computer',
    });
    const app = new Hono()
      .get('/account/session', async (c) => c.json(await templateRequester(c)))
      .route('/', computer.routes);
    app.onError((error, c) =>
      error instanceof HttpError
        ? c.json({ detail: error.detail }, error.status as 503)
        : c.json({ detail: error.message }, 500)
    );
    const session = await app.request('/account/session');
    const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
    const init = { headers: { cookie } };
    const awake = await app.request(
      '/agent-computer/wake?thread_id=stop-session',
      { ...init, method: 'POST' }
    );
    expect(await awake.json()).toMatchObject({
      state: 'awake',
      control: 'agent',
    });
    await computer.stop();
    const asleep = await app.request(
      '/agent-computer?thread_id=stop-session',
      init
    );
    expect(await asleep.json()).toEqual({ state: 'asleep', screenshot: null });
    const refused = await app.request(
      '/agent-computer/wake?thread_id=stop-session',
      { ...init, method: 'POST' }
    );
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      detail: 'Agent Computer task is stopping',
    });
  }
);

it.each(['task stop', 'idle'])(
  'reports failed profile cleanup after %s on HTTP reads, wake, handoff, and task stop',
  { timeout: 15_000 },
  async (retirement) => {
    computer = templateComputer({
      history: {
        ownsMainChat: async () => false,
      owns: async () => true,
        delete: async () => undefined,
        transfer: async () => undefined,
      },
      requester: templateRequester,
      siteUrl: await fakeSite(),
      chromiumPath: templateChromiumPath(),
      cdpUrl: 'ws://127.0.0.1/computer',
    });
    const app = new Hono()
      .get('/account/session', async (c) => c.json(await templateRequester(c)))
      .route('/', computer.routes);
    app.onError((error, c) =>
      error instanceof HttpError
        ? c.json({ detail: error.detail }, error.status as 503)
        : c.json({ detail: error.message }, 500)
    );
    const session = await app.request('/account/session');
    const { owner } = (await session.json()) as { owner: string };
    const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
    await computer.forwardedProps(owner, 'cleanup-session');
    await computer.warmSession({ owner }, 'cleanup-session');
    cleanupFault.enabled = true;
    if (retirement === 'idle') {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await computer.forwardedProps(owner, 'cleanup-session');
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      } finally {
        vi.useRealTimers();
      }
      await expect
        .poll(
          async () =>
            (
              await app.request('/agent-computer?thread_id=cleanup-session', {
                headers: { cookie },
              })
            ).status,
          { timeout: 1000 }
        )
        .toBe(503);
    }
    await expect(computer.stop()).rejects.toMatchObject({
      status: 503,
      detail: 'Agent Computer profile cleanup failed',
    });
    const expectCleanupFailure = async (
      path: string,
      method: 'GET' | 'POST'
    ) => {
      const response = await app.request(`${path}?thread_id=cleanup-session`, {
        method,
        headers: { cookie },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        detail: 'Agent Computer profile cleanup failed',
      });
    };
    await expectCleanupFailure('/agent-computer', 'GET');
    await expectCleanupFailure('/agent-computer/wake', 'POST');
    await expect(
      computer.forwardedProps(owner, 'cleanup-session')
    ).rejects.toMatchObject({ status: 503 });
    await expect(computer.stop()).rejects.toMatchObject({
      status: 503,
      detail: 'Agent Computer profile cleanup failed',
    });
  }
);

it(
  'retires an idle computer, refreshes on CDP activity, and invalidates its old capability',
  { timeout: 15_000 },
  async () => {
    computer = templateComputer({
      history: {
        ownsMainChat: async () => false,
      owns: async () => true,
        delete: async () => undefined,
        transfer: async () => undefined,
      },
      requester: templateRequester,
      siteUrl: await fakeSite(),
      chromiumPath: templateChromiumPath(),
      cdpUrl: 'ws://127.0.0.1/computer',
    });
    const app = new Hono()
      .get('/account/session', async (c) => c.json(await templateRequester(c)))
      .route('/', computer.routes);
    const session = await app.request('/account/session');
    const { owner } = (await session.json()) as { owner: string };
    const cookie = session.headers.get('set-cookie')?.split(';')[0] ?? '';
    const baseline = templateCartridgeFactory(
      {},
      () => undefined
    )({
      ownsMainChat: async () => false,
      owns: async () => true,
      delete: async () => undefined,
      transfer: async () => undefined,
    });
    const routes = computer.routes;
    service = serveChatService(() => ({ ...baseline, routes }), { PORT: '0' });
    if (!service.listening)
      await new Promise<void>((resolve) => service?.once('listening', resolve));
    const address = service.address();
    if (!address || typeof address === 'string')
      throw new Error('Computer service has no port');
    const origin = `http://127.0.0.1:${address.port}`;
    await computer.forwardedProps(owner, 'idle-session');
    try {
      const props = await computer.forwardedProps(owner, 'idle-session');
      const initial = await computer.browserLiveView({ owner }, 'idle-session');
      const token =
        new URL(props.agentComputerCdpUrl).searchParams.get('token') ?? '';
      const cdp = await AgentCdp.connect(
        `${origin.replace('http:', 'ws:')}/agent-computer/cdp?${new URLSearchParams({ token })}`
      );
      try {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await computer.forwardedProps(owner, 'idle-session');
        await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
        expect(await cdp.send('Browser.getVersion')).toMatchObject({
          result: { protocolVersion: '1.3' },
        });
        await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
        expect(
          await (
            await app.request('/agent-computer?thread_id=idle-session', {
              headers: { cookie },
            })
          ).json()
        ).toMatchObject({ state: 'awake' });
        await vi.advanceTimersByTimeAsync(60 * 1000);
        vi.useRealTimers();
        expect(
          await (
            await app.request('/agent-computer?thread_id=idle-session', {
              headers: { cookie },
            })
          ).json()
        ).toEqual({ state: 'asleep', screenshot: null });
        expect(
          (
            await fetch(
              `${origin}/agent-computer/view?thread_id=idle-session`,
              {
                headers: { cookie },
              }
            )
          ).status
        ).toBe(409);
        expect(await cdp.closed).toMatchObject({ code: 1001 });
        await expect
          .poll(
            async () =>
              (
                await app.request('/agent-computer?thread_id=idle-session', {
                  headers: { cookie },
                })
              ).json(),
            { timeout: 1000 }
          )
          .toEqual({ state: 'asleep', screenshot: null });
        expect(
          (
            await fetch(
              `${origin}/agent-computer/cdp?${new URLSearchParams({ token })}`
            )
          ).status
        ).toBe(401);
        const replacement = await app.request(
          '/agent-computer/wake?thread_id=idle-session',
          { method: 'POST', headers: { cookie } }
        );
        expect(await replacement.json()).toMatchObject({
          state: 'awake',
          browserSessionId: expect.not.stringMatching(initial?.sessionId ?? ''),
        });
      } finally {
        cdp.close();
      }
    } finally {
      vi.useRealTimers();
    }
  }
);


it('answers a usable page when Chromium exposes DevTools before creating its startup page', async () => {
  vi.stubEnv('TEMPLATE_REAL_CHROMIUM', templateChromiumPath());
  try {
    browser = await startLocalComputer(
      resolve('tests/chat/fakes/delayed-computer-page.py'),
      await fakeSite(),
      new AbortController().signal
    );
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
  computer = templateComputer({
    history: {
      ownsMainChat: async () => false,
      owns: async () => true,
      delete: async () => undefined,
      transfer: async () => undefined,
    },
    requester: templateRequester,
    siteUrl: await fakeSite(),
    chromiumPath: templateChromiumPath(),
    cdpUrl: 'ws://127.0.0.1/computer',
  });
  await computer.warmSession({ owner: 'fixture-owner' }, 'fixture-session');
  expect(
    await computer.browserLiveView(
      { owner: 'fixture-owner' },
      'fixture-session'
    )
  ).toMatchObject({ open: true });
  cleanupFault.enabled = true;
});


it('classifies a Chromium startup that never creates a page', { timeout: 15_000 }, async () => {
  executableDirectory = await mkdtemp(resolve(tmpdir(), 'template-browser-retry-'));
  const executable = resolve(executableDirectory, 'chromium');
  await writeFile(executable, `#!/usr/bin/env python3\nimport os, sys\nchromium = ${JSON.stringify(templateChromiumPath())}\nos.execv(chromium, [chromium, *[arg for arg in sys.argv[1:] if not arg.startswith('http')], '--no-startup-window'])\n`, { mode: 0o755 });
  await expect(startLocalComputer(executable, await fakeSite(), new AbortController().signal)).rejects.toThrow('Agent Computer Chromium startup timed out while waiting for a page target');
});
