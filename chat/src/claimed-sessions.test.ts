import { afterEach, expect, it } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { filed } from '../test/stock-bot.js';

// ADR 0076
let stack: InProcessStack | undefined;
afterEach(async () => { await stack?.stop(); });

async function claimed() {
  stack = await startInProcess({ stock: true });
  await stack.sessionMetadata.recordTurn('acct_guest-account', 'claimed', { filingUserId: filed('acct_guest-account'), title: 'claimed', provider: 'anthropic', allocation: true });
  await stack.history.transfer('acct_guest-account', 'acct_saved-account');
  return stack;
}

function send(running: InProcessStack, owner: string, sessionId: string) {
  return running.app.request('/', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': owner },
    body: JSON.stringify({ threadId: sessionId, runId: `run-${owner}`, state: {}, messages: [{ id: `message-${owner}`, role: 'user', content: 'Hello again' }], tools: [], context: [], forwardedProps: { model: 'quick' } }),
  });
}

async function sideChats(running: InProcessStack, owner: string): Promise<string[]> {
  const response = await running.app.request('/threads', { headers: { 'x-test-owner': owner } });
  return ((await response.json()) as { threads: { id: string }[] }).threads.map(({ id }) => id);
}

it('lists a claimed Session for the saved User, and continues it under its original filing ID', async () => {
  const running = await claimed();

  expect(await sideChats(running, 'acct_saved-account')).toEqual(['claimed']);
  const refused = await send(running, 'acct_guest-account', 'claimed');
  expect([refused.status, await refused.json()]).toEqual([409, { detail: 'Account Claim is in progress. Finish signing in and retry.' }]);
  const turn = await send(running, 'acct_saved-account', 'claimed');
  expect(turn.status).toBe(200);
  await turn.text();
  expect(running.agentcore.invocationFor('claimed').payload.forwardedProps.sessionUserId).toBe(filed('acct_guest-account'));
});

it('purges a deleted claimed Session under its filing ID and the saved User one', async () => {
  const running = await claimed();

  expect((await running.app.request('/threads/claimed', { method: 'DELETE', headers: { 'x-test-owner': 'acct_saved-account' } })).status).toBe(204);

  expect(await sideChats(running, 'acct_saved-account')).toEqual([]);
  await expect.poll(() => running.sessionApi.events().filter(({ operation }) => operation === 'purge'), { timeout: 2_000 }).toEqual([
    expect.objectContaining({ sessionId: 'claimed', userId: filed('acct_guest-account') }),
    expect.objectContaining({ sessionId: 'claimed', userId: filed('acct_saved-account') }),
  ]);
});
