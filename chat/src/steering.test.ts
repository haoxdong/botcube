import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import { filed } from '../test/stock-bot.js';

it.each([true, false])('forwards owned steering without starting a Turn (accepted: %s)', async (accepted) => {
  const stack = await startInProcess();
  try {
    await stack.sessionMetadata.recordTurn('acct_account-1', 'steer-session', { filingUserId: filed('owner'), title: 'Steering', allocation: true });
    stack.agentcore.script('steer-session', { kind: 'stream', frames: [`data: ${JSON.stringify({ type: 'CUSTOM', name: 'STEERING_ACCEPTED', value: { accepted } })}`] });
    const response = await stack.app.request('/threads/steer-session/steer', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'message-1', content: 'Use another date' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted });
    expect(stack.agentcore.invocationFor('steer-session').payload).toMatchObject({
      messages: [{ id: 'message-1', role: 'user', content: 'Use another date' }],
      forwardedProps: { steering: true, sessionUserId: filed('owner') },
    });
    expect(await stack.sessionMetadata.get('acct_account-1', 'steer-session')).not.toHaveProperty('turn_running');
  } finally { await stack.stop(); }
});

it('logs a steering message that missed its Turn', async () => {
  const stack = await startInProcess();
  const info = vi.spyOn(console, 'info');
  try {
    await stack.sessionMetadata.recordTurn('acct_account-1', 'steer-session', { filingUserId: filed('owner'), title: 'Steering', allocation: true });
    stack.agentcore.script('steer-session', { kind: 'stream', frames: [`data: ${JSON.stringify({ type: 'CUSTOM', name: 'STEERING_ACCEPTED', value: { accepted: false } })}`] });
    await stack.app.request('/threads/steer-session/steer', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'message-1', content: 'Use another date' }),
    });
    expect(info.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('chat_steering_missed')).map((line) => JSON.parse(line) as unknown))
      .toEqual([{ event: 'chat_steering_missed', sessionId: 'steer-session', messageId: 'message-1' }]);
  } finally { info.mockRestore(); await stack.stop(); }
});

it('rejects another owner and malformed steering before dispatch', async () => {
  const stack = await startInProcess();
  try {
    await stack.sessionMetadata.recordTurn('acct_someone-else', 'private', { filingUserId: filed('other'), title: 'Private', allocation: true });
    const send = (body: unknown) => stack.app.request('/threads/private/steer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await send({ id: 'message', content: 'Steal context' })).status).toBe(404);
    expect((await send({ id: 'message', content: '' })).status).toBe(422);
    expect(stack.agentcore.invocations()).toHaveLength(0);
  } finally { await stack.stop(); }
});

it.each([true, false])('forwards an owned steering withdrawal and returns its receipt (withdrawn: %s)', async (withdrawn) => {
  const stack = await startInProcess();
  try {
    await stack.sessionMetadata.recordTurn('acct_account-1', 'steer-session', { filingUserId: filed('owner'), title: 'Steering', allocation: true });
    stack.agentcore.script('steer-session', { kind: 'stream', frames: [`data: ${JSON.stringify({ type: 'CUSTOM', name: 'STEERING_WITHDRAWN', value: { withdrawn } })}`] });
    const response = await stack.app.request('/threads/steer-session/steer/message-1', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ withdrawn });
    expect(stack.agentcore.invocationFor('steer-session').payload).toMatchObject({
      messages: [],
      forwardedProps: { withdrawSteering: 'message-1', sessionUserId: filed('owner') },
    });
  } finally { await stack.stop(); }
});

it('rejects withdrawing steering from another owner before dispatch', async () => {
  const stack = await startInProcess();
  try {
    await stack.sessionMetadata.recordTurn('acct_someone-else', 'private', { filingUserId: filed('other'), title: 'Private', allocation: true });
    expect((await stack.app.request('/threads/private/steer/message', { method: 'DELETE' })).status).toBe(404);
    expect(stack.agentcore.invocations()).toHaveLength(0);
  } finally { await stack.stop(); }
});
