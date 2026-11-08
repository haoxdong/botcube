import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sseFrames } from './browser.js';
import { startStack, type Stack } from './stack.js';

let stack: Stack;
beforeAll(async () => { stack = await startStack(); });
afterAll(() => stack.stop());

const opening = (threadId: string, runId: string) => ({
  threadId, runId, state: {}, messages: [], tools: [], context: [],
  forwardedProps: { opening: true, model: 'echo', effort: 'high' },
});

describe('agent opening Turn', () => {

  it('streams an empty opening through the normal model path and refuses a duplicate after reload', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const main = await browser.get('/main-chat');
    const { id } = await main.json() as { id: string };
    stack.agentcore.script(id, { kind: 'stream', frames: [
      'data: {"type":"RUN_STARTED"}',
      'data: {"type":"TEXT_MESSAGE_START","messageId":"greeting","role":"assistant"}',
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"greeting","delta":"Hi Ada"}',
      'data: {"type":"TEXT_MESSAGE_END","messageId":"greeting"}',
      'data: {"type":"RUN_FINISHED"}',
    ] });
    const first = await browser.post('/', opening(id, 'opening-1'));
    expect(first.status).toBe(200);
    expect(sseFrames(await first.text())).toContain('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"greeting","delta":"Hi Ada"}');
    expect(stack.agentcore.invocationFor(id).payload).toMatchObject({
      messages: [], forwardedProps: { opening: true, model: 'echo', effort: 'high' },
    });
    stack.sessionApi.reply(id, 200, { messages: [{ id: 'greeting', role: 'assistant', content: 'Hi Ada' }] });
    expect(await (await browser.get('/main-chat')).json()).toMatchObject({ id, provider: 'echo',
      messages: [{ id: 'greeting', role: 'assistant', content: 'Hi Ada' }], running: false });
    const duplicate = await browser.post('/', opening(id, 'opening-2'));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ detail: 'This Session already has a Turn' });
    const next = await browser.sendTurn(id, { text: 'Thank you', forwardedProps: { model: 'echo' } });
    expect(next.status).toBe(200);
    await next.text();
  });

  it('recovers a failed opening without a checkpoint and keeps later checkpoint errors loud', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const { id } = await (await browser.get('/main-chat')).json() as { id: string };
    stack.agentcore.script(id, { kind: 'error', status: 503, body: JSON.stringify({ message: 'Model unavailable' }) });
    stack.sessionApi.reply(id, 404, { error: `Session ${id} has no record`, code: 'SESSION_NOT_FOUND' });
    await (await browser.post('/', opening(id, 'failed-opening'))).text();
    expect(await (await browser.get('/main-chat')).json()).toMatchObject({ id, messages: [], provider: 'echo', running: false,
      failure: { runId: 'failed-opening', message: expect.stringContaining('Model unavailable') } });
    expect((await browser.post('/', opening(id, 'duplicate-opening'))).status).toBe(409);
    stack.agentcore.script(id, { kind: 'stream', frames: ['data: {"type":"RUN_STARTED"}', 'data: {"type":"RUN_FINISHED"}'] });
    expect(await (await browser.sendTurn(id, { text: 'Hello again', forwardedProps: { model: 'echo' } })).text()).toContain('RUN_FINISHED');
    expect((await browser.get('/main-chat')).status).toBe(404);
  });

  it('refuses a synthetic user message and unavailable opening model before invocation', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const synthetic = await browser.sendTurn('opening-with-message', { forwardedProps: { opening: true } });
    expect(synthetic.status).toBe(422);
    expect(await synthetic.json()).toEqual({ detail: 'An opening Turn cannot contain messages' });
    const unavailable = await browser.post('/', {
      ...opening('opening-unavailable', 'unavailable-1'), forwardedProps: { opening: true, model: 'unavailable' },
    });
    expect(unavailable.status).toBe(422);
    expect(await unavailable.json()).toEqual({ detail: 'Model "unavailable" is not available to this account' });
    expect(stack.agentcore.invocations().filter(({ body }) => body.includes('opening-with-message') || body.includes('opening-unavailable'))).toEqual([]);
  });
});
