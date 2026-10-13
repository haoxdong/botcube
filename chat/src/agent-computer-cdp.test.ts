import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType, type WebSocketServerLike } from '@hono/node-server';
import { HttpError } from './index.js';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as UpstreamSocket } from 'ws';
import { realBrowserClient, realSingleClientBrowser } from '../test/real-browser.js';
import { memoryDocuments } from '../test/memory-documents.js';
import { AccountResources } from './account-resources.js';
import { agentComputers, type AgentComputerBrowser } from './agent-computer.js';
import type { AccountFiles } from './files.js';
import { agentComputerCdp } from './agent-computer-cdp.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * What `settling` settles to, failing the test within 2 s otherwise: a Mutant that hangs the channel
 * must fail an assertion, since the Mutation Gate does not count a timed-out test as a kill.
 */
function soon<T>(settling: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the channel did not answer within 2s')), 2000);
  });
  return Promise.race([settling, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The Session's browser automation stream: records what it receives and the headers it was opened with. With
 * `oneClient`, it refuses a second client while one is connected, as AgentCore's does.
 */
async function automationStream({ oneClient = false } = {}) {
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    verifyClient: (_info, admit) =>
      oneClient && server.clients.size > 0
        ? admit(false, 429, 'Too many connections. Concurrent connections to the same session are not supported.')
        : admit(true),
  });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const stream = {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/automation`,
    received: [] as string[],
    headers: [] as IncomingHttpHeaders[],
    sockets: [] as UpstreamSocket[],
    closed: 0,
  };
  server.on('connection', (socket, request) => {
    stream.headers.push(request.headers);
    stream.sockets.push(socket);
    let root = '';
    const send = socket.send.bind(socket);
    socket.send = ((data: Parameters<typeof socket.send>[0]) => {
      if (typeof data !== 'string') throw new Error('The CDP fixture accepts text frames');
      const message = JSON.parse(data) as Record<string, unknown>;
      if (message.sessionId === undefined) message.sessionId = root;
      send(JSON.stringify(message));
    }) as typeof socket.send;
    socket.on('message', (data: Buffer) => {
      const command = JSON.parse(data.toString()) as { id: number; method: string; sessionId?: string };
      if (command.method === 'Target.attachToBrowserTarget') {
        root = `browser-root-${stream.sockets.length}`;
        send(JSON.stringify({ id: command.id, result: { sessionId: root } }));
        return;
      }
      if (command.method === 'Target.detachFromTarget') {
        send(JSON.stringify({ id: command.id, result: {} }));
        return;
      }
      if (command.sessionId === root) delete command.sessionId;
      stream.received.push(JSON.stringify(command));
    });
    socket.on('close', () => (stream.closed += 1));
  });
  cleanups.push(() => {
    for (const socket of server.clients) socket.terminate();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return stream;
}

type Wake = () => Promise<{ state: 'awake'; browserSessionId: string; control: 'user' | 'agent' } | { state: 'asleep' }>;

/** The CDP channel served on a real port, over fake Agent Computers. */
async function channel(
  endpoint: string,
  wake: Wake = async () => ({ state: 'awake', browserSessionId: 'browser-1', control: 'agent' }),
  issuedToken = 'good',
  control: () => Promise<'user' | 'agent'> = async () => 'agent',
  use: () => boolean = () => true,
  claimStream: (accountId: string, sessionId: string, letGo: () => Promise<void>) => (() => void) | null = () => () => {},
  opening: () => Promise<void> = async () => {},
) {
  const calls: string[][] = [];
  const route = agentComputerCdp({
    computers: {
      async wake(accountId, threadId) {
        calls.push(['wake', accountId, threadId]);
        return wake();
      },
      use(accountId, sessionId) {
        calls.push(['use', accountId, sessionId]);
        return use();
      },
      claimStream,
    },
    browser: () => ({
      async automationStream(sessionId) {
        calls.push(['automationStream', sessionId]);
        await opening();
        return { endpoint, headers: { 'x-amz-date': 'signed' } };
      },
      async control(sessionId) {
        calls.push(['control', sessionId]);
        return control();
      },
    }),
    verify: (token) => (token === issuedToken ? { accountId: 'acct-1', threadId: 'thread-1' } : null),
  });
  const app = new Hono().get('/cdp', route);
  const server = await new Promise<ServerType>((resolve) => {
    const started: ServerType = serve(
      {
        fetch: app.fetch,
        port: 0,
        hostname: '127.0.0.1',
        // The unit suite shares one process: leave the global Request and Response as they were.
        overrideGlobalObjects: false,
        websocket: { server: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike },
      },
      () => resolve(started),
    );
  });
  cleanups.push(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/cdp`, calls };
}

