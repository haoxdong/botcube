import { createServer as createHttpServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentCoreEndpointFromEnv, agentCoreUpstream, localAgentUpstream, harnessEndpointFromEnv, httpsHarnessUpstream, type Upstream } from './upstream.js';
import { defined } from '../test/defined.js';

const sockets: Socket[] = [];
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listening(server: Server): Promise<number> {
  server.on('connection', (socket: Socket) => void sockets.push(socket)).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A plain-HTTP server that records each request and answers it with `answer`, or never answers. */
async function recordingServer(answer?: (response: ServerResponse) => void) {
  const received: Received[] = [];
  const server = createHttpServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      received.push({ method: defined(request.method, 'a method'), url: defined(request.url, 'a URL'), headers: request.headers, body });
      answer?.(response);
    });
  });
  return { baseUrl: `http://127.0.0.1:${await listening(server)}`, received };
}

/** An upstream that accepts the TCP connection but never completes the TLS handshake. */
async function silentTlsUpstream(): Promise<string> {
  return `https://127.0.0.1:${await listening(createServer())}`;
}

/** The invocation's outcome, failing (not hanging) if it does not settle in time. */
async function settled(invocation: Promise<Response>, withinMs = 2_000): Promise<Response> {
  let timer: NodeJS.Timeout | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the invocation did not settle')), withinMs);
  });
  return Promise.race([invocation, stalled]).finally(() => clearTimeout(timer));
}

// undici checks its connect timeout on a coarse clock, so a 50 ms timeout fires after about a second.
// Its default, 10 s, would outlast this bound; the test's own timeout outlasts the bound.
const CONNECT_BOUND_MS = 5_000;
const CONNECT_TEST_TIMEOUT_MS = 15_000;

const redirect = (response: ServerResponse) => response.writeHead(302, { location: '/elsewhere' }).end();

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agent-1';

const agentCore = (endpoint: string, options?: { connectTimeoutMs: number }) =>
  agentCoreUpstream({ arn: RUNTIME_ARN, region: 'us-west-2', endpoint }, options);

describe('the AgentCore endpoint', () => {
  it.each([
    [{}, { region: 'us-east-1', endpoint: 'https://bedrock-agentcore.us-east-1.amazonaws.com' }],
    [{ AGENTCORE_REGION: 'eu-west-1' }, { region: 'eu-west-1', endpoint: 'https://bedrock-agentcore.eu-west-1.amazonaws.com' }],
    [
      { AGENTCORE_REGION: 'eu-west-1', AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: 'http://127.0.0.1:9000//' },
      { region: 'eu-west-1', endpoint: 'http://127.0.0.1:9000' },
    ],
  ])('from %o is %o', (env, expected) => {
    expect(agentCoreEndpointFromEnv(env)).toEqual(expected);
  });
});

describe('the AgentCore upstream', () => {
  it('posts the Turn to the Runtime, SigV4-signed for its Session', async () => {
    const { baseUrl, received } = await recordingServer((response) => response.end('ok'));

    const response = await settled(agentCore(baseUrl).invoke('{"prompt":"hi"}', 'session-1', { accept: 'text/plain' }));

    expect(await response.text()).toBe('ok');
    expect(agentCore(baseUrl).label).toBe('AgentCore upstream');
    expect(received).toEqual([
      {
        method: 'POST',
        url: '/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A123456789012%3Aruntime%2Fagent-1/invocations?qualifier=DEFAULT',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-amzn-bedrock-agentcore-runtime-session-id': 'session-1',
          authorization: expect.stringMatching(
            /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock-agentcore\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amzn-bedrock-agentcore-runtime-session-id, Signature=[0-9a-f]{64}$/,
          ),
        }),
        body: '{"prompt":"hi"}',
      },
    ]);
  });

  it('stops the exact Runtime Session before its record is erased', async () => {
    const { baseUrl, received } = await recordingServer((response) => response.end());

    await agentCore(baseUrl).stop('session-1');

    expect(received).toEqual([{
      method: 'POST',
      url: '/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A123456789012%3Aruntime%2Fagent-1/stopruntimesession?qualifier=DEFAULT',
      headers: expect.objectContaining({
        'content-type': 'application/json',
        'x-amzn-bedrock-agentcore-runtime-session-id': 'session-1',
        authorization: expect.stringContaining('/us-west-2/bedrock-agentcore/aws4_request'),
      }),
      body: '{}',
    }]);
  });

  it('can erase a Session whose Sandbox is already gone', async () => {
    const { baseUrl } = await recordingServer((response) => response.writeHead(404).end());

    await expect(agentCore(baseUrl).stop('session-1')).resolves.toBe('absent');
  });

  it.each([302, 403, 409, 500])('reports a failed Runtime stop with status %i', async (status) => {
    const { baseUrl } = await recordingServer((response) => response.writeHead(status).end('provider detail'));

    await expect(agentCore(baseUrl).stop('session-1')).rejects.toThrow(`AgentCore Session stop failed: HTTP ${status}`);
  });

  it('does not follow a redirect', async () => {
    const { baseUrl, received } = await recordingServer(redirect);

    const response = await settled(agentCore(baseUrl).invoke('{}', 'session-1'));

    expect(response.status).toBe(302);
    expect(received).toHaveLength(1);
  });

  it('abandons the request when the Turn is aborted', async () => {
    const { baseUrl } = await recordingServer();
    const abort = new AbortController();

    const invocation = settled(agentCore(baseUrl).invoke('{}', 'session-1', { signal: abort.signal }));
    abort.abort(new Error('client went away'));

    await expect(invocation).rejects.toThrow('client went away');
  });

  it(
    'fails once the connect timeout passes',
    async () => {
      const upstream = agentCore(await silentTlsUpstream(), { connectTimeoutMs: 50 });

      await expect(settled(upstream.invoke('{}', 'session-1'), CONNECT_BOUND_MS)).rejects.toMatchObject({
        cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
      });
    },
    CONNECT_TEST_TIMEOUT_MS,
  );
});

