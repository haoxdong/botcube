import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './stack.js';

let stack: Stack;
let unreachable: Stack;
let bare: Stack;
beforeAll(async () => {
  [stack, unreachable, bare] = await Promise.all([
    startStack(),
    startStack({ agentcore: 'unreachable' }),
    startStack({
      agentcore: 'unconfigured',
      table: 'missing',
      corsOrigins: 'https://example.com, https://preview.example.com',
    }),
  ]);
});
afterAll(() => Promise.all([stack.stop(), unreachable.stop(), bare.stop()]));

function postWarmup(target: Stack, body: BodyInit) {
  return fetch(`${target.url}/warmup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('POST /warmup', () => {

  it('refuses to warm a named Session for no account', async () => {
    const response = await postWarmup(stack, '{"threadId":"warm-anonymous"}');

    expect(response.status).toBe(401);
  });

  it('routes explicit Stop to the Turn Runtime while preserving its logical Session ID', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();
    await (await browser.sendTurn(threadId)).text();
    const turn = stack.agentcore.invocationFor(threadId);
    const response = await browser.post(`/threads/${threadId}/stop`, { runId: 'stop-run' });
    expect(response.status).toBe(204);
    const stop = stack.agentcore.invocations().find(({ body }) => {
      const payload = JSON.parse(body) as { threadId: string; forwardedProps: { stop?: boolean } };
      return payload.threadId === threadId && payload.forwardedProps.stop === true;
    });
    if (stop === undefined) throw new Error('Stop was not dispatched');
    expect(stop.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(turn.headers['x-amzn-bedrock-agentcore-runtime-session-id']);
    expect(JSON.parse(stop.body)).toMatchObject({ threadId, runId: 'stop-run', forwardedProps: { stop: true } });
  });

  it('does not restart a deleted Session through authenticated warmup', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();
    await (await browser.sendTurn(threadId)).text();
    expect((await browser.delete(`/threads/${threadId}`)).status).toBe(204);
    const before = stack.agentcore.invocations().length;
    const response = await browser.post('/warmup', { threadId });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'AgentCore warmup failed' });
    expect(stack.agentcore.invocations().length).toBe(before);
  });

  it('reports a warmup the Runtime rejects as 503', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();
    stack.agentcore.script(threadId, { kind: 'error', status: 500, body: '{}' });

    const response = await browser.post('/warmup', { threadId });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'AgentCore warmup failed' });
  });

  it('requires an account before warming a named Session', async () => {
    const response = await postWarmup(stack, '{"threadId":"no-owner"}');
    expect(response.status).toBe(401);
    expect(stack.agentcore.invocations().some(({ body }) => (JSON.parse(body) as { threadId: string }).threadId === 'no-owner')).toBe(false);
  });

  it('reports a warmup that cannot reach the Runtime as 503', async () => {
    const response = await postWarmup(unreachable, '{}');

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'AgentCore warmup failed' });
  });

  it.each([
    ['truncated JSON', '{'],
    ['a JSON array', '[]'],
    ['non-UTF-8 bytes', new Blob([new Uint8Array([0xff])])],
  ])('rejects a warmup body of %s with 400', async (_label, body) => {
    const response = await postWarmup(stack, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Invalid warmup JSON' });
  });

  it('skips warmup when no Runtime is configured', async () => {
    const response = await postWarmup(bare, '{}');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'skipped' });
  });
});

describe('GET /health', () => {
  it('is ok when Session Metadata storage is reachable', async () => {
    const response = await fetch(`${stack.url}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('is 503 when the Session Metadata table is missing', async () => {
    const response = await fetch(`${bare.url}/health`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ detail: 'Session Metadata storage is unavailable' });
  });
});

describe('CORS', () => {
  function preflight(target: Stack, origin: string) {
    return fetch(`${target.url}/`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
  }

  it('allows the Cartridge dev origins with credentials by default', async () => {
    for (const origin of ['http://localhost:3001', 'http://127.0.0.1:3001']) {
      // eslint-disable-next-line no-await-in-loop -- test cases run one at a time
      const response = await preflight(stack, origin);

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    }
  });

  it('allows only the configured origins when they are injected', async () => {
    const allowed = await preflight(bare, 'https://preview.example.com');
    const devOrigin = await preflight(bare, 'http://localhost:3001');

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      'https://preview.example.com'
    );
    expect(devOrigin.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not allow an unknown origin', async () => {
    const response = await preflight(stack, 'https://evil.example');

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