/** The agent's end of the channel. */
function agent(url: string) {
  const socket = new WebSocket(url);
  cleanups.push(async () => socket.close());
  const received: unknown[] = [];
  socket.addEventListener('message', (event) => received.push(JSON.parse(String(event.data))));
  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener('open', () => resolve(true));
    socket.addEventListener('error', () => resolve(false));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })),
  );
  return { socket, received, opened, closed };
}

/** An AgentCore browser whose screenshot opens the automation stream, as `withBrowser` does. */
const fakeBrowser = (stream: string, overrides: Partial<AgentComputerBrowser> = {}): AgentComputerBrowser => ({
  browserId: 'agent-computer-browser',
  start: async () => 'browser-1',
  control: async () => 'agent',
  automationStream: async () => ({ endpoint: stream, headers: {} }),
  screenshot: async () => {
    const socket = new WebSocket(stream);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', () => reject(new Error(`CDP connection to ${stream} failed`)));
    });
    socket.close();
    return 'data:image/jpeg;base64,screen';
  },
  beforeProfileSave: async () => {},
  createProfile: async () => 'profile-1',
  saveProfile: async () => {},
  deleteProfile: async () => {},
  stop: async () => {},
  handBack: async () => {},
  ...overrides,
});

/** The account's Agent Computers over `browser`, with the account's Files mounted. */
function computersFor(browser: AgentComputerBrowser, idleSeconds = 600) {
  const store = new AccountResources('chat', memoryDocuments());
  const unusedFilesOperation = async () => { throw new Error('This browser test only mounts Files'); };
  const files: AccountFiles = {
    mount: async () => ({ accessPointArn: 'access', fileSystemArn: 'files', mountPath: '/mnt/files' }),
    list: unusedFilesOperation,
    uploadUrl: unusedFilesOperation,
    downloadUrl: unusedFilesOperation,
    remove: unusedFilesOperation,
    rename: unusedFilesOperation,
    syncBinding: unusedFilesOperation,
    transfer: unusedFilesOperation,
    delete: unusedFilesOperation,
  };
  const computers = agentComputers({ browser: () => browser, records: () => store, seed: async () => {}, files: () => files, idleSeconds });
  cleanups.push(() => computers.revoke('acct-1'));
  return computers;
}

/** The automation stream's clients that came through the agent's channel, which signs them. */
const proxied = (stream: { headers: IncomingHttpHeaders[] }) => stream.headers.filter((headers) => headers['x-amz-date'] === 'signed').length;

const until = (condition: () => boolean) =>
  soon(
    new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (!condition()) return;
        clearInterval(poll);
        resolve();
      }, 10);
      cleanups.push(async () => clearInterval(poll));
    }),
  );

