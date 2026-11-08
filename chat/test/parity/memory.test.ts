import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from './browser.js';
import { startStack, type Stack } from './stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const filingUserId = (accountId: string) => accountId;

const COPPER = { id: 'mem-copper', text: 'Trades copper futures' };
const PARIS = { id: 'mem-paris', text: 'Lives in Paris' };

/** A browser on a fresh account whose Memory holds these lines. */
async function rememberingBrowser(...lines: { id: string; text: string }[]): Promise<Browser> {
  const browser = stack.browser();
  const { accountId } = await browser.openAccountSession();
  stack.sessionApi.memories.set(
    filingUserId(accountId),
    lines.map((line) => ({ ...line })),
  );
  return browser;
}

const put = (browser: Browser, path: string, body: unknown) =>
  browser.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe("an account's Memory", () => {
  it('reads as one line per memory record', async () => {
    const browser = await rememberingBrowser(COPPER, PARIS);

    const response = await browser.get('/agent/memory');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lines: [COPPER, PARIS] });
  });

  it('deleting a line removes its record', async () => {
    const browser = await rememberingBrowser(COPPER, PARIS);

    expect((await browser.delete('/agent/memory/mem-copper')).status).toBe(204);

    expect(await (await browser.get('/agent/memory')).json()).toEqual({ lines: [PARIS] });
  });

  it('editing a line updates its record', async () => {
    const browser = await rememberingBrowser(COPPER, PARIS);

    expect((await put(browser, '/agent/memory/mem-paris', { text: 'Lives in London' })).status).toBe(204);
    expect((await put(browser, '/agent/memory/mem-copper', { text: 'Trades gold' })).status).toBe(204);

    expect(await (await browser.get('/agent/memory')).json()).toEqual({
      lines: [
        { id: 'mem-copper', text: 'Trades gold' },
        { id: 'mem-paris', text: 'Lives in London' },
      ],
    });
  });

  it('cannot edit or delete a line it does not have', async () => {
    const browser = await rememberingBrowser(PARIS);

    const edited = await put(browser, '/agent/memory/mem-copper', { text: 'Trades gold' });
    const deleted = await browser.delete('/agent/memory/mem-copper');

    expect([edited.status, deleted.status]).toEqual([404, 404]);
    expect(await deleted.json()).toEqual({ detail: 'Memory has no line mem-copper' });
  });

  it.each([{ text: '  ' }, { text: 7 }, {}])('refuses a line edited to %j', async (body) => {
    const browser = await rememberingBrowser(PARIS);

    const response = await put(browser, '/agent/memory/mem-paris', body);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'A Memory line must be non-blank text' });
    expect(await (await browser.get('/agent/memory')).json()).toEqual({ lines: [PARIS] });
  });
});
