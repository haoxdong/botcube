import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { required } from '../required.js';
import { frameData, sseFrames } from './browser.js';
import { AWS_ACCESS_KEY_ID, RUNTIME_ARN, startStack, type Stack } from './stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

describe("a Turn's credentials never reach the client, whatever Harness answers", () => {
  it.each([
    ['the signed Credential Service invocation token', 'credentialServiceInvocationToken'],
    ["the Agent Computer's tokened CDP URL", 'agentComputerCdpUrl'],
  ])('withholds a stream that echoes %s', async (_, prop) => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();
    stack.agentcore.script(threadId, {
      kind: 'stream',
      frames: (forwarded) => [
        'data: {"type":"RUN_STARTED"}',
        `data: ${JSON.stringify({ type: 'STATE_SNAPSHOT', snapshot: { [prop]: forwarded[prop] } })}`,
        'data: {"type":"RUN_FINISHED"}',
      ],
    });

    const response = await browser.sendTurn(threadId);

    const { forwardedProps } = stack.agentcore.invocationFor(threadId).payload;
    expect(forwardedProps[prop]).toEqual(expect.any(String));
    expect(sseFrames(await response.text())).toEqual([
      'data: {"type":"RUN_STARTED"}',
      `data: ${JSON.stringify({
        type: 'RUN_ERROR',
        message: "The agent's answer carried the Turn's credentials, so it was withheld",
        code: 'TURN_CREDENTIALS_IN_STREAM',
      })}`,
    ]);
  });
  it.each([
    ['the signed Credential Service invocation token', 'credentialServiceInvocationToken'],
    ["the Agent Computer's tokened CDP URL", 'agentComputerCdpUrl'],
  ])('withholds %s split across message deltas', async (_, prop) => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();
    stack.agentcore.script(threadId, {
      kind: 'stream',
      frames: (forwarded) => {
        const value = String(forwarded[prop]);
        const split = Math.floor(value.length / 2);
        return [
          'data: {"type":"RUN_STARTED"}',
          ...[value.slice(0, split), value.slice(split)].map((delta) =>
            `data: ${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta })}`,
          ),
          'data: {"type":"RUN_FINISHED"}',
        ];
      },
    });

    const response = await browser.sendTurn(threadId);

    expect(sseFrames(await response.text())).toEqual([
      'data: {"type":"RUN_STARTED"}',
      `data: ${JSON.stringify({
        type: 'RUN_ERROR',
        message: "The agent's answer carried the Turn's credentials, so it was withheld",
        code: 'TURN_CREDENTIALS_IN_STREAM',
      })}`,
    ]);
  });
  it.each([
    ['the signed Credential Service invocation token', 'credentialServiceInvocationToken'],
    ["the Agent Computer's tokened CDP URL", 'agentComputerCdpUrl'],
  ])('withholds %s split across tool argument deltas', async (_, prop) => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();
    stack.agentcore.script(threadId, {
      kind: 'stream',
      frames: (forwarded) => {
        const value = String(forwarded[prop]);
        const split = Math.floor(value.length / 2);
        return [
          'data: {"type":"RUN_STARTED"}',
          ...[`{"command":"${value.slice(0, split)}`, `${value.slice(split)}"}`].map((delta) =>
            `data: ${JSON.stringify({ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta })}`,
          ),
          'data: {"type":"RUN_FINISHED"}',
        ];
      },
    });

    const response = await browser.sendTurn(threadId);

    expect(sseFrames(await response.text())).toEqual([
      'data: {"type":"RUN_STARTED"}',
      `data: ${JSON.stringify({
        type: 'RUN_ERROR',
        message: "The agent's answer carried the Turn's credentials, so it was withheld",
        code: 'TURN_CREDENTIALS_IN_STREAM',
      })}`,
    ]);
  });
});