describe("the agent's CDP channel to its Agent Computer", () => {
  it('accepts a percent-encoded character in the issued query token', async () => {
    const stream = await automationStream();
    const { url, calls } = await channel(stream.url);
    const client = agent(`${url}?token=%67ood`);

    expect(await soon(client.opened)).toBe(true);
    await until(() => calls.some(([operation]) => operation === 'automationStream'));
    expect(calls).toContainEqual(['wake', 'acct-1', 'thread-1']);
  });

  it('accepts a standalone issued token with its dot percent encoded in the query', async () => {
    const stream = await automationStream();
    const { url, calls } = await channel(stream.url, undefined, 'cdp.signed.token');
    const client = agent(`${url}?token=cdp%2Esigned.token`);
    expect(await soon(client.opened)).toBe(true);
    await until(() => calls.some(([operation]) => operation === 'automationStream'));
    expect(calls).toContainEqual(['wake', 'acct-1', 'thread-1']);
  });

  it('refuses a token this Chat Service did not issue', async () => {
    const stream = await automationStream();
    const { url, calls } = await channel(stream.url);

    expect(await soon(agent(`${url}?token=forged`).opened)).toBe(false);
    expect(await soon(agent(url).opened)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("wakes the token's Session, then relays allowed commands and answers denied ones itself", async () => {
    const stream = await automationStream();
    let wakeUp = () => {};
    const { url, calls } = await channel(stream.url, () =>
      new Promise((resolve) => (wakeUp = () => resolve({ state: 'awake', browserSessionId: 'browser-1', control: 'agent' }))),
    );
    const client = agent(`${url}?token=good`);
    await soon(client.opened);
    const allowed = JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.cookie' } });
    client.socket.send(allowed);
    client.socket.send(JSON.stringify({ id: 2, method: 'Network.getCookies', sessionId: 'page-1' }));
    client.socket.send(JSON.stringify({ id: 3, method: 'Storage.getCookies' }));
    await until(() => calls.length === 1);
    wakeUp();

    await until(() => stream.received.length === 1 && client.received.length === 2);
    expect(stream.received).toEqual([JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'document.cookie' } })]);
    expect(client.received).toEqual([
      { id: 2, sessionId: 'page-1', error: { code: -32000, message: 'Network.getCookies is not allowed on the Agent Computer' } },
      { id: 3, error: { code: -32000, message: 'Storage.getCookies is not allowed on the Agent Computer' } },
    ]);
    expect(stream.headers[0]?.['x-amz-date']).toBe('signed');
    expect(calls).toEqual([
      ['wake', 'acct-1', 'thread-1'],
      ['automationStream', 'browser-1'],
      ['use', 'acct-1', 'browser-1'],
    ]);

    const next = JSON.stringify({ id: 4, method: 'Page.navigate', params: { url: 'https://site.example/' } });
    client.socket.send(next);
    await until(() => stream.received.length === 2);
    expect(stream.received).toEqual([
      JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'document.cookie' } }),
      JSON.stringify({ id: 3, method: 'Page.navigate', params: { url: 'https://site.example/' } }),
    ]);
  });

  it("passes the browser's answers and events on without the session's cookies", async () => {
    const stream = await automationStream();
    const { url } = await channel(stream.url);
    const client = agent(`${url}?token=good`);
    await until(() => stream.sockets.length === 1);
    const [browser] = stream.sockets;

    client.socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate' }));
    await until(() => stream.received.length === 1);
    browser?.send(JSON.stringify({ id: 2, result: { value: 'ok' } }));
    browser?.send(JSON.stringify({ method: 'Network.requestWillBeSentExtraInfo', params: { headers: { Cookie: 'SiteLogin=s' } } }));
    browser?.send(
      JSON.stringify({ method: 'Network.requestWillBeSent', params: { request: { headers: { Cookie: 'SiteLogin=s', Accept: '*/*' } } } }),
    );
    browser?.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));

    await until(() => client.received.length === 3);
    expect(client.received).toEqual([
      { id: 1, result: { value: 'ok' } },
      { method: 'Network.requestWillBeSent', params: { request: { headers: { Accept: '*/*' } } } },
      { method: 'Page.loadEventFired', params: {} },
    ]);
  });

  it('closes the agent when the browser goes away, and the browser when the agent does', async () => {
    const stream = await automationStream();
    const { url } = await channel(stream.url);
    const first = agent(`${url}?token=good`);
    await until(() => stream.sockets.length === 1);
    stream.sockets[0]?.close();
    expect(await soon(first.closed)).toEqual({ code: 1011, reason: 'Agent Computer browser closed' });

    const second = agent(`${url}?token=good`);
    await until(() => stream.sockets.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    second.socket.close();
    await until(() => stream.closed === 2);
  });

  it('lets go of the browser when the agent left while it was waking', async () => {
    const stream = await automationStream();
    let wakeUp = () => {};
    const { url, calls } = await channel(stream.url, () =>
      new Promise((resolve) => (wakeUp = () => resolve({ state: 'awake', browserSessionId: 'browser-1', control: 'agent' }))),
    );
    const client = agent(`${url}?token=good`);
    await soon(client.opened);
    client.socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate' }));
    client.socket.close();
    await soon(client.closed);
    wakeUp();

    await until(() => stream.closed === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stream.received).toEqual([]);
    expect(calls.map(([operation]) => operation)).not.toContain('control');
  });

  it.each([
    ['a re-link-required account', () => Promise.reject(new HttpError(401, 'Site sign-in is not connected. Sign in to continue.')), 1008, 'Site sign-in is not connected. Sign in to continue.'],
    ['any other refusal', () => Promise.reject(new HttpError(503, 'Credential Service unavailable')), 1011, 'Credential Service unavailable'],
    ['a failure that is not an Error', () => Promise.reject('boom'), 1011, 'boom'],
    ['a browser that stayed asleep', async () => ({ state: 'asleep' as const }), 1011, 'Agent Computer did not wake'],
    ['a long message', () => Promise.reject(new Error('x'.repeat(200))), 1011, 'x'.repeat(123)],
  ])('closes the agent with the reason for %s', async (_name, wake: Wake, code, reason) => {
    const stream = await automationStream();
    const { url } = await channel(stream.url, wake);

    expect(await soon(agent(`${url}?token=good`).closed)).toEqual({ code, reason });
  });

  it('does not relay a command after revocation withdraws browser use before stop completes', async () => {
    const stream = await automationStream();
    let releaseStop = () => {};
    let stopping = false;
    const stop = new Promise<void>((resolve) => { releaseStop = resolve; });
    const computers = computersFor(fakeBrowser(stream.url, { stop: async () => { stopping = true; await stop; } }));
    const { url } = await channel(stream.url, () => computers.wake('acct-1', 'thread-1'), 'good', undefined, () => computers.use('acct-1', 'browser-1'));
    const client = agent(`${url}?token=good`);
    await until(() => stream.sockets.length === 1);
    client.socket.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'https://www.w3.org' } }));
    await until(() => stream.received.length === 1);
    const revoking = computers.revoke('acct-1');
    await until(() => stopping);
    expect(computers.use('acct-1', 'browser-1')).toBe(false);
    client.socket.send(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url: 'https://site.example/' } }));
    await until(() => client.received.length > 0 || stream.received.length > 1);
    releaseStop();
    await revoking;
    expect(stream.received).toHaveLength(1);
    expect(client.received).toEqual([{ id: 2, error: { code: -32000, message: 'Agent Computer browser is no longer available to this account' } }]);
    expect(await soon(client.closed)).toEqual({ code: 1008, reason: 'Agent Computer browser is no longer available to this account' });
    await until(() => stream.closed === 1);
  });

  //: AgentCore refused the sleep's screenshot while the agent's channel held the stream, so no profile was saved.
  describe('while the browser goes to sleep, with its automation stream taking one client', () => {
    const channelTo = (stream: string, computers: ReturnType<typeof computersFor>, opening?: () => Promise<void>) =>
      channel(
        stream,
        () => computers.wake('acct-1', 'thread-1'),
        'good',
        undefined,
        () => true,
        (accountId, sessionId, letGo) => computers.claimStream(accountId, sessionId, letGo),
        opening,
      );

    it("closes the agent's channel, so the sleep saves the browser profile", async () => {
      const stream = await automationStream({ oneClient: true });
      const saved: string[] = [];
      const computers = computersFor(
        fakeBrowser(stream.url, { saveProfile: async (profileId, sessionId) => void saved.push(`${profileId} ${sessionId}`) }),
        0.2,
      );
      const { url } = await channelTo(stream.url, computers);
      const client = agent(`${url}?token=good`);
      await until(() => stream.sockets.length === 1);

      expect(await soon(client.closed)).toEqual({ code: 1011, reason: 'Agent Computer browser closed' });
      await until(() => saved.length === 1);
      expect(saved).toEqual(['profile-1 browser-1']);
    });

    it('keeps a channel the agent reopens off the browser until the sleep is done, then wakes it from the saved profile', async () => {
      const stream = await automationStream({ oneClient: true });
      let releaseSave = () => {};
      const save = new Promise<void>((resolve) => (releaseSave = resolve));
      let saving = false;
      const started: (string | null)[] = [];
      const computers = computersFor(
        fakeBrowser(stream.url, {
          start: async (profileId) => `browser-${started.push(profileId)}`,
          saveProfile: async () => {
            saving = true;
            await save;
          },
        }),
        0.2,
      );
      const { url } = await channelTo(stream.url, computers);
      const first = agent(`${url}?token=good`);
      await soon(first.closed);
      const second = agent(`${url}?token=good`);
      await until(() => saving);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(proxied(stream)).toBe(1);

      releaseSave();
      await until(() => proxied(stream) === 2);
      expect(started).toEqual([null, 'profile-1']);
      expect(await soon(second.opened)).toBe(true);
    });

    it("saves the browser profile after the agent's channel already let go", async () => {
      const stream = await automationStream({ oneClient: true });
      const saved: string[] = [];
      const computers = computersFor(
        fakeBrowser(stream.url, { saveProfile: async (profileId, sessionId) => void saved.push(`${profileId} ${sessionId}`) }),
        0.2,
      );
      const { url } = await channelTo(stream.url, computers);
      const client = agent(`${url}?token=good`);
      await until(() => stream.sockets.length === 1);
      client.socket.close();
      await until(() => stream.closed === 1);

      await until(() => saved.length === 1);
      expect(saved).toEqual(['profile-1 browser-1']);
    });

    it('saves the browser profile after the automation stream refused the agent', async () => {
      const stream = await automationStream({ oneClient: true });
      const refusing = await automationStream({ oneClient: true });
      const holder = new WebSocket(refusing.url);
      await new Promise((resolve) => holder.addEventListener('open', resolve));
      const saved: string[] = [];
      const computers = computersFor(
        fakeBrowser(stream.url, { saveProfile: async (profileId, sessionId) => void saved.push(`${profileId} ${sessionId}`) }),
        0.2,
      );
      const { url } = await channelTo(refusing.url, computers);

      expect(await soon(agent(`${url}?token=good`).closed)).toEqual({ code: 1011, reason: 'Agent Computer browser could not be reached' });
      await until(() => saved.length === 1);
      expect(saved).toEqual(['profile-1 browser-1']);
      holder.close();
    });

    it('refuses the stream to a channel that was still opening it when the sleep began, and wakes the next one from the saved profile', async () => {
      const stream = await automationStream({ oneClient: true });
      let releaseSave = () => {};
      const save = new Promise<void>((resolve) => (releaseSave = resolve));
      let saving = false;
      const started: (string | null)[] = [];
      const computers = computersFor(
        fakeBrowser(stream.url, {
          start: async (profileId) => `browser-${started.push(profileId)}`,
          saveProfile: async () => {
            saving = true;
            await save;
          },
        }),
        0.2,
      );
      let open = () => {};
      const { url } = await channelTo(stream.url, computers, () => new Promise<void>((resolve) => (open = resolve)));
      const client = agent(`${url}?token=good`);
      await until(() => saving);
      open();

      expect(await soon(client.closed)).toEqual({ code: 1011, reason: 'Agent Computer browser closed' });
      expect(proxied(stream)).toBe(0);
      releaseSave();

      expect(await soon(agent(`${url}?token=good`).opened)).toBe(true);
      expect(started).toEqual([null, 'profile-1']);
    });
  });

  it('closes the agent when the browser cannot be reached', async () => {
    const { url } = await channel('ws://127.0.0.1:1/automation');

    expect(await soon(agent(`${url}?token=good`).closed)).toEqual({ code: 1011, reason: 'Agent Computer browser could not be reached' });
  });

  // agent-browser drops a close reason and reports "CDP response channel closed", so the refusal answers each command.
  it('answers every command with the user-has-control refusal while their Take-over holds the browser', async () => {
    const stream = await automationStream();
    let wakeUp = () => {};
    const { url, calls } = await channel(stream.url, () =>
      new Promise((resolve) => (wakeUp = () => resolve({ state: 'awake', browserSessionId: 'browser-1', control: 'user' }))),
    );
    const client = agent(`${url}?token=good`);
    await soon(client.opened);
    client.socket.send(JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }));
    await until(() => calls.length === 1);
    wakeUp();
    await until(() => client.received.length === 1);
    client.socket.send(JSON.stringify({ id: 2, method: 'Page.navigate', sessionId: 'page-1', params: { url: 'https://www.w3.org' } }));
    await until(() => client.received.length === 2);

    const message = "The user has control of the Agent Computer's browser until they hand it back";
    expect(client.received).toEqual([
      { id: 1, error: { code: -32000, message } },
      { id: 2, sessionId: 'page-1', error: { code: -32000, message } },
    ]);
    expect(stream.received).toEqual([]);
  });

  it('refuses in-flight and later commands, without closing, once a Take-over shuts the open browser to the agent', async () => {
    const stream = await automationStream();
    let control: 'user' | 'agent' = 'agent';
    const { url } = await channel(stream.url, undefined, 'good', async () => control);
    const client = agent(`${url}?token=good`);
    await until(() => stream.sockets.length === 1);
    client.socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate' }));
    client.socket.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', sessionId: 'page-1' }));
    await until(() => stream.received.length === 2);
    stream.sockets[0]?.send(JSON.stringify({ id: 2, result: { value: 'ok' } }));
    await until(() => client.received.length === 1);
    control = 'user';
    stream.sockets[0]?.close();
    await until(() => client.received.length === 2);
    client.socket.send(JSON.stringify({ id: 3, method: 'Page.navigate', params: { url: 'https://www.w3.org' } }));
    await until(() => client.received.length === 3);

    const message = "The user has control of the Agent Computer's browser until they hand it back";
    expect(client.received).toEqual([
      { id: 1, result: { value: 'ok' } },
      { id: 2, sessionId: 'page-1', error: { code: -32000, message } },
      { id: 3, error: { code: -32000, message } },
    ]);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('closes the agent with the reason when who has control cannot be read after the browser goes away', async () => {
    const stream = await automationStream();
    const { url } = await channel(stream.url, undefined, 'good', () => Promise.reject(new Error('AgentCore browser session automation stream is TERMINATED')));
    const client = agent(`${url}?token=good`);
    await until(() => stream.sockets.length === 1);
    stream.sockets[0]?.close();

    expect(await soon(client.closed)).toEqual({ code: 1011, reason: 'AgentCore browser session automation stream is TERMINATED' });
  });

  it('closes the agent on a message that is not text', async () => {
    const stream = await automationStream();
    const { url } = await channel(stream.url);
    const client = agent(`${url}?token=good`);
    await soon(client.opened);
    client.socket.send(new Uint8Array([1, 2, 3]));

    expect(await soon(client.closed)).toEqual({ code: 1003, reason: 'CDP messages are text' });
  });
});

