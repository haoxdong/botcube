import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from './browser.js';
import { startStack, type Stack } from './stack.js';

interface FileEntry {
  name: string;
  size: number;
  lastModified: string;
}

async function files(user: Browser): Promise<string[]> {
  const response = await user.get('/files');
  expect(response.status).toBe(200);
  return ((await response.json()) as { files: FileEntry[] }).files.map(({ name }) => name);
}

async function download(user: Browser, name: string): Promise<string> {
  const response = await user.get(`/files/download-url?name=${encodeURIComponent(name)}`);
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  const file = await fetch(url);
  expect(file.status).toBe(200);
  return file.text();
}

async function upload(user: Browser, name: string, body: string): Promise<void> {
  const response = await user.post('/files/upload-url', { name });
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  expect((await fetch(url, { method: 'PUT', headers: { 'if-none-match': '*' }, body })).status).toBe(200);
}

/** The account's directory in the Files bucket: the first 32 hex digits of its ID's SHA-256. */
const prefixOf = (accountId: string) => `accounts/${createHash('sha256').update(accountId).digest('hex').slice(0, 32)}/`;

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

describe('Files', () => {

  it('refuses an existing upload name with 409 and preserves its bytes', async () => {
    const user = stack.browser();
    await user.openAccountSession();
    await upload(user, 'notes/plan.txt', 'original');

    const response = await user.post('/files/upload-url', { name: 'notes/plan.txt' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: 'A file named notes/plan.txt is already in Files' });
    expect(await download(user, 'notes/plan.txt')).toBe('original');
    const other = stack.browser();
    await other.openAccountSession();
    await upload(other, 'notes/plan.txt', 'other account');
    expect(await download(other, 'notes/plan.txt')).toBe('other account');
  });

  it('refuses the second of two uploads signed before either writes', async () => {
    const user = stack.browser();
    await user.openAccountSession();
    const first = await user.post('/files/upload-url', { name: 'race.txt' });
    const second = await user.post('/files/upload-url', { name: 'race.txt' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const { url: firstUrl } = (await first.json()) as { url: string };
    const { url: secondUrl } = (await second.json()) as { url: string };
    expect(new URL(firstUrl).searchParams.get('X-Amz-SignedHeaders')).toBe('host;if-none-match');
    const headers = { 'if-none-match': '*' };

    expect((await fetch(firstUrl, { method: 'PUT', headers, body: 'original' })).status).toBe(200);
    expect((await fetch(secondUrl, { method: 'PUT', headers, body: 'replacement' })).status).toBe(412);
    expect(await download(user, 'race.txt')).toBe('original');
  });

  it('answers 422 for an upload without a name', async () => {
    const user = stack.browser();
    await user.openAccountSession();

    const response = await user.post('/files/upload-url', {});

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'name is required' });
  });
});

describe('deleting a file', () => {
  it('answers 204 and leaves no version or delete marker of it, and keeps the files beside it', async () => {
    const user = stack.browser();
    const { accountId } = await user.openAccountSession();
    await upload(user, 'notes/plan.txt', 'buy low');
    await stack.s3.putObject(stack.s3files.bucket, `${prefixOf(accountId)}notes/plan.txt`, 'sell high');
    await upload(user, 'notes/plan.txt.old', 'hold');

    const response = await user.delete(`/files?name=${encodeURIComponent('notes/plan.txt')}`);

    expect(response.status).toBe(204);
    expect(await files(user)).toEqual(['notes/plan.txt.old']);
    expect(await stack.s3.versions(stack.s3files.bucket, prefixOf(accountId))).toEqual([
      `Version ${prefixOf(accountId)}notes/plan.txt.old`,
    ]);
  });

  it('answers 404 for a file that is not there, and 400 for a name outside Files', async () => {
    const user = stack.browser();
    await user.openAccountSession();

    const missing = await user.delete('/files?name=missing.csv');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: 'No file missing.csv in Files' });
    for (const name of ['', '../private.pdf', './private.pdf', 'a//b', 'a/../b']) {
      // eslint-disable-next-line no-await-in-loop -- one name at a time
      const response = await user.delete(`/files?name=${encodeURIComponent(name)}`);
      expect(response.status).toBe(400);
      // eslint-disable-next-line no-await-in-loop -- one name at a time
      expect(await response.json()).toEqual({ detail: 'name must be a path inside Files' });
    }
  });

  it("can't delete another account's file", async () => {
    const owner = stack.browser();
    await owner.openAccountSession();
    const other = stack.browser();
    await other.openAccountSession();
    await upload(owner, 'private.pdf', 'mine');

    expect((await other.delete('/files?name=private.pdf')).status).toBe(404);

    expect(await files(owner)).toEqual(['private.pdf']);
    expect(await download(owner, 'private.pdf')).toBe('mine');
  });
});

