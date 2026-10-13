import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { sharedCdpTransport } from './agent-computer-cdp-transport.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await cleanups.splice(0).reverse().reduce((previous, cleanup) => previous.then(cleanup), Promise.resolve());
});

type Message = { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: unknown };
async function browserStream() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const sockets: WebSocket[] = [];
  const commands: { socket: WebSocket; message: Message }[] = [];
  let root = 0;
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as Message;
      if (message.method === 'Target.attachToBrowserTarget') {
        socket.send(JSON.stringify({ id: message.id, result: { sessionId: `root-${++root}` } }));
      } else if (message.method === 'Target.detachFromTarget') {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else commands.push({ socket, message });
    });
  });
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, sockets, commands };
}
async function until(condition: () => boolean) {
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { clearInterval(poll); reject(new Error('CDP control did not arrive')); }, 2000);
    const poll = setInterval(() => {
      if (!condition()) return;
      clearTimeout(deadline); clearInterval(poll); resolve();
    }, 5);
  });
}
const receiver = () => {
  const messages: Message[] = [];
  let closed = 0;
  return { messages, get closed() { return closed; }, message: (message: Message) => messages.push(message), closedCallback: () => { closed++; } };
};

it('routes overlapping request IDs and attached-session events only to their real client', async () => {
  const stream = await browserStream();
  let claims = 0;
  const transport = sharedCdpTransport({ open: async () => ({ endpoint: stream.endpoint, headers: {} }), claim: () => { claims++; return () => {}; } });
  const a = receiver(); const b = receiver();
  const [first, second] = await Promise.all([
    transport.connect('account-a', 'browser-a', { message: a.message, closed: a.closedCallback }),
    transport.connect('account-a', 'browser-a', { message: b.message, closed: b.closedCallback }),
  ]);
  cleanups.push(async () => { await Promise.all([first.close(), second.close()]); });
  first.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: '"first"' } }));
  second.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: '"second"' } }));
  await until(() => stream.commands.length === 2);
  const [one, two] = stream.commands;
  expect(one?.message.id).not.toBe(two?.message.id);
  expect(one?.message.sessionId).not.toBe(two?.message.sessionId);
  for (const command of stream.commands) command.socket.send(JSON.stringify({ id: command.message.id, sessionId: command.message.sessionId, result: { value: command.message.params?.expression === '"first"' ? 'first' : 'second' } }));
  await until(() => a.messages.length === 1 && b.messages.length === 1);
  expect(a.messages).toEqual([{ id: 7, result: { value: 'first' } }]);
  expect(b.messages).toEqual([{ id: 7, result: { value: 'second' } }]);
  one?.socket.send(JSON.stringify({ method: 'Target.attachedToTarget', sessionId: one.message.sessionId, params: { sessionId: 'child-a', targetInfo: { type: 'page' } } }));
  one?.socket.send(JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'child-a', params: {} }));
  await until(() => a.messages.length === 3);
  expect(a.messages.slice(1)).toEqual([
    { method: 'Target.attachedToTarget', params: { sessionId: 'child-a', targetInfo: { type: 'page' } } },
    { method: 'Page.loadEventFired', sessionId: 'child-a', params: {} },
  ]);
  expect(b.messages).toHaveLength(1);
  second.send(JSON.stringify({ id: 9, method: 'Runtime.evaluate', sessionId: 'child-a', params: { expression: '"intruder"' } }));
  await until(() => b.messages.length === 2);
  expect(b.messages[1]).toEqual({ id: 9, sessionId: 'child-a', error: { code: -32000, message: 'CDP session belongs to another browser client' } });
  second.send(JSON.stringify({ id: 10, method: 'Target.detachFromTarget', sessionId: two?.message.sessionId, params: { sessionId: 'child-a' } }));
  await until(() => b.messages.length === 3);
  expect(b.messages[2]).toEqual({ id: 10, sessionId: two?.message.sessionId, error: { code: -32000, message: 'CDP session belongs to another browser client' } });
  expect(stream.commands).toHaveLength(2);
  expect(stream.sockets).toHaveLength(1);
  expect(claims).toBe(1);
  await first.close();
  expect(stream.sockets[0]?.readyState).toBe(1);
  second.send(JSON.stringify({ id: 8, method: 'Browser.getVersion' }));
  await until(() => stream.commands.length === 3);
});

