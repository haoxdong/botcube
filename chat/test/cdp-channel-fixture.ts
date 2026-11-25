import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType, type WebSocketServerLike } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as UpstreamSocket } from 'ws';
import { agentComputerCdp } from '../src/agent-computer-cdp.js';

export type Wake = () => Promise<{ state: 'awake'; browserSessionId: string; control: 'user' | 'agent' } | { state: 'asleep' }>;

export function cdpChannelFixture() {
  const cleanups: (() => Promise<void>)[] = [];
  const addCleanup = (cleanup: () => Promise<void>) => void cleanups.push(cleanup);
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

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
    addCleanup(() => {
      for (const socket of server.clients) socket.terminate();
      return new Promise((resolve) => server.close(() => resolve()));
    });
    return stream;
  }

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
          overrideGlobalObjects: false,
          websocket: { server: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike },
        },
        () => resolve(started),
      );
    });
    addCleanup(() => {
      if ('closeAllConnections' in server) server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    });
    return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/cdp`, calls };
  }

  return { automationStream, channel, addCleanup };
}
