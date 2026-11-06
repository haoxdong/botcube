import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { relayTurn } from './turn-stream.js';
import type { Upstream } from './upstream.js';

const encoder = new TextEncoder();
const frame = (event: Record<string, unknown>) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
const RUN = [{ type: 'RUN_STARTED', threadId: 's', runId: 'r' }, { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Hey.' }, { type: 'TEXT_MESSAGE_END', messageId: 'm' },
  { type: 'RUN_FINISHED', threadId: 's', runId: 'r' }];

function upstreamOf({ failAfter }: { failAfter?: number } = {}): Upstream {
  return {
    label: 'Test upstream',
    invoke: async () => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === failAfter) { controller.error(new Error('socket hang up')); return; }
          const next = RUN[sent++];
          if (next === undefined) controller.close();
          else controller.enqueue(frame(next));
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    },
  };
}

let server: ServerType | undefined;
afterEach(() => new Promise<void>((resolve) => { if (server === undefined) resolve(); else server.close(() => resolve()); server = undefined; }));

/** With `relayOnceClientGone`, the route relays only after its client left, as when a person leaves during warmup or dispatch. */
async function chatServer(upstream: Upstream, { relayOnceClientGone = false } = {}) {
  const ended: (string | undefined)[] = [];
  let resolveEnded!: () => void;
  const endedOnce = new Promise<void>((resolve) => { resolveEnded = resolve; });
  let routed!: () => void;
  const entered = new Promise<void>((resolve) => { routed = resolve; });
  const app = new Hono();
  app.post('/', async (c) => {
    const client = c.req.raw.signal;
    routed();
    if (relayOnceClientGone) await new Promise((resolve) => { client.addEventListener('abort', resolve, { once: true }); });
    return relayTurn(upstream, {
      client, body: '{}', sessionId: 'session-1', accept: 'text/event-stream', credentials: [],
      saveAgentDocumentEdit: async () => undefined, finished: () => undefined, failed: () => undefined,
      ended: async (failure) => { ended.push(failure?.code); resolveEnded(); },
    });
  });
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => resolve(info.port));
  });
  return { port, ended, endedOnce, entered };
}

function post(port: number, onFirstByte?: (request: ClientRequest) => void) {
  const request = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/json' } });
  const text = new Promise<string>((resolve) => {
    request.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; onFirstByte?.(request); });
      response.on('end', () => resolve(body));
      response.on('error', () => resolve(body));
    });
    request.on('error', () => resolve(''));
  });
  request.end('{}');
  return { request, text };
}

describe('a relayed Turn ends once on every exit path', () => {
  it('when the client reads the whole Turn', async () => {
    const chat = await chatServer(upstreamOf());
    expect(await post(chat.port).text).toContain('RUN_FINISHED');
    await chat.endedOnce;
    expect(chat.ended).toEqual([undefined]);
  });

  it('when the client disconnects mid-stream', async () => {
    const chat = await chatServer(upstreamOf());
    post(chat.port, (request) => request.destroy());
    await chat.endedOnce;
    expect(chat.ended).toEqual([undefined]);
  });

  it('when the client left before the response began, which the Node adapter neither reads nor cancels', async () => {
    const chat = await chatServer(upstreamOf(), { relayOnceClientGone: true });
    const { request } = post(chat.port);
    await chat.entered;
    request.destroy();
    await chat.endedOnce;
    expect(chat.ended).toEqual([undefined]);
  });

  it('with the stream failure, when the upstream fails mid-Turn', async () => {
    const chat = await chatServer(upstreamOf({ failAfter: 2 }));
    await post(chat.port).text;
    await chat.endedOnce;
    expect(chat.ended).toEqual(['AGENTCORE_UPSTREAM_STREAM_ERROR']);
  });
});
