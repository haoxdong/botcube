import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import type { CdpMessage } from './index.js';

type Fields = Record<string, string | number | boolean | null>;
export type ComputerTrace = (event: string, fields?: Fields) => void;
export const traceReference = () => randomBytes(8).toString('hex');
const instance = traceReference();
let sequence = 0;
export const traceSelector = (value: string) => createHash('sha256').update(value).digest('hex');

export function computerTrace(threadId: string): ComputerTrace {
  const scope = traceSelector(threadId);
  const operation = traceReference();
  return (event, fields = {}) => console.info(JSON.stringify({
    event: 'agent_computer_cdp', debug: 'DEBUG-3748-CDP', scope, instance, operation, sequence: ++sequence,
    utc: new Date().toISOString(), monotonicMs: performance.now(), step: event, ...fields,
  }));
}

export function traceFailure(error: unknown): Fields {
  const name = error instanceof Error ? error.name : '';
  const errorType = ['Error', 'TypeError', 'HttpError', 'AggregateError', 'DOMException'].includes(name) ? name : 'unknown';
  const message = error instanceof Error ? error.message : '';
  const http = /\bHTTP (\d{3})\b/.exec(message);
  const status = error instanceof Error && 'status' in error ? error.status : undefined;
  return { errorType, httpStatus: typeof status === 'number' && status >= 100 && status <= 599 ? status : http ? Number(http[1]) : null };
}

export function traceAttachment(message: CdpMessage): Fields {
  const code = (message.error as { code?: unknown } | undefined)?.code;
  return { errorCode: typeof code === 'number' && Number.isFinite(code) ? code : null,
    attached: typeof (message.result as { sessionId?: unknown } | undefined)?.sessionId === 'string' };
}

export function traceClose(event: CloseEvent): Fields {
  const known = ['', 'Agent Computer browser closed', 'CDP messages are text',
    'Agent Computer browser is no longer available to this account',
    'Too many connections. Concurrent connections to the same session are not supported.'];
  return { code: event.code, wasClean: event.wasClean,
    reason: known.includes(event.reason) ? event.reason : '<REDACTED>',
    reasonDigest: event.reason ? traceSelector(event.reason) : null };
}

const connection = new AsyncLocalStorage<{ trace: ComputerTrace; admitting: boolean }>();
const requests = new WeakMap<object, ComputerTrace>();
channel('undici:client:connected').subscribe((message) => {
  const current = connection.getStore();
  if (!current?.admitting) return;
  const { socket } = message as { socket: { remoteAddress?: string; remotePort?: number; remoteFamily?: string } };
  current.trace('upstream.connected', { address: socket.remoteAddress ?? null, port: socket.remotePort ?? null, family: socket.remoteFamily ?? null });
});
channel('undici:request:create').subscribe((message) => {
  const current = connection.getStore();
  if (current?.admitting) requests.set((message as { request: object }).request, current.trace);
});
channel('undici:request:headers').subscribe((message) => {
  const { request, response } = message as { request: object; response: { statusCode: number } };
  if (response.statusCode !== 101) requests.get(request)?.('upstream.admission', { httpStatus: response.statusCode });
});
channel('undici:request:error').subscribe((message) => {
  const { request, error } = message as { request: object; error: unknown };
  requests.get(request)?.('upstream.request-error', traceFailure(error));
});

export function traceSocket(trace: ComputerTrace, open: () => WebSocket): WebSocket {
  trace('upstream.construct', { runtime: process.version });
  const current = { trace, admitting: true };
  const socket = connection.run(current, open);
  socket.addEventListener('open', () => {
    current.admitting = false;
    trace('upstream.admission', { httpStatus: 101 });
  });
  socket.addEventListener('error', () => { current.admitting = false; });
  socket.addEventListener('close', () => { current.admitting = false; });
  return socket;
}
