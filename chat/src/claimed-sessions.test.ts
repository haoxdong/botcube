import { afterEach, expect, it } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

// ADR 0076
let stack: InProcessStack | undefined;
afterEach(async () => { await stack?.stop(); });

async function claimed() {
  stack = await startInProcess();
  await stack.sessionMetadata.recordTurn('guest', 'claimed', { filingUserId: 'filed-guest', title: 'claimed', provider: 'anthropic', allocation: true });
  await stack.history.transfer('guest', 'saved');
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

  expect(await sideChats(running, 'saved')).toEqual(['claimed']);
  const refused = await send(running, 'guest', 'claimed');
  expect([refused.status, await refused.json()]).toEqual([409, { detail: 'Account Claim is in progress. Finish signing in and retry.' }]);
  const turn = await send(running, 'saved', 'claimed');
  expect(turn.status).toBe(200);
  await turn.text();
  expect(running.agentcore.invocationFor('claimed').payload.forwardedProps.sessionUserId).toBe('filed-guest');
});

it('purges a deleted claimed Session under its filing ID and the saved User one', async () => {
  const running = await claimed();

  expect((await running.app.request('/threads/claimed', { method: 'DELETE', headers: { 'x-test-owner': 'saved' } })).status).toBe(204);

  expect(await sideChats(running, 'saved')).toEqual([]);
  await expect.poll(() => running.sessionApi.events().filter(({ operation }) => operation === 'purge'), { timeout: 2_000 }).toEqual([
    expect.objectContaining({ sessionId: 'claimed', userId: 'filed-guest' }),
    expect.objectContaining({ sessionId: 'claimed', userId: 'filed-saved' }),
  ]);
});
