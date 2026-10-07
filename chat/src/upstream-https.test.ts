import { readFileSync } from 'node:fs';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpsHarnessUpstream } from './upstream.js';
import { defined } from '../test/defined.js';

const dispatchers = vi.hoisted(() => ({ agents: [] as import('undici').Agent[], trustFixtureCertificate: true }));
vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>();
  const { readFileSync: read } = await import('node:fs');
  const ca = read(new URL('../test/fixtures/https/localhost-cert.pem', import.meta.url));
  return {
    ...original,
    Agent: class extends original.Agent {
      constructor(options: import('undici').Agent.Options) {
        super(dispatchers.trustFixtureCertificate ? { ...options, connect: { ...options.connect, ca } } : options);
        dispatchers.agents.push(this);
      }
    },
  };
});

interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const sockets = new Set<Socket>();
const servers: Server[] = [];
const key = readFileSync(new URL('../test/fixtures/https/localhost-key.pem', import.meta.url));
const cert = readFileSync(new URL('../test/fixtures/https/localhost-cert.pem', import.meta.url));

beforeEach(() => {
  dispatchers.trustFixtureCertificate = true;
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
});
afterEach(async () => {
  await Promise.all(dispatchers.agents.splice(0).map((agent) => agent.destroy()));
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  vi.unstubAllEnvs();
});

async function recordingServer(answer: (response: ServerResponse) => void) {
  const received: Received[] = [];
  let requestArrived: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => { requestArrived = resolve; });
  const server = createServer({ key, cert }, (request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      received.push({ method: defined(request.method, 'a method'), path: defined(request.url, 'a path'), headers: request.headers, body });
      answer(response);
      requestArrived?.();
    });
  });
  servers.push(server);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `https://127.0.0.1:${port}/custom/turn?version=2&tag=a&tag=b`, received, arrived };
}

describe('HTTPS Harness transport', () => {
  it('rejects an HTTPS Harness whose certificate is not trusted', async () => {
    dispatchers.trustFixtureCertificate = false;
    const { url } = await recordingServer((response) => response.end('untrusted'));
    await expect(httpsHarnessUpstream({ url, sigv4: false, region: 'us-east-1' }).invoke('{}', 'session-1')).rejects.toMatchObject({
      cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
    });
  });

  it.each([true, false])('streams a Turn over verified TLS with SigV4 %s', async (sigv4) => {
    let finishStream: (() => void) | undefined;
    const { url, received } = await recordingServer((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"RUN_STARTED"}\n\n');
      finishStream = () => response.end('data: {"type":"RUN_FINISHED"}\n\n');
    });
    const response = await httpsHarnessUpstream({ url, sigv4, region: 'eu-west-1' }).invoke('{"prompt":"hi"}', 'session-1');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = defined(response.body, 'a streamed response').getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: {"type":"RUN_STARTED"}\n\n');
    expect(first.done).toBe(false);
    defined(finishStream, 'a pending final event')();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('data: {"type":"RUN_FINISHED"}\n\n');
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(received).toEqual([{
      method: 'POST',
      path: '/custom/turn?version=2&tag=a&tag=b',
      headers: expect.objectContaining({
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-amzn-bedrock-agentcore-runtime-session-id': 'session-1',
      }),
      body: '{"prompt":"hi"}',
    }]);
    const headers = defined(received[0], 'a received invocation').headers;
    if (sigv4) {
      const timestamp = String(headers['x-amz-date']);
      const signingDate = new Date(timestamp.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
      const expected = await new SignatureV4({
        service: 'bedrock-agentcore', region: 'eu-west-1', sha256: Sha256,
        credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      }).sign({
        method: 'POST', protocol: 'https:', hostname: new URL(url).hostname,
        path: '/custom/turn', query: { version: '2', tag: ['a', 'b'] },
        headers: {
          host: new URL(url).host, accept: 'text/event-stream', 'content-type': 'application/json',
          'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': 'session-1',
        },
        body: '{"prompt":"hi"}',
      }, { signingDate });
      expect(headers.authorization).toBe(expected.headers.authorization);
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/bedrock-agentcore\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date;x-amzn-bedrock-agentcore-runtime-session-id, Signature=[0-9a-f]{64}$/);
    } else {
      expect(headers.authorization).toBeUndefined();
    }
  });

  it.each([true, false])('preserves a non-success response with SigV4 %s', async (sigv4) => {
    const { url } = await recordingServer((response) => response.writeHead(503).end('Harness unavailable'));
    const response = await httpsHarnessUpstream({ url, sigv4, region: 'us-east-1' }).invoke('{}', 'session-1');
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Harness unavailable');
  });

  it.each([true, false])('aborts an in-flight HTTPS invocation with SigV4 %s', async (sigv4) => {
    const { url, arrived, received } = await recordingServer(() => {});
    const controller = new AbortController();
    const invocation = httpsHarnessUpstream({ url, sigv4, region: 'us-east-1' }).invoke('{}', 'session-1', { signal: controller.signal });
    const rejected = expect(invocation).rejects.toThrow('client went away');
    await arrived;
    expect(defined(received[0], 'an in-flight request').body).toBe('{}');
    controller.abort(new Error('client went away'));
    await rejected;
  });
});
