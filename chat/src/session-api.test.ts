import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { FakeSessionApi } from '../test/fakes/fake-backends.js';
import { dispatcherFetch } from './dispatcher-fetch.js';
import { sessionApi, SessionApiError, type SessionApiFor } from './session-api.js';

vi.mock('./dispatcher-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dispatcher-fetch.js')>();
  return { dispatcherFetch: vi.fn(actual.dispatcherFetch) };
});

const GET: Parameters<SessionApiFor<'get'>>[1] = { sessionId: 'session-1', userId: 'filed-account-1' };

const EVENT = { ...GET, operation: 'get' };

const httpError = (status: number, detail: string) => expect.objectContaining({ constructor: SessionApiError, status, detail });

afterEach(() => vi.unstubAllGlobals());

/**
 * Runs `test` with a global dispatcher whose headers timeout is 100 ms, standing in for undici's 300 s default,
 * against a server that answers `answer` after 1.5 s; undici checks its timeouts about once a second.
 */
async function pastDefaultHeadersTimeout(answer: string, test: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((_, response) => setTimeout(() => response.writeHead(200).end(answer), 1500));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const global = getGlobalDispatcher();
  const capped = new Agent({ headersTimeout: 100 });
  setGlobalDispatcher(capped);
  try {
    await test(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    setGlobalDispatcher(global);
    await capped.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

it('answers 503 when the session API is not configured', async () => {
  await expect(sessionApi(null)('get', GET)).rejects.toEqual(httpError(503, 'The session API is not configured'));
});

describe('local mode', () => {
  let fake: FakeSessionApi | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    }
  });

  /** A local session API whose every answer is `respond`'s. */
  async function localServer(respond: (response: ServerResponse) => void): Promise<string> {
    server = createServer((_, response) => respond(response));
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('posts the event as JSON to the invocations endpoint and returns its answer', async () => {
    // A server that answers any request, so a malformed request fails the assertions rather than hanging.
    const received: { method?: string | undefined; url?: string | undefined; contentType?: string | undefined; body: string }[] = [];
    server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push({ method: request.method, url: request.url, contentType: request.headers['content-type'], body });
      response.writeHead(200).end('{"messages":[{"id":"m1"}]}');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect(await sessionApi({ localUrl: url })('get', GET)).toEqual({ messages: [{ id: 'm1' }] });
    expect(received).toEqual([
      { method: 'POST', url: '/invocations', contentType: 'application/json', body: JSON.stringify(EVENT) },
    ]);
  });

  it('keeps a post off the wire when its lease cannot cover an invocation', async () => {
    fake = await new FakeSessionApi().listen();
    const invoke = sessionApi({ localUrl: fake.url });
    await expect(invoke('post', {
      sessionId: 'session-1', userId: 'filed-account-1', content: 'Brief', messageId: 'post-1',
    }, Date.now() + 60_000)).rejects.toThrow('Scheduled post lease expires before Session API can finish');
    expect(fake.events()).toEqual([]);
  });

  it("answers 404 with the session API's error", async () => {
    fake = await new FakeSessionApi().listen();
    fake.reply('session-1', 404, { error: 'Session not found' });

    await expect(sessionApi({ localUrl: fake.url })('get', GET)).rejects.toEqual(httpError(404, 'Session not found'));
  });

  it('classifies defined missing Session records without changing the public 404 detail', async () => {
    fake = await new FakeSessionApi().listen();
    fake.reply('session-1', 404, { error: 'Session session-1 has no record', code: 'SESSION_NOT_FOUND' });
    await expect(sessionApi({ localUrl: fake.url })('get', GET)).rejects.toMatchObject({
      sessionCode: 'SESSION_NOT_FOUND', status: 404, detail: 'Session session-1 has no record',
    });
    expect(fake.events()).toEqual([EVENT]);
  });

  it("answers 410 with the session API's error and code for a legacy-format Session", async () => {
    fake = await new FakeSessionApi().listen();
    const error = 'Session session-1 is in the legacy checkpoint format: its latest checkpoint stores no messages';
    fake.reply('session-1', 410, { error, code: 'SESSION_FORMAT_LEGACY' });

    await expect(sessionApi({ localUrl: fake.url })('get', GET)).rejects.toEqual(
      expect.objectContaining({ constructor: SessionApiError, status: 410, detail: error, code: 'SESSION_FORMAT_LEGACY' }),
    );
  });

  it('answers 503 naming any other status', async () => {
    fake = await new FakeSessionApi().listen();
    fake.reply('session-1', 500, { error: '/private/sentinel.py', stackTrace: ['secret-stack'] });

    await expect(sessionApi({ localUrl: fake.url })('get', GET)).rejects.toEqual(
      httpError(503, 'Session API returned HTTP 500'),
    );
  });

  it('answers 503 for a non-JSON body', async () => {
    const url = await localServer((response) => response.writeHead(200).end('not json'));

    await expect(sessionApi({ localUrl: url })('get', GET)).rejects.toEqual(
      httpError(503, 'Session API returned HTTP 200 with a non-JSON body'),
    );
  });

  it('answers 503 when the session API is unreachable', async () => {
    const url = await localServer(() => undefined);
    server?.close();
    server = undefined;

    await expect(sessionApi({ localUrl: url })('get', GET)).rejects.toEqual(
      httpError(503, 'Session API request failed'),
    );
  });

  it('waits for a slow answer within the timeout', async () => {
    const url = await localServer((response) => setTimeout(() => response.writeHead(200).end('{"messages":[]}'), 50));

    expect(await sessionApi({ localUrl: url })('get', GET)).toEqual({ messages: [] });
  });

  it("waits past undici's default headers timeout for an answer within the call's timeout", async () => {
    await pastDefaultHeadersTimeout('{"messages":[]}', async (url) => {
      expect(await sessionApi({ localUrl: url })('get', GET)).toEqual({ messages: [] });
    });
  });

  it('answers 503 when the answer outlasts the timeout', async () => {
    const url = await localServer(() => undefined);
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort());
    try {
      await expect(sessionApi({ localUrl: url })('get', GET)).rejects.toEqual(httpError(503, 'Session API request failed'));
      expect(timeout).toHaveBeenCalledWith(60_000);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('AWS mode', () => {
  const FUNCTION_ARN = 'arn:aws:lambda:eu-west-1:123456789012:function:session-api';
  const INVOKE_URL =
    'https://lambda.eu-west-1.amazonaws.com/2015-03-31/functions/arn%3Aaws%3Alambda%3Aeu-west-1%3A123456789012%3Afunction%3Asession-api/invocations';
  const invoke = sessionApi({ functionArn: FUNCTION_ARN, region: 'eu-west-1' });

  afterEach(() => vi.mocked(dispatcherFetch).mockRestore());

  type Init = Parameters<typeof dispatcherFetch>[1];

  /** Lambda Invoke, answered by `answer`; returns the requests it received. */
  function lambda(answer: (init: Init) => Promise<Response>): { url: string; init: Init }[] {
    const requests: { url: string; init: Init }[] = [];
    vi.mocked(dispatcherFetch).mockImplementation(async (url, init) => {
      requests.push({ url, init });
      return answer(init);
    });
    return requests;
  }

  const result = (statusCode: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ statusCode, body }), { status: 200, headers });

  it("invokes the function with the event, signed for Lambda in the function's region", async () => {
    const requests = lambda(async () => result(200, { messages: [] }));

    expect(await invoke('get', GET)).toEqual({ messages: [] });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    assert.isDefined(request);
    const { url, init } = request;
    expect(url).toBe(INVOKE_URL);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(EVENT);
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=\w+\/\d{8}\/eu-west-1\/lambda\/aws4_request, /);
    expect(headers.authorization).toMatch(/SignedHeaders=content-type;host;/);
  });

  it("uses the configured Lambda endpoint and keeps regional signing", async () => {
    const requests = lambda(async () => result(200, { messages: [] }));
    const configured = sessionApi({ functionArn: FUNCTION_ARN, region: 'eu-west-1', endpoint: 'https://lambda.corporate.example/' });
    expect(await configured('get', GET)).toEqual({ messages: [] });
    expect(requests[0]?.url).toBe(INVOKE_URL.replace('https://lambda.eu-west-1.amazonaws.com', 'https://lambda.corporate.example'));
    expect((requests[0]?.init.headers as Record<string, string>).authorization).toContain('/eu-west-1/lambda/aws4_request');
  });

  it("waits past undici's default headers timeout for an answer within the call's timeout", async () => {
    await pastDefaultHeadersTimeout(JSON.stringify({ statusCode: 200, body: { messages: [] } }), async (url) => {
      const configured = sessionApi({ functionArn: FUNCTION_ARN, region: 'eu-west-1', endpoint: url });
      expect(await configured('get', GET)).toEqual({ messages: [] });
    });
  });

  it("answers 404 with the function's error", async () => {
    lambda(async () => result(404, { error: 'Session not found' }));

    await expect(invoke('get', GET)).rejects.toEqual(httpError(404, 'Session not found'));
  });

  it("answers 503 naming the function's other status", async () => {
    lambda(async () => result(500, { error: '/private/sentinel.py', stackTrace: ['secret-stack'] }));

    await expect(invoke('get', GET)).rejects.toEqual(httpError(503, 'Session API returned HTTP 500'));
  });

  it.each([300, 403, 500])('answers 503 when Lambda Invoke returns HTTP %i', async (status) => {
    lambda(async () => new Response(JSON.stringify({ error: '/private/sentinel.py', stackTrace: ['secret-stack'] }), { status }));

    await expect(invoke('get', GET)).rejects.toEqual(
      httpError(503, `Session API request failed: Lambda Invoke returned HTTP ${status}`),
    );
  });

  it('answers 503 when the function fails', async () => {
    lambda(async () => result(200, {}, { 'x-amz-function-error': 'Unhandled' }));

    await expect(invoke('get', GET)).rejects.toEqual(
      httpError(503, 'Session API function failed'),
    );
  });

  it('keeps Lambda stack traces and file paths out of the client error for a Memory save', async () => {
    lambda(async () => new Response(JSON.stringify({
      errorMessage: 'Updating memory record mem-deleted failed: Memory record not found',
      errorType: 'RuntimeError',
      stackTrace: [['/var/task/botcube_harness_deepagents/memory_document.py', 104, 'edit_memory_line', 'client.batch_update_memory_records(...)']],
    }), { status: 200, headers: { 'x-amz-function-error': 'Unhandled' } }));

    await expect(invoke('memory-edit', { userId: 'user-1', recordId: 'mem-deleted', text: 'Trades silver' }))
      .rejects.toEqual(httpError(503, 'Session API function failed'));
  });

  it('answers 503 when the function returns a non-JSON result', async () => {
    lambda(async () => new Response('not json', { status: 200 }));

    await expect(invoke('get', GET)).rejects.toEqual(
      httpError(503, 'Session API function returned a result with a non-JSON body'),
    );
  });

  it.each([
    ['an error', new TypeError('/private/sentinel.py stackTrace')],
    ['a non-error', '/private/sentinel.py stackTrace'],
  ])('answers 503 when the request fails with %s', async (_, failure) => {
    lambda(async () => {
      throw failure;
    });

    await expect(invoke('get', GET)).rejects.toEqual(httpError(503, 'Session API request failed'));
  });

  /** Lambda Invoke answering after `ms`, unless the request is aborted first. */
  const slowLambda = (ms: number) =>
    lambda(
      (init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(result(200, { messages: [] })), ms);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          });
        }),
    );

  it('waits for a slow answer within the timeout', async () => {
    slowLambda(50);

    expect(await invoke('get', GET)).toEqual({ messages: [] });
  });

  it('answers 503 when the answer outlasts the timeout', async () => {
    slowLambda(5_000);
    const signal = AbortSignal.timeout(50);
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(signal);
    try {
      await expect(invoke('purge', GET)).rejects.toEqual(httpError(503, 'Session API request failed'));
      expect(timeout).toHaveBeenCalledWith(910_000);
    } finally {
      timeout.mockRestore();
    }
  });
});
