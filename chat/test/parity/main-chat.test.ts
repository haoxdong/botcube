import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from './browser.js';
import { startStack, type Stack } from './stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

async function visitor(): Promise<Browser> {
  const browser = stack.browser();
  await browser.openAccountSession();
  return browser;
}

async function chat(browser: Browser, threadId: string, text = `about ${threadId}`): Promise<void> {
  const response = await browser.sendTurn(threadId, { text });
  expect(response.status).toBe(200);
  await response.text();
}

async function mainChat(browser: Browser): Promise<{ id: string; messages: unknown[] }> {
  const response = await browser.get('/main-chat');
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; messages: unknown[] };
}

async function sideChatIds(browser: Browser): Promise<string[]> {
  const response = await browser.get('/threads');
  expect(response.status).toBe(200);
  const { threads } = (await response.json()) as { threads: { id: string }[] };
  return threads.map(({ id }) => id);
}

describe('GET /main-chat', () => {
  it('lands the user in the same empty Main Chat on every visit', async () => {
    const browser = await visitor();

    const first = await mainChat(browser);
    const again = await mainChat(browser);

    expect(first).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), messages: [], running: false });
    expect(again).toEqual(first);
  });

  it('replays the Main Chat once it has Turns, and keeps it out of the Side Chats', async () => {
    const browser = await visitor();
    const { id } = await mainChat(browser);
    await chat(browser, id, 'in the main chat');
    const side = await browser.newSideChat();
    await chat(browser, side, 'about side-beside-main');
    const messages = [{ id: 'm1', role: 'user', content: 'in the main chat' }];
    stack.sessionApi.reply(id, 200, { messages });

    expect(await mainChat(browser)).toEqual({ id, provider: 'echo', messages, running: false });
    expect(await sideChatIds(browser)).toEqual([side]);
  });

  it('gives each account its own Main Chat', async () => {
    const first = await mainChat(await visitor());
    const second = await mainChat(await visitor());

    expect(second.id).not.toBe(first.id);
  });

  it('refuses a request without a Account', async () => {
    const response = await stack.browser().get('/main-chat');

    expect(response.status).toBe(401);
  });
});

describe('Side Chats', () => {
  it('refuses to delete the Main Chat', async () => {
    const browser = await visitor();
    const { id } = await mainChat(browser);
    await chat(browser, id);

    const remove = await browser.delete(`/threads/${id}`);

    expect(remove.status).toBe(409);
    expect(await remove.json()).toEqual({ detail: 'The Main Chat cannot be deleted' });
    expect((await mainChat(browser)).id).toBe(id);
  });
});