it('does not deliver a closed client late response to a survivor reusing its downstream ID', async () => {
  const stream = await browserStream();
  const transport = sharedCdpTransport({ open: async () => ({ endpoint: stream.endpoint, headers: {} }), claim: () => () => {} });
  const a = receiver(); const b = receiver();
  const first = await transport.connect('account-a', 'browser-a', { message: a.message, closed: a.closedCallback });
  const second = await transport.connect('account-a', 'browser-a', { message: b.message, closed: b.closedCallback });
  cleanups.push(async () => { await Promise.all([first.close(), second.close()]); });
  first.send(JSON.stringify({ id: 7, method: 'Browser.getVersion' }));
  await until(() => stream.commands.length === 1);
  const orphan = stream.commands[0];
  await first.close();
  second.send(JSON.stringify({ id: 7, method: 'Browser.getVersion' }));
  await until(() => stream.commands.length === 2);
  const survivor = stream.commands[1];
  orphan?.socket.send(JSON.stringify({ id: orphan.message.id, sessionId: orphan.message.sessionId, result: { product: 'orphan' } }));
  survivor?.socket.send(JSON.stringify({ id: survivor.message.id, sessionId: survivor.message.sessionId, result: { product: 'survivor' } }));
  await until(() => b.messages.length === 1);
  expect(b.messages).toEqual([{ id: 7, result: { product: 'survivor' } }]);
  expect(a.messages).toEqual([]);
  expect(orphan?.message.id).not.toBe(survivor?.message.id);
});

it('keeps different accounts and owned BotSession browsers on independent upstreams', async () => {
  const stream = await browserStream();
  const claimed: string[] = [];
  const transport = sharedCdpTransport({ open: async () => ({ endpoint: stream.endpoint, headers: {} }), claim: (accountId, browserId) => { claimed.push(`${accountId}/${browserId}`); return () => {}; } });
  const channels = await Promise.all([
    transport.connect('account-a', 'browser-a', { message: () => {}, closed: () => {} }),
    transport.connect('account-b', 'browser-b', { message: () => {}, closed: () => {} }),
    transport.connect('account-a', 'browser-c', { message: () => {}, closed: () => {} }),
  ]);
  cleanups.push(async () => { await Promise.all(channels.map((channel) => channel.close())); });
  expect(stream.sockets).toHaveLength(3);
  expect(claimed.sort()).toEqual(['account-a/browser-a', 'account-a/browser-c', 'account-b/browser-b']);
});

it('releases the single lifecycle claim only after every downstream channel loses the physical stream', async () => {
  const stream = await browserStream();
  let letGo: () => Promise<void> = async () => { throw new Error('No stream was claimed'); };
  let releases = 0;
  const transport = sharedCdpTransport({ open: async () => ({ endpoint: stream.endpoint, headers: {} }), claim: (_accountId, _browserId, close) => { letGo = close; return () => { releases++; }; } });
  const a = receiver(); const b = receiver();
  const [first, second] = await Promise.all([
    transport.connect('account-a', 'browser-a', { message: a.message, closed: a.closedCallback }),
    transport.connect('account-a', 'browser-a', { message: b.message, closed: b.closedCallback }),
  ]);
  cleanups.push(async () => { await Promise.all([first.close(), second.close()]); });
  await letGo();
  await until(() => stream.sockets[0]?.readyState === 3);
  expect(a.closed).toBe(1);
  expect(b.closed).toBe(1);
  expect(releases).toBe(1);
});

it('propagates a refused upstream upgrade once without reopening or retrying admission', async () => {
  let attempts = 0;
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: (_info, admit) => { attempts++; admit(false, 429, 'Concurrent connections are not supported'); } });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  let claims = 0; let releases = 0;
  const transport = sharedCdpTransport({ open: async () => ({ endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, headers: {} }), claim: () => { claims++; return () => { releases++; }; } });
  await expect(transport.connect('account-a', 'browser-a', { message: () => {}, closed: () => {} })).rejects.toThrow('Agent Computer browser could not be reached');
  expect(attempts).toBe(1);
  expect(claims).toBe(1);
  expect(releases).toBe(1);
});
