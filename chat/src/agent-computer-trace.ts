import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
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

export function traceClose(event: { code: number; reason: string; wasClean: boolean }): Fields {
  const known = ['', 'Agent Computer browser closed', 'CDP messages are text',
    'Agent Computer browser is no longer available to this account',
    'Too many connections. Concurrent connections to the same session are not supported.'];
  return { code: event.code, wasClean: event.wasClean,
    reason: known.includes(event.reason) ? event.reason : '<REDACTED>',
    reasonDigest: event.reason ? traceSelector(event.reason) : null };
}

export function traceSocket(trace: ComputerTrace, open: () => WebSocket): WebSocket {
  trace('upstream.construct', { runtime: process.version });
  const socket = open();
  const tracePeer = ({ socket: { remoteAddress, remotePort, remoteFamily } }: IncomingMessage) =>
    trace('upstream.connected', { address: remoteAddress ?? null, port: remotePort ?? null, family: remoteFamily ?? null });
  socket.once('upgrade', tracePeer);
  socket.once('open', () => trace('upstream.admission', { httpStatus: 101 }));
  socket.once('unexpected-response', (_request, response) => {
    tracePeer(response);
    trace('upstream.admission', { httpStatus: response.statusCode ?? null });
    socket.terminate();
  });
  return socket;
}