describe('renaming a file', () => {
  it('answers 200 with the new name, moves the bytes, and frees the old name of every version', async () => {
    const user = stack.browser();
    const { accountId } = await user.openAccountSession();
    await upload(user, 'dummy (1).pdf', 'draft');
    await stack.s3.putObject(stack.s3files.bucket, `${prefixOf(accountId)}dummy (1).pdf`, '%PDF-1.4\n');

    const response = await user.post('/files/rename', { from: 'dummy (1).pdf', to: 'statement.pdf' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'statement.pdf' });
    expect(await files(user)).toEqual(['statement.pdf']);
    expect(await download(user, 'statement.pdf')).toBe('%PDF-1.4\n');
    expect(await stack.s3.versions(stack.s3files.bucket, prefixOf(accountId))).toEqual([`Version ${prefixOf(accountId)}statement.pdf`]);
  });

  it('answers 404 for a file that is not there', async () => {
    const user = stack.browser();
    await user.openAccountSession();

    const response = await user.post('/files/rename', { from: 'missing.csv', to: 'found.csv' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: 'No file missing.csv in Files' });
    expect(await files(user)).toEqual([]);
  });

  it('answers 409 for a name already taken, and leaves both files as they were', async () => {
    const user = stack.browser();
    await user.openAccountSession();
    await upload(user, 'report.csv', 'new');
    await upload(user, 'report (1).csv', 'old');

    const response = await user.post('/files/rename', { from: 'report (1).csv', to: 'report.csv' });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ detail: 'A file named report.csv is already in Files' });
    expect((await files(user)).sort()).toEqual(['report (1).csv', 'report.csv']);
    expect(await download(user, 'report.csv')).toBe('new');
    expect(await download(user, 'report (1).csv')).toBe('old');
  });

  it('answers 400 for an empty name, or one with a `.` or `..` segment, and leaves the file', async () => {
    const user = stack.browser();
    await user.openAccountSession();
    await upload(user, 'notes/plan.txt', 'buy low');

    for (const [from, to] of [
      ['notes/plan.txt', ''],
      ['notes/plan.txt', 'notes/.'],
      ['notes/plan.txt', 'notes/..'],
      ['notes/plan.txt', '../plan.txt'],
      ['', 'plan.txt'],
      ['notes/../notes/plan.txt', 'plan.txt'],
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one name at a time
      const response = await user.post('/files/rename', { from, to });
      expect(response.status).toBe(400);
      // eslint-disable-next-line no-await-in-loop -- one name at a time
      expect(await response.json()).toEqual({ detail: 'name must be a path inside Files' });
    }
    expect(await files(user)).toEqual(['notes/plan.txt']);
  });

  it("can't rename another account's file", async () => {
    const owner = stack.browser();
    await owner.openAccountSession();
    const other = stack.browser();
    await other.openAccountSession();
    await upload(owner, 'private.pdf', 'mine');

    expect((await other.post('/files/rename', { from: 'private.pdf', to: 'taken.pdf' })).status).toBe(404);

    expect(await files(owner)).toEqual(['private.pdf']);
    expect(await download(owner, 'private.pdf')).toBe('mine');
    expect(await files(other)).toEqual([]);
  });

  it('keeps a file renamed inside a folder in that folder, beside the files there', async () => {
    const user = stack.browser();
    await user.openAccountSession();
    await upload(user, 'notes/plan.txt', 'buy low');
    await upload(user, 'notes/todo.txt', 'call');

    const response = await user.post('/files/rename', { from: 'notes/plan.txt', to: 'notes/strategy.txt' });

    expect(await response.json()).toEqual({ name: 'notes/strategy.txt' });
    expect((await files(user)).sort()).toEqual(['notes/strategy.txt', 'notes/todo.txt']);
    expect(await download(user, 'notes/strategy.txt')).toBe('buy low');
  });

  it('answers 422 without both names', async () => {
    const user = stack.browser();
    await user.openAccountSession();

    const response = await user.post('/files/rename', { from: 'plan.txt' });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'from and to are required' });
  });
});

describe("the agent's Files on each Turn", () => {
  it("hands each Turn the account's Files prefix with credentials for it, so files the agent puts there show in Files", async () => {
    const user = stack.browser();
    const { accountId } = await user.openAccountSession();

    const threadId = await user.newSideChat();
    await (await user.sendTurn(threadId)).text();

    const { files: binding } = stack.agentcore.invocationFor(threadId).payload.forwardedProps as { files: unknown };
    expect(binding).toEqual({
      bucket: stack.s3files.bucket,
      prefix: prefixOf(accountId),
      region: 'us-east-1',
      accessKeyId: expect.stringMatching(/^ASIA/),
      secretAccessKey: expect.stringMatching(/.{20,}/),
      sessionToken: expect.stringMatching(/.{20,}/),
      expiration: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
    });
    await stack.s3.putObject(stack.s3files.bucket, `${prefixOf(accountId)}analysis/report.csv`, 'date,close');
    expect(await files(user)).toEqual(['analysis/report.csv']);
  });

  it("replaces a Files binding the client sends with the account's own", async () => {
    const user = stack.browser();
    const { accountId } = await user.openAccountSession();

    const threadId = await user.newSideChat();
    await (
      await user.sendTurn(threadId, {
        forwardedProps: { files: { bucket: 'elsewhere', prefix: 'accounts/someone-else/', region: 'us-east-1' } },
      })
    ).text();

    const { files: binding } = stack.agentcore.invocationFor(threadId).payload.forwardedProps as {
      files: { bucket: string; prefix: string };
    };
    expect([binding.bucket, binding.prefix]).toEqual([stack.s3files.bucket, prefixOf(accountId)]);
  });
});