describe('a Turn streams through the Chat Service', () => {
  it('passes the upstream SSE frames through verbatim and records the Session', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const id = await browser.newSideChat();
    const frames = [
      'data: {"type":"RUN_STARTED","threadId":"passthrough","runId":"r1"}',
      'event: message\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"hi"}',
      'data: not-json',
      'data: {"type":"RUN_FINISHED","threadId":"passthrough","runId":"r1"}',
    ];
    stack.agentcore.script(id, { kind: 'stream', frames });

    const response = await browser.sendTurn(id, { text: 'What is SPX?' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(sseFrames(await response.text())).toEqual(frames);
    const threads = (await (await browser.get('/threads')).json()) as {
      threads: { id: string; title: string }[];
    };
    expect(threads.threads.map(({ id, title }) => ({ id, title }))).toEqual([
      { id, title: 'What is SPX?' },
    ]);
  });

  it('signs the invocation for the AgentCore Runtime and names the Session in its header', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const id = await browser.newSideChat();

    await (await browser.sendTurn(id)).text();

    const invocation = stack.agentcore.invocationFor(id);
    expect(invocation.method).toBe('POST');
    expect(invocation.path).toBe(
      `/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations?qualifier=DEFAULT`
    );
    expect(invocation.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(id);
    expect(invocation.headers.authorization).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY_ID}/\\d{8}/us-east-1/bedrock-agentcore/aws4_request, SignedHeaders=\\S+, Signature=[0-9a-f]{64}$`
      )
    );
  });
});

describe('browser live-view events are injected after the frame that triggers them', () => {
  const incomplete = {
    type: 'RUN_ERROR',
    message: 'AgentCore upstream stream ended before the Turn finished',
    code: 'AGENTCORE_UPSTREAM_STREAM_ERROR',
  };
  const incompleteFrame = 'data: {"type":"RUN_ERROR","message":"AgentCore upstream stream ended before the Turn finished","code":"AGENTCORE_UPSTREAM_STREAM_ERROR"}';
  const openEvent = (sessionId: string) => ({
    type: 'CUSTOM',
    name: 'botcube:browser-live-view',
    value: { open: true, sessionId },
  });

  async function streamed(frames: string[]): Promise<string[]> {
    const browser = stack.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();
    stack.agentcore.script(threadId, { kind: 'stream', frames });
    const response = await browser.sendTurn(threadId);
    expect(response.status).toBe(200);
    return sseFrames(await response.text());
  }

  it('opens the live view when a streamed delta names a browser Session', async () => {
    const trigger = 'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Session: browser-session-123\\n"}';
    const frames = await streamed([trigger, 'data: {"type":"RUN_FINISHED"}']);

    expect(frames).toHaveLength(3);
    expect(frames[0]).toBe(trigger);
    expect(frameData(required(frames[1], 'live-view frame'))).toEqual(openEvent('browser-session-123'));
    expect(frames[2]).toBe('data: {"type":"RUN_FINISHED"}');
  });

  it('waits for a trailing delimiter before trusting an unbuffered delta', async () => {
    const partial = 'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Session: 01JXK2ab"}';

    expect(await streamed([partial])).toEqual([partial, incompleteFrame]);
  });

  it('reads a Session ID split across one message\'s deltas at the message end', async () => {
    const frames = [
      'data: {"type":"TEXT_MESSAGE_START","messageId":"m1","role":"assistant"}',
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"Session: 01JXK2ab"}',
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"CDEF99"}',
      'data: {"type":"TEXT_MESSAGE_END","messageId":"m1"}',
    ];

    const received = await streamed(frames);

    expect(received.slice(0, 4)).toEqual(frames);
    expect(received.slice(4).map(frameData)).toEqual([openEvent('01JXK2abCDEF99'), incomplete]);
  });

  it('opens the live view from complete tool-result content', async () => {
    const result = 'data: {"type":"TOOL_CALL_RESULT","content":"Session: 01JXK2abCDEF99"}';

    const received = await streamed([result]);

    expect(received[0]).toBe(result);
    expect(received.slice(1).map(frameData)).toEqual([openEvent('01JXK2abCDEF99'), incomplete]);
  });

  it('opens the live view from an AgentCore browser Session URL', async () => {
    const result =
      'data: {"type":"TOOL_CALL_RESULT","content":"https://us-east-1.console.aws.amazon.com/bedrock-agentcore/session/abc123-def456#"}';

    const received = await streamed([result]);

    expect(received.slice(1).map(frameData)).toEqual([openEvent('abc123-def456'), incomplete]);
  });

  it.each(['Browser closed', 'Browser session closed.'])(
    'closes the live view on "%s"',
    async (text) => {
      const closed = `data: {"type":"TOOL_CALL_RESULT","content":"${text}"}`;

      const received = await streamed([closed]);

      expect(received[0]).toBe(closed);
      expect(received.slice(1).map(frameData)).toEqual([
        { type: 'CUSTOM', name: 'botcube:browser-live-view', value: { open: false } },
        incomplete,
      ]);
    }
  );

  it('ignores CDP URLs and session URLs that are not AgentCore', async () => {
    const frames = [
      'data: {"type":"TOOL_CALL_RESULT","content":"ws://127.0.0.1:59182/devtools/browser/f7281651-b67d"}',
      'data: {"type":"TOOL_CALL_RESULT","content":"https://diagnostics.example.com/session/not-agentcore"}',
    ];

    expect(await streamed(frames)).toEqual([...frames, incompleteFrame]);
  });
});
