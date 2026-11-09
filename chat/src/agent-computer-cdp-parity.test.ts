import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType, type WebSocketServerLike } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as UpstreamSocket } from 'ws';
import { AgentCdp } from '../test/agent-cdp.js';
import { agentComputerCdp } from './agent-computer-cdp.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function automationStream({ oneClient = false, page = false } = {}) {
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
    rootMethods: [] as string[],
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
        stream.rootMethods.push(command.method);
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
      if (page) {
        const result = command.method === 'Target.getTargets'
          ? { targetInfos: [{ targetId: 'page-1', type: 'page', url: 'about:blank' }] }
          : command.method === 'Target.attachToTarget' ? { sessionId: `page-session-${command.id}` } : {};
        send(JSON.stringify({ id: command.id, sessionId: command.sessionId, result }));
      }
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
  use: () => boolean | Promise<boolean> = () => true,
  claimStream: (accountId: string, sessionId: string, letGo: () => Promise<void>) => (() => void) | null | Promise<(() => void) | null> = () => () => {},
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
async function attachedPage(client: AgentCdp): Promise<string> {
  const targets = await client.send('Target.getTargets');
  const [page] = (targets.result?.targetInfos ?? []) as { targetId: string }[];
  const attached = await client.send('Target.attachToTarget', { targetId: page?.targetId, flatten: true });
  return String(attached.result?.sessionId);
}

describe("the agent's CDP channel to its Agent Computer", () => {
  it('never lets the agent read cookies, storage, or network bodies, nor slip past the filter', async () => {
    const stream = await automationStream({ page: true });
    const { url } = await channel(stream.url);
    const client = await AgentCdp.connect(`${url}?token=good`);
    const page = await attachedPage(client);

    const denied: [string, object][] = [
      ['Network.getAllCookies', {}],
      ['Network.getCookies', {}],
      ['Storage.getCookies', {}],
      ['DOMStorage.getDOMStorageItems', {}],
      ['Network.getResponseBody', { requestId: 'r1' }],
      ['Fetch.enable', {}],
      ['Tracing.start', {}],
      ['Target.sendMessageToTarget', { message: '{"id":1,"method":"Network.getAllCookies"}', targetId: 'page-1' }],
      ['Target.exposeDevToolsProtocol', { targetId: 'page-1' }],
      ['Target.attachToTarget', { targetId: 'page-1', flatten: false }],
      ['Page.navigate', { url: 'chrome://settings/cookies' }],
    ];
    for (const [method, params] of denied) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time, as a CDP client sends them
      const answer = await client.send(method, params, page);
      expect(answer.error?.message, method).toBe(`${method} is not allowed on the Agent Computer`);
    }
    client.close();

    expect([...stream.rootMethods, ...stream.received.map((entry) => JSON.parse(entry).method)]).toEqual(['Target.attachToBrowserTarget', 'Target.getTargets', 'Target.attachToTarget']);
  });

  it('refuses a connection without a token the Chat Service issued', async () => {
    const stream = await automationStream();
    const { url } = await channel(stream.url);
    await expect(AgentCdp.connect(`${url}?token=forged`)).rejects.toThrow(
      'refused'
    );
  });
  it('keeps retained agent clients attached independently through the built Chat Service', async () => {
    const stream = await automationStream({ oneClient: true, page: true });
    const { url: channelUrl } = await channel(stream.url);
    const url = `${channelUrl}?token=good`;
    const [first, second] = await Promise.all([AgentCdp.connect(url), AgentCdp.connect(url)]);
    try {
      const [firstPage, secondPage] = await Promise.all([attachedPage(first), attachedPage(second)]);
      expect(firstPage).not.toBe(secondPage);
      const denied = await second.send('Target.detachFromTarget', { sessionId: firstPage }, secondPage);
      expect(denied.error?.message).toBe('CDP session belongs to another browser client');
      first.close();
      await first.closed;
      const targets = await second.send('Target.getTargets');
      expect(targets.result?.targetInfos).toEqual([{ targetId: 'page-1', type: 'page', url: 'about:blank' }]);
    } finally {
      first.close();
      second.close();
    }
  });


});
