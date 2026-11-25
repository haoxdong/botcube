import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

describe('a bot whose settings turn Extracted Memory off', () => {
  let forgetful: Stack;
  beforeAll(async () => {
    forgetful = await startStack({ bot: { extractedMemory: { enabled: false } } });
  });
  afterAll(() => forgetful.stop());

  it('tells the Harness to keep no Extracted Memory, whatever the client asks', async () => {
    const browser = forgetful.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();

    await (await browser.sendTurn(threadId, { forwardedProps: { botMemory: true } })).text();

    expect(forgetful.agentcore.invocationFor(threadId).payload.forwardedProps.botMemory).toBe(false);
  });
});

describe('a bot whose settings keep both kinds of Memory', () => {
  it("leaves a member's Session its Extracted Memory", async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const threadId = await browser.newSideChat();

    await (await browser.sendTurn(threadId)).text();

    expect(stack.agentcore.invocationFor(threadId).payload.forwardedProps).not.toHaveProperty('botMemory');
  });
});

it('a bot.yaml with memory stops the Chat Service, naming writtenMemory and extractedMemory', async () => {
  await expect(startStack({ bot: { memory: true } })).rejects.toThrow('memory: renamed to writtenMemory.enabled and extractedMemory.enabled');
});
