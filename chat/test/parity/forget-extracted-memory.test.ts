import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from './browser.js';
import { filingUserId } from '../../src/filing-user-id.js';
import { eventually } from '../eventually.js';
import { PARITY_BOT, startStack, type Stack } from './stack.js';

let stack: Stack;
beforeAll(async () => {
  stack = await startStack();
});
afterAll(() => stack.stop());

const WRITTEN_MEMORY = '- Prefers jasmine tea\n- Lives in Paris\n';

const writtenMemory = async (user: Browser) => {
  const response = await user.get('/files/written-memory');
  expect(response.status).toBe(200);
  return ((await response.json()) as { content: string }).content;
};

it("Forget deletes the User's Extracted Memory and leaves Written Memory as it was", async () => {
  const user = await stack.signedInBrowser();
  const { accountId } = await user.openAccountSession();
  const saved = await user.request('/files/written-memory', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: WRITTEN_MEMORY }),
  });
  expect(saved.status).toBe(204);
  expect(await writtenMemory(user)).toBe(WRITTEN_MEMORY);
  const userId = filingUserId(PARITY_BOT.accountKey, accountId);
  stack.sessionApi.memories.set(userId, [{ id: 'mem-copper', text: 'Trades copper futures' }]);

  const response = await user.post('/agent/extracted-memory/forget', {});

  expect(response.status).toBe(202);
  await eventually(() => {
    expect(stack.sessionApi.events()).toContainEqual({ operation: 'forget', userId });
    expect(stack.sessionApi.memories.get(userId)).toBeUndefined();
  });
  expect(await writtenMemory(user)).toBe(WRITTEN_MEMORY);
});