describe('the local Harness upstream', () => {
  const local = (baseUrl: string): Upstream => localAgentUpstream(baseUrl);

  it('posts the Turn to its invocations for the Session, accepting an event stream by default', async () => {
    const { baseUrl, received } = await recordingServer((response) => response.end('ok'));

    const response = await settled(local(baseUrl).invoke('{"prompt":"hi"}', 'session-1'));

    expect(await response.text()).toBe('ok');
    expect(local(baseUrl).label).toBe('Local Harness');
    expect(received).toEqual([
      {
        method: 'POST',
        url: '/invocations',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-amzn-bedrock-agentcore-runtime-session-id': 'session-1',
        }),
        body: '{"prompt":"hi"}',
      },
    ]);
  });

  it('accepts the type the Turn asks for', async () => {
    const { baseUrl, received } = await recordingServer((response) => response.end());

    await settled(local(baseUrl).invoke('{}', 'session-1', { accept: 'application/json' }));

    expect(defined(received[0], 'a request').headers.accept).toBe('application/json');
  });

  it('does not follow a redirect', async () => {
    const { baseUrl, received } = await recordingServer(redirect);

    const response = await settled(local(baseUrl).invoke('{}', 'session-1'));

    expect(response.status).toBe(302);
    expect(received).toHaveLength(1);
  });

  it('abandons the request when the Turn is aborted', async () => {
    const { baseUrl } = await recordingServer();
    const abort = new AbortController();

    const invocation = settled(local(baseUrl).invoke('{}', 'session-1', { signal: abort.signal }));
    abort.abort(new Error('client went away'));

    await expect(invocation).rejects.toThrow('client went away');
  });

  it(
    'fails once the connect timeout passes',
    async () => {
      const upstream = localAgentUpstream(await silentTlsUpstream(), { connectTimeoutMs: 50 });

      await expect(settled(upstream.invoke('{}', 'session-1'), CONNECT_BOUND_MS)).rejects.toMatchObject({
        cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
      });
    },
    CONNECT_TEST_TIMEOUT_MS,
  );
});