it('keeps two real named browser clients working through one automation stream', async () => {
  const browser = await realSingleClientBrowser();
  const computers = computersFor(fakeBrowser(browser.endpoint));
  const { url } = await channel(browser.endpoint, () => computers.wake('acct-1', 'thread-1'), 'good', undefined,
    () => computers.use('acct-1', 'browser-1'),
    (accountId, sessionId, letGo) => computers.claimStream(accountId, sessionId, letGo));
  const first = realBrowserClient(`${url}?token=good`, `cdp-first-${process.pid}`);
  const second = realBrowserClient(`${url}?token=good`, `cdp-second-${process.pid}`);
  let firstClosed = false;
  try {
    await expect(first(['open', `${browser.page}/first`])).resolves.toContain('First page');
    expect(await first(['get', 'text', 'body'])).toContain('first public body');
    await expect(second(['open', `${browser.page}/second`])).resolves.toContain('Second page');
    expect(await second(['get', 'text', 'body'])).toContain('second public body');
    expect(await first(['get', 'text', 'body'])).toContain('second public body');
    expect(browser.counts()).toEqual({ admissions: 1, refusals: 0 });
    await first(['close']);
    firstClosed = true;
    expect(await second(['get', 'text', 'body'])).toContain('second public body');
  } catch (error) {
    const counts = browser.counts();
    throw new Error(`Real browser failed with ${counts.admissions} admissions and ${counts.refusals} refusals`, { cause: error });
  } finally {
    await Promise.allSettled([...(firstClosed ? [] : [first(['close'])]), second(['close'])]);
    await browser.close();
  }
}, 30_000);


