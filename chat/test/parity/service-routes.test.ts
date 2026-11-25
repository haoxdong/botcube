import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './stack.js';

let stack: Stack;
let configuredCors: Stack;
beforeAll(async () => {
  [stack, configuredCors] = await Promise.all([
    startStack(),
    startStack({
      corsOrigins: ['https://example.com', 'https://preview.example.com'],
    }),
  ]);
});
afterAll(() => Promise.all([stack.stop(), configuredCors.stop()]));

describe('POST /threads/{id}/stop', () => {
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
});

describe('POST /warmup', () => {
  it('does not restart a deleted Session through authenticated warmup', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();
    await (await browser.sendTurn(threadId)).text();
    expect((await browser.delete(`/threads/${threadId}`)).status).toBe(204);
    const before = stack.agentcore.invocations().length;
    const response = await browser.post('/warmup', { threadId });
    // The Agent Computer refuses a deleted Session before AgentCore is asked to warm it.
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ detail: 'This account does not own the Session' });
    expect(stack.agentcore.invocations().length).toBe(before);
  });

  it('requires an account before warming a named Session', async () => {
    const response = await stack.browser().post('/warmup', { threadId: 'no-owner' });
    expect(response.status).toBe(401);
    expect(stack.agentcore.invocations().some(({ body }) => (JSON.parse(body) as { threadId: string }).threadId === 'no-owner')).toBe(false);
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

  it('allows the bot dev origins with credentials by default', async () => {
    for (const origin of ['http://localhost:3001', 'http://127.0.0.1:3001']) {
      // eslint-disable-next-line no-await-in-loop -- test cases run one at a time
      const response = await preflight(stack, origin);

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    }
  });

  it('allows only the configured origins when they are injected', async () => {
    const allowed = await preflight(configuredCors, 'https://preview.example.com');
    const devOrigin = await preflight(configuredCors, 'http://localhost:3001');

    expect(allowed.status).toBe(204);
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
