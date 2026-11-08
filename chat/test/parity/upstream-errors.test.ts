import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { required } from '../required.js';
import { frameData, sseFrames } from './browser.js';
import { startStack, type Stack } from './stack.js';

let stack: Stack;
let unreachable: Stack;
let unconfigured: Stack;
beforeAll(async () => {
  [stack, unreachable, unconfigured] = await Promise.all([
    startStack(),
    startStack({ agentcore: 'unreachable' }),
    startStack({ agentcore: 'unconfigured' }),
  ]);
});
afterAll(() => Promise.all([stack.stop(), unreachable.stop(), unconfigured.stop()]));

describe('upstream failures reach the client as classified errors', () => {
  async function turnAgainst(status: number, body: string | null) {
    const browser = stack.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();
    stack.agentcore.script(threadId, { kind: 'error', status, body });
    const response = await browser.sendTurn(threadId);
    return { status: response.status, body: await response.json() };
  }

  it('keeps an upstream 4xx status and its body as details', async () => {
    expect(await turnAgainst(404, '{"message":"runtime missing"}')).toEqual({
      status: 404,
      body: {
        error: 'AgentCore upstream returned HTTP 404',
        details: '{"message":"runtime missing"}',
      },
    });
    expect(await turnAgainst(403, '{"message":"access denied"}')).toEqual({
      status: 403,
      body: {
        error: 'AgentCore upstream returned HTTP 403',
        details: '{"message":"access denied"}',
      },
    });
  });

  it.each([502, 504])('answers an upstream %i as 503 with its body, a status Cloudflare passes through', async (status) => {
    expect(await turnAgainst(status, 'Runtime unavailable')).toEqual({
      status: 503,
      body: { error: `AgentCore upstream returned HTTP ${status}`, details: 'Runtime unavailable' },
    });
  });

  it('maps an unexpected upstream redirect to 503', async () => {
    expect(await turnAgainst(302, '<html>redirect</html>')).toEqual({
      status: 503,
      body: { error: 'AgentCore upstream returned HTTP 302', details: '<html>redirect</html>' },
    });
  });

  it('maps an upstream error whose body cannot be read to 503', async () => {
    const { status, body } = await turnAgainst(500, null);

    expect(status).toBe(503);
    expect(body).toEqual({
      error: 'AgentCore upstream returned HTTP 500 but its error body could not be read',
      details: expect.any(String),
    });
  });

  it('ends the stream with a RUN_ERROR when the upstream fails mid-stream', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const first = 'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"hello"}';
    const threadId = await browser.newSideChat();
    stack.agentcore.script(threadId, { kind: 'stream', frames: [first], drop: true });

    const response = await browser.sendTurn(threadId);

    expect(response.status).toBe(200);
    const [received, runError, ...rest] = sseFrames(await response.text());
    expect(received).toBe(first);
    expect(frameData(required(runError, 'RUN_ERROR frame'))).toEqual({
      type: 'RUN_ERROR',
      code: 'AGENTCORE_UPSTREAM_STREAM_ERROR',
      message: expect.stringMatching(/^AgentCore upstream stream failed: /),
    });
    expect(rest).toEqual([]);
  });

  it('maps an upstream that cannot be reached to 503', async () => {
    const browser = unreachable.browser();
    await browser.openAccountSession();

    const response = await browser.sendTurn(await browser.newSideChat());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'AgentCore upstream request failed',
      details: expect.any(String),
    });
  });

  it('refuses a Turn with 503 when no AgentCore Runtime is configured', async () => {
    const browser = unconfigured.browser();
    await browser.openAccountSession();

    const response = await browser.sendTurn(await browser.newSideChat());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AGENTCORE_RUNTIME_ARN is not configured' });
  });
});