it('refuses both retained agent channels during Take-over without admitting another upstream', async () => {
  const stream = await automationStream({ oneClient: true });
  let control: 'agent' | 'user' = 'agent';
  const browser = fakeBrowser(stream.url, { control: async () => control });
  const computers = computersFor(browser);
  const { url } = await channel(stream.url, () => computers.wake('acct-1', 'thread-1'), 'good', () => browser.control('browser-1'),
    () => computers.use('acct-1', 'browser-1'), (accountId, sessionId, letGo) => computers.claimStream(accountId, sessionId, letGo));
  const first = agent(`${url}?token=good`);
  const second = agent(`${url}?token=good`);
  await Promise.all([soon(first.opened), soon(second.opened)]);
  first.socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  second.socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  await until(() => stream.received.length === 2);
  control = 'user';
  stream.sockets[0]?.close();
  await until(() => first.received.length === 1 && second.received.length === 1);
  first.socket.send(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url: 'https://example.org' } }));
  second.socket.send(JSON.stringify({ id: 2, method: 'Page.navigate', params: { url: 'https://example.org' } }));
  await until(() => first.received.length === 2 && second.received.length === 2);
  const refusal = "The user has control of the Agent Computer's browser until they hand it back";
  for (const client of [first, second]) expect(client.received).toEqual([
    { id: 1, error: { code: -32000, message: refusal } },
    { id: 2, error: { code: -32000, message: refusal } },
  ]);
  expect(proxied(stream)).toBe(1);
  expect(stream.received).toHaveLength(2);
});

