import { readFileSync } from 'node:fs';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpsHarnessUpstream } from './upstream.js';
import { defined } from '../test/defined.js';
import { startInProcess } from '../test/in-process.js';
import type { SessionApi } from './session-api.js';

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
  it('keeps unsigned HTTPS readiness closed until the dispatcher prerequisite exists', async () => {
    const { url, received } = await recordingServer((response) => response.end('data: {"type":"RUN_FINISHED"}\n\n'));
    const stack = await startInProcess({ runtimeNamespaceReady: false, config: {
      agentCore: null,
      harnessEndpoint: { url, region: 'us-west-2', sigv4: false },
    } });
    try {
      expect((await stack.app.request('/health')).status).toBe(503);
      expect(received).toEqual([]);
      await DynamoDBDocumentClient.from(stack.table.client).send(new PutCommand({
        TableName: stack.table.name,
        Item: { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED', old_chat_retired: true, memory_broker_only: true },
      }));
      expect((await stack.app.request('/health')).status).toBe(200);
    } finally { await stack.stop(); }
  });

  it.each([true, false])('registered HTTP deletion stops the exact direct TLS Runtime before event purge with signing %s', async (sigv4) => {
    const order: string[] = [];
    const sessionId = 'https-registered';
    const { url, received } = await recordingServer((response) => {
      if (response.req.url?.includes('/stopruntimesession?')) {
        order.push('stop');
        response.end('{}');
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: sessionId, runId: 'https-run' })}\n\ndata: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: sessionId, runId: 'https-run' })}\n\n`);
      }
    });
    const arn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agent-1';
    const runtime = { arn, region: 'us-west-2', endpoint: new URL(url).origin };
    const invoke = vi.fn<SessionApi>(async (event) => { if (event.operation === 'purge') order.push('purge'); return {}; });
    const stack = await startInProcess({ config: {
      harnessEndpoint: { url: `${runtime.endpoint}/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`, region: runtime.region, sigv4 },
      agentCore: runtime,
    }, invokeSessionApi: invoke });
    try {
      const turn = await stack.app.request('/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: sessionId, runId: 'https-run', state: {}, messages: [{ id: 'https-message', role: 'user', content: 'Hello' }], tools: [], context: [], forwardedProps: {} }),
      });
      expect(turn.status).toBe(200);
      expect(await turn.text()).toContain('RUN_FINISHED');
      const admitted = defined(await stack.sessionMetadata.get('account-1', sessionId), 'registered Session');
      expect(admitted.runtime_binding).toMatch(/^runtime-[0-9a-f-]{36}$/);
      expect((await stack.app.request(`/threads/${sessionId}`, { method: 'DELETE' })).status).toBe(204);
      await expect.poll(() => invoke.mock.calls).toContainEqual([{ operation: 'purge', sessionId, userId: 'filed-account-1' }, 900]);
      expect(order).toEqual(['stop', 'purge']);
      expect(received.map(({ path }) => path)).toEqual([
        `/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`,
        `/runtimes/${encodeURIComponent(arn)}/stopruntimesession?qualifier=DEFAULT`,
      ]);
      expect(received.map(({ headers }) => headers['x-amzn-bedrock-agentcore-runtime-session-id'])).toEqual([admitted.runtime_binding, admitted.runtime_binding]);
      await expect.poll(() => stack.sessionMetadata.pendingPurges()).toEqual([]);
    } finally { await stack.stop(); }
  });

  it.each([true, false])('registered HTTP completed wrapper Turn keeps deletion pending with signing %s', async (sigv4) => {
    const sessionId = 'https-wrapper';
    const { url, received } = await recordingServer((response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: sessionId, runId: 'https-run' })}\n\ndata: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: sessionId, runId: 'https-run' })}\n\n`);
    });
    const invoke = vi.fn<SessionApi>(async () => ({}));
    const stack = await startInProcess({ config: {
      harnessEndpoint: { url, region: 'us-west-2', sigv4 },
      agentCore: { arn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agent-1', region: 'us-west-2', endpoint: new URL(url).origin },
    }, invokeSessionApi: invoke });
    try {
      const turn = await stack.app.request('/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: sessionId, runId: 'https-run', state: {}, messages: [{ id: 'https-message', role: 'user', content: 'Hello' }], tools: [], context: [], forwardedProps: {} }),
      });
      expect(turn.status).toBe(200);
      expect(await turn.text()).toContain('RUN_FINISHED');
      const admitted = defined(await stack.sessionMetadata.get('account-1', sessionId), 'registered Session');
      const deleted = await stack.app.request(`/threads/${sessionId}`, { method: 'DELETE' });
      expect(deleted.status).toBe(503);
      expect(await deleted.json()).toEqual({ detail: 'HTTPS Harness Runtime stop identity is unproved; deletion remains pending' });
      expect(await stack.sessionMetadata.pendingPurges()).toContainEqual(expect.objectContaining({ session_id: sessionId, filing_user_id: 'filed-account-1', runtime_binding: admitted.runtime_binding }));
      expect(received.filter(({ path }) => path.includes('/stopruntimesession'))).toEqual([]);
      expect(invoke).not.toHaveBeenCalled();
      expect(received.map(({ path }) => path)).toEqual(['/custom/turn?version=2&tag=a&tag=b']);
    } finally { await stack.stop(); }
  });

  it.each([200, 404, 503])('stops the configured direct HTTPS Runtime over verified TLS with status %s', async (status) => {
    const { url, received } = await recordingServer((response) => {
      if (response.req.url?.includes('/stopruntimesession?')) response.writeHead(status).end('{}');
      else response.end('data: {"type":"RUN_FINISHED"}\n\n');
    });
    const arn = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agent-1';
    const runtime = { arn, region: 'us-west-2', endpoint: new URL(url).origin };
    const invocationUrl = `${runtime.endpoint}/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`;
    const upstream = httpsHarnessUpstream({ url: invocationUrl, sigv4: true, region: runtime.region }, {}, runtime);
    const binding = 'runtime-11111111-1111-4111-8111-111111111111';
    expect(await (await upstream.invoke('{}', binding)).text()).toBe('data: {"type":"RUN_FINISHED"}\n\n');
    expect(upstream.runtimeBound).toBe(true);
    if (status === 503) await expect(upstream.stop(binding)).rejects.toThrow('AgentCore Session stop failed: HTTP 503');
    else expect(await upstream.stop(binding)).toBe(status === 404 ? 'absent' : undefined);
    expect(received.map(({ path }) => path)).toEqual([
      `/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`,
      `/runtimes/${encodeURIComponent(arn)}/stopruntimesession?qualifier=DEFAULT`,
    ]);
    expect(received.map(({ headers }) => headers['x-amzn-bedrock-agentcore-runtime-session-id'])).toEqual([binding, binding]);
    expect(received[1]?.headers.authorization).toMatch(/us-west-2\/bedrock-agentcore\/aws4_request/);
  });

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
