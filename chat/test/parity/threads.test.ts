import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from './browser.js';
import { startStack, type Stack } from './stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

interface ThreadSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  turn_completed_at?: string;
}

const filingUserId = (accountId: string) => accountId;

async function chattingBrowser(): Promise<{ browser: Browser; accountId: string }> {
  const browser = stack.browser();
  const { accountId } = await browser.openAccountSession();
  return { browser, accountId };
}

async function chatAbout(browser: Browser, topic: string): Promise<string> {
  const threadId = await browser.newSideChat();
  const response = await browser.sendTurn(threadId, { text: `about ${topic}` });
  expect(response.status).toBe(200);
  await response.text();
  return threadId;
}

async function threadIds(browser: Browser): Promise<string[]> {
  const response = await browser.get('/threads');
  expect(response.status).toBe(200);
  const { threads } = (await response.json()) as { threads: ThreadSummary[] };
  return threads.map(({ id }) => id);
}

describe('GET /threads', () => {
  it('lists the account\'s Sessions, most recent activity first', async () => {
    const { browser } = await chattingBrowser();
    const older = await chatAbout(browser, 'list-older');
    const newer = await chatAbout(browser, 'list-newer');
    await (await browser.sendTurn(older, { text: 'a follow-up' })).text();

    const response = await browser.get('/threads');

    const { threads } = (await response.json()) as { threads: ThreadSummary[] };
    expect(threads).toEqual([
      {
        id: older,
        title: 'about list-older',
        turn_completed_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        created_at: expect.any(String),
        updated_at: expect.any(String),
      },
      {
        id: newer,
        title: 'about list-newer',
        turn_completed_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        created_at: expect.any(String),
        updated_at: expect.any(String),
      },
    ]);
  });

  it('keeps each account\'s Sessions to itself', async () => {
    const first = await chattingBrowser();
    const firstId = await chatAbout(first.browser, 'isolated-first');
    const second = await chattingBrowser();
    const secondId = await chatAbout(second.browser, 'isolated-second');

    expect(await threadIds(first.browser)).toEqual([firstId]);
    expect(await threadIds(second.browser)).toEqual([secondId]);
  });

  it('refuses a request without a Account', async () => {
    const response = await stack.browser().get('/threads');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: 'Missing template account cookie' });
  });
});

describe('GET /threads/{id}', () => {
  it('replays the Session\'s messages from the session API under its filing user', async () => {
    const { browser, accountId } = await chattingBrowser();
    const replayed = await chatAbout(browser, 'replayed');
    const messages = [
      { id: 'm1', role: 'user', content: 'about replayed' },
      { id: 'm2', role: 'assistant', content: 'an answer' },
    ];
    stack.sessionApi.reply(replayed, 200, { messages });

    const response = await browser.get(`/threads/${replayed}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: replayed,
      title: 'about replayed',
      turn_completed_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      provider: 'echo',
      created_at: expect.any(String),
      updated_at: expect.any(String),
      messages,
      running: false,
    });
    expect(stack.sessionApi.events()).toContainEqual({
      operation: 'get',
      sessionId: replayed,
      userId: filingUserId(accountId),
    });
  });

  it('does not reveal a Session the account does not own', async () => {
    const someoneElses = await chatAbout((await chattingBrowser()).browser, 'someone-elses');
    const { browser } = await chattingBrowser();

    const response = await browser.get(`/threads/${someoneElses}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: 'Session not found' });
  });

  it('passes a session API 404 through', async () => {
    const { browser } = await chattingBrowser();
    const eventsGone = await chatAbout(browser, 'events-gone');
    stack.sessionApi.reply(eventsGone, 404, { error: 'No events for the Session' });

    const response = await browser.get(`/threads/${eventsGone}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: 'No events for the Session' });
  });

  it('maps any other session API failure to 503', async () => {
    const { browser } = await chattingBrowser();
    const broken = await chatAbout(browser, 'session-api-broken');
    stack.sessionApi.reply(broken, 500, { error: 'boom' });

    const response = await browser.get(`/threads/${broken}`);

    expect(response.status).toBe(503);
  });
});

describe('DELETE /threads/{id}', () => {
  it('removes the Session at once and purges its events in the background', async () => {
    const { browser, accountId } = await chattingBrowser();
    const deleted = await chatAbout(browser, 'deleted');
    const kept = await chatAbout(browser, 'kept');

    const response = await browser.delete(`/threads/${deleted}`);

    expect(response.status).toBe(204);
    expect(await threadIds(browser)).toEqual([kept]);
    expect((await browser.get(`/threads/${deleted}`)).status).toBe(404);
    await expect
      .poll(() => stack.sessionApi.events(), { timeout: 10_000 })
      .toContainEqual({ operation: 'purge', sessionId: deleted, userId: filingUserId(accountId) });
  });

  it('refuses a new Turn in a deleted Session', async () => {
    const { browser } = await chattingBrowser();
    const deletedThenContinued = await chatAbout(browser, 'deleted-then-continued');
    await browser.delete(`/threads/${deletedThenContinued}`);

    const response = await browser.sendTurn(deletedThenContinued);

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ detail: 'The Session was deleted' });
  });

  it('leaves another account\'s Session untouched', async () => {
    const owner = await chattingBrowser();
    const notYours = await chatAbout(owner.browser, 'not-yours-to-delete');
    const { browser: intruder } = await chattingBrowser();

    const response = await intruder.delete(`/threads/${notYours}`);

    expect(response.status).toBe(204);
    expect(await threadIds(owner.browser)).toEqual([notYours]);
    expect((await owner.browser.get(`/threads/${notYours}`)).status).toBe(200);
  });
});

describe('PATCH /threads/{id}', () => {
  const rename = (browser: Browser, threadId: string, title: string) => browser.request(`/threads/${threadId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });

  it('renames the Side Chat for its owner only', async () => {
    const owner = await chattingBrowser();
    const renamedForOwner = await chatAbout(owner.browser, 'renamed-for-owner');
    const { browser: intruder } = await chattingBrowser();

    const refused = await rename(intruder, renamedForOwner, 'Not yours');
    const renamed = await rename(owner.browser, renamedForOwner, 'Rates desk');

    expect(refused.status).toBe(404);
    expect(renamed.status).toBe(200);
    const { threads } = (await (await owner.browser.get('/threads')).json()) as { threads: ThreadSummary[] };
    expect(threads.map(({ id, title }) => [id, title])).toEqual([[renamedForOwner, 'Rates desk']]);
  });
});