it('drains both retained agent channels before retirement opens its screenshot stream', async () => {
  const stream = await automationStream({ oneClient: true });
  const computers = computersFor(fakeBrowser(stream.url));
  const { url } = await channel(stream.url, () => computers.wake('acct-1', 'thread-1'), 'good', undefined,
    () => computers.use('acct-1', 'browser-1'), (accountId, sessionId, letGo) => computers.claimStream(accountId, sessionId, letGo));
  const first = agent(`${url}?token=good`);
  const second = agent(`${url}?token=good`);
  await Promise.all([soon(first.opened), soon(second.opened)]);
  first.socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  second.socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  await until(() => stream.received.length === 2);
  await computers.sleepAll().slept;
  expect(await soon(first.closed)).toEqual({ code: 1011, reason: 'Agent Computer browser closed' });
  expect(await soon(second.closed)).toEqual({ code: 1011, reason: 'Agent Computer browser closed' });
  expect(proxied(stream)).toBe(1);
  expect(stream.headers).toHaveLength(2);
  expect(computers.use('acct-1', 'browser-1')).toBe(false);
});


it('records the real refused setup and downstream close in order without exposing connection secrets', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  cleanups.push(async () => info.mockRestore());
  const canary = 'secret-connection-canary';
  const http = createServer((_request, response) => { response.writeHead(429); response.end(canary); });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => http.close(() => resolve())));
  const { url } = await channel(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/stream?token=${canary}`);
  const client = agent(`${url}?token=good`);
  expect(await soon(client.closed)).toEqual({ code: 1011, reason: 'Agent Computer browser could not be reached' });
  const captured = () => info.mock.calls.map(([line]) => JSON.parse(String(line)) as { operation: string; step: string; httpStatus?: number; code?: number; stage?: string });
  const operation = captured().find((record) => record.step === 'downstream.open')?.operation;
  await until(() => captured().some((record) => record.operation === operation && record.step === 'downstream.close'));
  const records = captured().filter((record) => record.operation === operation);
  expect(records.filter((record) => ['wake.result', 'claim.result', 'upstream.admission', 'downstream.setup-error', 'downstream.close'].includes(record.step)).map((record) => [record.step, record.httpStatus ?? record.code ?? record.stage ?? null])).toEqual([
    ['wake.result', null], ['claim.result', null], ['upstream.admission', 429],
    ['downstream.setup-error', 'connect'], ['downstream.close', 1011],
  ]);
  for (const sensitive of [canary, 'token=good', 'acct-1', 'thread-1', 'browser-1', 'x-amz-date']) expect(JSON.stringify(records)).not.toContain(sensitive);
});


it('preserves the sanitized reason when the actual downstream closes first', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  cleanups.push(async () => info.mockRestore());
  const stream = await automationStream();
  const { url } = await channel(stream.url);
  const client = agent(`${url}?token=good`);
  await soon(client.opened);
  client.socket.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  await until(() => stream.received.length === 1);
  const canary = 'secret-downstream-close-reason';
  client.socket.close(1000, canary);
  await soon(client.closed);
  const captured = () => info.mock.calls.map(([line]) => JSON.parse(String(line)) as { operation: string; step: string; code?: number; reason?: string });
  const operation = captured().find((record) => record.step === 'downstream.open')?.operation;
  await until(() => captured().some((record) => record.operation === operation && record.step === 'downstream.close'));
  const closed = captured().find((record) => record.operation === operation && record.step === 'downstream.close');
  expect(closed).toMatchObject({ code: 1000, reason: '<REDACTED>' });
  expect(JSON.stringify(captured())).not.toContain(canary);
});
