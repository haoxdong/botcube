import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { sharedCdpTransport } from './agent-computer-cdp-transport.js';
import { traceSocket, traceClose, type ComputerTrace } from './agent-computer-trace.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await cleanups.splice(0).reverse().reduce((previous, cleanup) => previous.then(cleanup), Promise.resolve()); });

it.each([101, 200])('records only the real %i handshake when its close callback looks up control', async (status) => {
  const canary = 'secret-followup-control-canary';
  const server = createServer((_request, response) => { response.end(canary); });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (status === 200) {
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => client.on('message', () => client.close(1000)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const records: { step: string; fields: unknown }[] = [];
  const socket = traceSocket((step, fields) => records.push({ step, fields }), () => new WebSocket(endpoint.replace('http:', 'ws:')));
  socket.addEventListener('open', () => socket.send('ownership control'));
  const response = await new Promise<Response>((resolve, reject) => socket.addEventListener('close', () => {
    fetch(`${endpoint}/control?token=${canary}`).then(resolve, reject);
  }));
  expect(await response.text()).toBe(canary);
  expect(records.filter((record) => record.step === 'upstream.admission')).toEqual([{ step: 'upstream.admission', fields: { httpStatus: status } }]);
  expect(records.filter((record) => record.step === 'upstream.connected')).toHaveLength(1);
  expect(JSON.stringify(records)).not.toContain(canary);
});

it('correlates concurrent real admission refusals without recording credentials or unrelated requests', async () => {
  const canary = 'secret-canary-not-for-the-audit';
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/ordinary')) { response.end('unrelated'); return; }
    const first = request.url?.startsWith('/first');
    setTimeout(() => { response.writeHead(first ? 403 : 429, { 'x-canary': canary }); response.end(canary); }, first ? 30 : 1);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const records: { owner: string; step: string; fields: unknown }[] = [];
  const observe = (owner: string): ComputerTrace => (step, fields) => records.push({ owner, step, fields });
  const close = (owner: string, path: string) => new Promise<number>((resolve) => {
    const socket = traceSocket(observe(owner), () => new WebSocket(`ws://${base}/${path}?token=${canary}`, { headers: { authorization: canary } } as unknown as string[]));
    socket.addEventListener('close', (event) => resolve(event.code));
  });
  const [first, second, unrelated] = await Promise.all([close('first', 'first'), close('second', 'second'), fetch(`http://${base}/ordinary`)]);
  expect([first, second, await unrelated.text()]).toEqual([1006, 1006, 'unrelated']);
  expect(records.filter((record) => record.step === 'upstream.admission')).toEqual([
    { owner: 'second', step: 'upstream.admission', fields: { httpStatus: 429 } },
    { owner: 'first', step: 'upstream.admission', fields: { httpStatus: 403 } },
  ]);
  expect(JSON.stringify(records)).not.toContain(canary);
  expect(records.every((record) => ['first', 'second'].includes(record.owner))).toBe(true);
});

it('records actual healthy admission and safely classifies an upstream close reason', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const records: { step: string; fields: unknown }[] = [];
  const trace: ComputerTrace = (step, fields) => records.push({ step, fields });
  const canary = 'secret-close-reason-not-for-the-audit';
  server.on('connection', (socket) => socket.close(1008, canary));
  const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ended = new Promise<CloseEvent>((resolve) => traceSocket(trace, () => new WebSocket(endpoint)).addEventListener('close', resolve));
  const event = await ended;
  expect(records.filter((record) => record.step === 'upstream.admission')).toEqual([{ step: 'upstream.admission', fields: { httpStatus: 101 } }]);
  expect(traceClose(event)).toMatchObject({ code: 1008, wasClean: true, reason: '<REDACTED>' });
  expect(JSON.stringify(traceClose(event))).not.toContain(canary);
});


it('redacts a malformed native attachment error while retaining the real attach failure', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.on('listening', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  const canary = 'secret-malformed-error-code';
  server.on('connection', (socket) => socket.on('message', (data: Buffer) => {
    const { id } = JSON.parse(data.toString()) as { id: number };
    socket.send(JSON.stringify({ id, error: { code: canary, message: canary } }));
  }));
  const records: { step: string; fields: unknown }[] = [];
  const trace: ComputerTrace = (step, fields) => records.push({ step, fields });
  const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport = sharedCdpTransport({ open: async () => ({ endpoint, headers: {} }), claim: () => () => {} });
  await expect(transport.connect('account-canary', 'browser-canary', { message: () => {}, closed: () => {} }, trace)).rejects.toThrow('Agent Computer browser did not attach a CDP session');
  expect(records.find((record) => record.step === 'root.attach-result')?.fields).toMatchObject({ errorCode: null, attached: false });
  expect(JSON.stringify(records)).not.toContain(canary);
});
