import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatAlarmEvents } from 'botcube-config/alarm-events';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { eventually } from '../test/eventually.js';
import { filed } from '../test/stock-bot.js';
import * as files from './files.js';

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess();
});
afterAll(() => stack.stop());

const forget = (app: InProcessStack['app'], owner: string) =>
  app.request('/agent/extracted-memory/forget', { method: 'POST', headers: { 'x-test-owner': owner } });

const OTHER_USERS_MEMORY = { id: 'memory-kept', text: 'Prefers coffee' };

it("starts forgetting the Extracted Memory of every User ID the User's Sessions were filed under, and no one else's", async () => {
  const owner = 'acct_forget';
  await stack.sessionMetadata.recordTurn(owner, 'older-session', { filingUserId: 'forget-older-user-id', title: 'Earlier', allocation: true });
  stack.sessionApi.memories.set(filed(owner), [{ id: 'memory-tea', text: 'Prefers tea' }]);
  stack.sessionApi.memories.set('forget-older-user-id', [{ id: 'memory-leeds', text: 'Lives in Leeds' }]);
  stack.sessionApi.memories.set('forget-someone-else', [OTHER_USERS_MEMORY]);

  const response = await forget(stack.app, owner);

  expect(response.status).toBe(202);
  await eventually(() => {
    expect(stack.sessionApi.events()).toEqual(expect.arrayContaining([
      { operation: 'forget', userId: filed(owner) },
      { operation: 'forget', userId: 'forget-older-user-id' },
    ]));
    expect(stack.sessionApi.memories.get(filed(owner))).toBeUndefined();
    expect(stack.sessionApi.memories.get('forget-older-user-id')).toBeUndefined();
  });
  expect(stack.sessionApi.memories.get('forget-someone-else')).toEqual([OTHER_USERS_MEMORY]);
});

it('forgets current and raw actor memory without Sessions and keeps Written Memory', async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), 'forget-written-memory-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const { accountFilesFromEnv } = files;
  const factory = vi.spyOn(files, 'accountFilesFromEnv')
    .mockImplementation((env, records, existing) => accountFilesFromEnv(env, records, existing, root));
  const app = await startInProcess({ env: {
    BOTCUBE_FILES_EFS_ARN: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0abc',
    BOTCUBE_FILES_SIGNING_KEY: 'test-key',
    BOTCUBE_FILES_MOUNT_ROLE_ARN: 'arn:aws:iam::123456789012:role/files-mount',
    BOTCUBE_FILES_MOUNT_TARGET_IP: '192.0.2.12',
  } }).finally(() => factory.mockRestore());
  onTestFinished(() => app.stop());
  const owner = 'acct_forget-no-sessions';
  const content = 'Keep this Written Memory.';
  const headers = { 'x-test-owner': owner, 'content-type': 'application/json' };
  expect((await app.app.request('/files/written-memory', {
    method: 'PUT', headers, body: JSON.stringify({ content }),
  })).status).toBe(204);
  app.sessionApi.memories.set(filed(owner), [{ id: 'current-memory', text: 'Prefers tea' }]);
  app.sessionApi.memories.set(owner, [{ id: 'raw-memory', text: 'Prefers coffee' }]);

  expect((await forget(app.app, owner)).status).toBe(202);

  await eventually(() => {
    expect(app.sessionApi.memories.has(filed(owner))).toBe(false);
    expect(app.sessionApi.memories.has(owner)).toBe(false);
  });
  const written = await app.app.request('/files/written-memory', { headers });
  expect(written.status).toBe(200);
  expect(await written.json()).toEqual({ content });
});

it('answers 202 before a failed deletion, and logs the alarm event', async () => {
  const owner = 'acct_forget-failed';
  stack.sessionApi.memories.set(filed(owner), [{ id: 'memory-tea', text: 'Prefers tea' }]);
  stack.sessionApi.refuseForget.add(filed(owner));
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect((await forget(stack.app, owner)).status).toBe(202);

    await eventually(() => expect(logged).toHaveBeenCalledWith(chatAlarmEvents.extractedMemoryForgetFailed, owner, expect.anything()));
    expect(stack.sessionApi.memories.get(filed(owner))).toEqual([{ id: 'memory-tea', text: 'Prefers tea' }]);
  } finally {
    logged.mockRestore();
    stack.sessionApi.refuseForget.clear();
  }
});

it('refuses a Guest before calling the session API', async () => {
  const guest = await startInProcess({ overrides: { requester: async () => ({ owner: 'acct_forget-guest', anonymous: true }) } });
  try {
    const response = await forget(guest.app, 'acct_forget-guest');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ detail: 'Sign in to use Forget' });
    expect(guest.sessionApi.events()).toEqual([]);
  } finally {
    await guest.stop();
  }
});

it('still forgets when the bot settings turn Extracted Memory off', async () => {
  const forgetful = await startInProcess({ overrides: { extractedMemory: false } });
  try {
    const owner = 'acct_forget-off';
    forgetful.sessionApi.memories.set(filed(owner), [{ id: 'memory-tea', text: 'Prefers tea' }]);

    expect((await forget(forgetful.app, owner)).status).toBe(202);

    await eventually(() => expect(forgetful.sessionApi.memories.get(filed(owner))).toBeUndefined());
  } finally {
    await forgetful.stop();
  }
});