describe('a configured HTTPS Harness', () => {
  it.each([
    ['no Runtime identity', null, 'https://wrapper.example/turn', 'us-west-2'],
    ['another ARN', { arn: RUNTIME_ARN, region: 'us-west-2', endpoint: 'https://runtime.example' }, `https://runtime.example/runtimes/${encodeURIComponent(RUNTIME_ARN + '-other')}/invocations?qualifier=DEFAULT`, 'us-west-2'],
    ['another qualifier', { arn: RUNTIME_ARN, region: 'us-west-2', endpoint: 'https://runtime.example' }, `https://runtime.example/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=LIVE`, 'us-west-2'],
    ['another region', { arn: RUNTIME_ARN, region: 'us-west-2', endpoint: 'https://runtime.example' }, `https://runtime.example/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=DEFAULT`, 'us-east-1'],
    ['another origin', { arn: RUNTIME_ARN, region: 'us-west-2', endpoint: 'https://runtime.example' }, `https://wrapper.example/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=DEFAULT`, 'us-west-2'],
    ['wrapper path', { arn: RUNTIME_ARN, region: 'us-west-2', endpoint: 'https://runtime.example' }, 'https://runtime.example/turn', 'us-west-2'],
    ['extra query', { arn: RUNTIME_ARN, region: 'us-west-2', endpoint: 'https://runtime.example' }, `https://runtime.example/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=DEFAULT&target=other`, 'us-west-2'],
    ['duplicate qualifier', { arn: RUNTIME_ARN, region: 'us-west-2', endpoint: 'https://runtime.example' }, `https://runtime.example/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=DEFAULT&qualifier=LIVE`, 'us-west-2'],
  ] as const)('refuses unsupported HTTPS Runtime stop for %s without sending any request', async (_case, runtime, url, region) => {
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', async (target: unknown) => { requests.push(target); return new Response('{}'); });
    await Promise.all([true, false].map(async (sigv4) => {
      const upstream = httpsHarnessUpstream({ url, region, sigv4 }, {}, runtime);
      expect(upstream.runtimeBound).toBe(false);
      await expect(upstream.stop('runtime-11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({
        status: 503, message: 'HTTPS Harness Runtime stop identity is unproved; deletion remains pending',
      });
    }));
    expect(requests).toEqual([]);
  });

  it.each(['true', 'false'])('posts to the full URL with SigV4 %s and streams the response', async (signing) => {
    const requests: { url: unknown; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"RUN_STARTED"}\n\n'));
          controller.enqueue(new TextEncoder().encode('data: {"type":"RUN_FINISHED"}\n\n'));
          controller.close();
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    });
    const endpoint = defined(harnessEndpointFromEnv({
      BOTCUBE_HARNESS_ENDPOINT: 'https://wrapper.example/custom/turn?version=2',
      BOTCUBE_HARNESS_SIGV4: signing,
      AGENTCORE_REGION: 'eu-west-1',
    }), 'a configured endpoint');
    const response = await httpsHarnessUpstream(endpoint).invoke('{"prompt":"hi"}', 'session-1');
    expect(await response.text()).toBe('data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n');
    const request = defined(requests[0], 'an invocation');
    expect(request.url).toBe('https://wrapper.example/custom/turn?version=2');
    expect(request.init).toMatchObject({ method: 'POST', body: '{"prompt":"hi"}', redirect: 'manual' });
    const headers = new Headers(request.init.headers);
    expect(headers.get('x-amzn-bedrock-agentcore-runtime-session-id')).toBe('session-1');
    expect(headers.get('accept')).toBe('text/event-stream');
    if (signing === 'true') expect(headers.get('authorization')).toMatch(/eu-west-1\/bedrock-agentcore\/aws4_request/);
    else expect(headers.get('authorization')).toBeNull();
  });

  it.each([true, false])('propagates upstream failure and cancellation with signing %s', async (sigv4) => {
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      if (init.signal?.aborted) throw init.signal.reason;
      return new Response('unavailable', { status: 503 });
    });
    const upstream = httpsHarnessUpstream({ url: 'https://wrapper.example/turn', sigv4, region: 'us-east-1' });
    const response = await upstream.invoke('{}', 'session-1');
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('unavailable');
    const abort = new AbortController();
    abort.abort(new Error('client went away'));
    await expect(upstream.invoke('{}', 'session-1', { signal: abort.signal })).rejects.toThrow('client went away');
  });

  it.each([
    { BOTCUBE_HARNESS_ENDPOINT: 'http://wrapper.example/turn' },
    { BOTCUBE_HARNESS_ENDPOINT: 'invalid' },
    { BOTCUBE_HARNESS_ENDPOINT: 'https://user:secret@wrapper.example/turn' },
    { BOTCUBE_HARNESS_ENDPOINT: 'https://wrapper.example/turn#fragment' },
    { BOTCUBE_HARNESS_ENDPOINT: 'https://wrapper.example/turn', BOTCUBE_HARNESS_SIGV4: 'yes' },
    { BOTCUBE_HARNESS_ENDPOINT: 'https://wrapper.example/turn', BOTCUBE_LOCAL_HARNESS_URL: 'http://localhost:8080' },
    { BOTCUBE_HARNESS_SIGV4: 'false' },
  ])('rejects invalid configuration %o', (env) => {
    expect(() => harnessEndpointFromEnv(env)).toThrow();
  });
});
