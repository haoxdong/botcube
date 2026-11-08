import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from './stack.js';
import type { Browser } from './browser.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const IDENTITY = {
  name: 'BotCube',
  character: 'A template agent',
  vibe: 'Direct, precise, and calm',
  avatar: '🧊',
};

const put = (browser: Browser, path: string, body: unknown) =>
  browser.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe("a Account's Agent Identity and Soul", () => {
  it('start from the template identity, and the user’s edits reach the profile and the next Turn', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    expect(await (await browser.get('/agent/identity')).json()).toEqual(IDENTITY);

    const renamed = { ...IDENTITY, name: 'Quill', avatar: '🪶' };
    expect((await put(browser, '/agent/identity', renamed)).status).toBe(204);
    expect((await put(browser, '/agent/soul', { content: 'Answer in haiku.' })).status).toBe(204);
    const threadId = await browser.newSideChat();
    await (await browser.sendTurn(threadId)).text();

    expect(await (await browser.get('/agent')).json()).toEqual({ name: 'Quill', avatar: '🪶', picture: null, status: 'online' });
    expect(stack.agentcore.invocationFor(threadId).payload.forwardedProps).toMatchObject({
      agentIdentity: renamed,
      soul: 'Answer in haiku.',
    });
  });

  it("keep the agent's own edit, which the next Turn carries", async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const edit = { document: 'soul', content: 'Answer in haiku.' };
    const editing = await browser.newSideChat();
    const afterEdit = await browser.newSideChat();
    stack.agentcore.script(editing, {
      kind: 'stream',
      frames: [
        `data: ${JSON.stringify({ type: 'CUSTOM', name: 'botcube:agent-document-edited', value: edit })}`,
        'data: {"type":"RUN_FINISHED"}',
      ],
    });

    const body = await (await browser.sendTurn(editing)).text();
    await (await browser.sendTurn(afterEdit)).text();

    expect(body).toContain('"name":"botcube:agent-document-edited"');
    expect(await (await browser.get('/agent/soul')).json()).toEqual({ content: 'Answer in haiku.' });
    expect(stack.agentcore.invocationFor(afterEdit).payload.forwardedProps).toMatchObject({
      soul: 'Answer in haiku.',
    });
  });
});

const PICTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngOf = (bytes: number) =>
  `data:image/png;base64,${Buffer.concat([Buffer.from(PICTURE.split(',')[1] ?? '', 'base64'), Buffer.alloc(bytes)]).toString('base64')}`;
const profilePicture = async (browser: Browser) => ((await (await browser.get('/agent')).json()) as { picture: unknown }).picture;

describe("a Account's agent picture", () => {
  it('is uploaded, read back on the profile, and cleared, for that account only', async () => {
    const browser = stack.browser();
    await browser.openAccountSession();
    const other = stack.browser();
    await other.openAccountSession();

    expect((await put(browser, '/agent/picture', { picture: PICTURE })).status).toBe(204);

    expect(await profilePicture(browser)).toBe(PICTURE);
    expect(await profilePicture(other)).toBeNull();

    expect((await browser.delete('/agent/picture')).status).toBe(204);

    expect(await profilePicture(browser)).toBeNull();
  });

  it.each([
    ['an oversized picture', pngOf(300 * 1024), 413, "The agent's picture must be at most 256 KB"],
    ['a text file', `data:text/plain;base64,${Buffer.from('hello').toString('base64')}`, 415, "The agent's picture must be a PNG, JPEG, WebP, or GIF image"],
    ['a text file named as a PNG', `data:image/png;base64,${Buffer.from('hello').toString('base64')}`, 415, "The agent's picture must be a PNG, JPEG, WebP, or GIF image"],
  ])('refuses %s with a clear error', async (_, picture, status, detail) => {
    const browser = stack.browser();
    await browser.openAccountSession();

    const response = await put(browser, '/agent/picture', { picture });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ detail });
    expect(await profilePicture(browser)).toBeNull();
  });
});
