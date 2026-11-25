import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from './browser.js';
import { uploadFileLink } from './file-links.js';
import { startStack, type Stack } from './stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const WRITTEN_MEMORY = 'memories/AGENTS.md';

const panel = async (user: Browser) => {
  const response = await user.get('/files/written-memory');
  expect(response.status).toBe(200);
  return ((await response.json()) as { content: string }).content;
};

const saveInPanel = (user: Browser, content: unknown) =>
  user.request('/files/written-memory', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });

async function downloadFromFiles(user: Browser, name: string): Promise<string> {
  const response = await user.get(`/files/download-url?name=${encodeURIComponent(name)}`);
  expect(response.status).toBe(200);
  return (await fetch(((await response.json()) as { url: string }).url)).text();
}

/** Replaces a file from the Files app, which deletes it and uploads the new one. */
async function replaceInFiles(user: Browser, name: string, body: string): Promise<void> {
  expect((await user.request(`/files?name=${encodeURIComponent(name)}`, { method: 'DELETE' })).status).toBe(204);
  const response = await user.post('/files/upload-url', { name });
  expect(response.status).toBe(200);
  await uploadFileLink(((await response.json()) as { url: string }).url, body);
}

describe("a signed-in User's Memory panel", () => {
  it('starts empty for a new User', async () => {
    const user = await stack.signedInBrowser();

    expect(await panel(user)).toBe('');
  });

  it('saves Written Memory as memories/AGENTS.md in Files', async () => {
    const user = await stack.signedInBrowser();

    expect((await saveInPanel(user, '- Prefers jasmine tea\n')).status).toBe(204);

    expect(await panel(user)).toBe('- Prefers jasmine tea\n');
    expect(((await (await user.get('/files')).json()) as { files: { name: string }[] }).files.map(({ name }) => name)).toEqual([WRITTEN_MEMORY]);
    expect(await downloadFromFiles(user, WRITTEN_MEMORY)).toBe('- Prefers jasmine tea\n');
  });

  it('shows an edit made in Files, and its own next save replaces it', async () => {
    const user = await stack.signedInBrowser();
    await saveInPanel(user, '- Lives in Paris\n');

    await replaceInFiles(user, WRITTEN_MEMORY, '- Lives in London\n');

    expect(await panel(user)).toBe('- Lives in London\n');
    expect((await saveInPanel(user, '- Lives in Lisbon\n')).status).toBe(204);
    expect(await downloadFromFiles(user, WRITTEN_MEMORY)).toBe('- Lives in Lisbon\n');
  });

  it("never shows another User's Written Memory", async () => {
    const ada = await stack.signedInBrowser();
    const grace = await stack.signedInBrowser();

    await saveInPanel(ada, '- Ada only\n');

    expect(await panel(grace)).toBe('');
  });

  it.each([{ content: 7 }, {}])('refuses a save of %j', async (body) => {
    const user = await stack.signedInBrowser();

    const response = await user.request('/files/written-memory', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'Written Memory must be text' });
  });
});

it('a Guest keeps no Written Memory', async () => {
  const guest = stack.browser();
  await guest.openAccountSession();

  const read = await guest.get('/files/written-memory');
  const saved = await saveInPanel(guest, '- Prefers tea\n');

  expect([read.status, saved.status]).toEqual([403, 403]);
  expect(await saved.json()).toEqual({ detail: 'Sign in to keep Written Memory' });
});

describe('a bot whose settings turn Written Memory off', () => {
  let forgetful: Stack;
  beforeAll(async () => {
    forgetful = await startStack({ bot: { writtenMemory: { enabled: false } } });
  });
  afterAll(() => forgetful.stop());

  it('has no Memory panel route', async () => {
    const user = await forgetful.signedInBrowser();

    const read = await user.get('/files/written-memory');
    const saved = await saveInPanel(user, '- Prefers tea\n');

    expect([read.status, saved.status]).toEqual([404, 404]);
    expect(await read.json()).toEqual({ detail: 'Written Memory is off for this bot' });
  });
});
