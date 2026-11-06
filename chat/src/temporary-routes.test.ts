import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { expect, it, vi } from 'vitest';
import { startInProcess } from '../test/in-process.js';
import type { TemporaryChat } from './temporary-chat.js';

it('runs and stops a capability-owned temporary chat without a User or stored conversation', async () => {
  const requester = vi.fn(async () => { throw new Error('Temporary chat must not resolve a User'); });
  const stack = await startInProcess({ config: { temporaryChatSecret: 'test-signing-secret' }, cartridge: { requester } });
  try {
    const response = await stack.app.request('/temporary-chats', { method: 'POST' });
    expect(response.status).toBe(200);
    const chat = await response.json() as TemporaryChat;
    const headers = { 'content-type': 'application/json', 'x-botcube-temporary-chat': chat.token };
    const input = { threadId: chat.sessionId, runId: 'turn-1', state: {}, context: [], tools: [],
      messages: [{ id: 'question', role: 'user', content: 'Hello' }], forwardedProps: { sessionUserId: 'forged-user', model: 'quick' } };
    const answer = await stack.app.request('/', { method: 'POST', headers, body: JSON.stringify(input) });
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain('RUN_FINISHED');
    const invoked = stack.agentcore.invocationFor(chat.sessionId).payload;
    expect(invoked.forwardedProps).toEqual({ temporary: true, model: 'quick', agentIdentity: { name: 'Test Bot', character: 'A test agent', vibe: 'Plain', avatar: '' }, soul: 'Be brief.' });
    expect((await stack.app.request(`/threads/${chat.sessionId}/stop`, { method: 'POST', headers, body: JSON.stringify({ runId: 'turn-1' }) })).status).toBe(204);
    expect((await stack.app.request('/', { method: 'POST', headers, body: JSON.stringify({ ...input, threadId: 'not-owned' }) })).status).toBe(401);
    expect((await stack.app.request('/', { method: 'POST', headers: { ...headers, 'x-botcube-temporary-chat': 'forged' }, body: JSON.stringify(input) })).status).toBe(401);
    expect(requester).not.toHaveBeenCalled();
    const rows = await DynamoDBDocumentClient.from(stack.table.client).send(new ScanCommand({ TableName: stack.table.name }));
    expect(rows.Items).toEqual([]);
    expect(stack.bedrock.requests).toEqual([]);
  } finally { await stack.stop(); }
});

it('refuses plan models for a temporary chat', async () => {
  const stack = await startInProcess({ config: { temporaryChatSecret: 'test-signing-secret' } });
  try {
    const chat = await (await stack.app.request('/temporary-chats', { method: 'POST' })).json() as TemporaryChat;
    const answer = await stack.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-botcube-temporary-chat': chat.token },
      body: JSON.stringify({ threadId: chat.sessionId, runId: 'turn-1', state: {}, context: [], tools: [], messages: [], forwardedProps: { model: 'plan' } }) });
    expect(answer.status).toBe(422);
    expect(stack.agentcore.invocations()).toEqual([]);
  } finally { await stack.stop(); }
});

it('does not let a durable Turn select temporary mode through forwarded props', async () => {
  const stack = await startInProcess({ config: { temporaryChatSecret: 'test-signing-secret' } });
  try {
    await stack.allocate('account-1', 'durable-chat');
    const answer = await stack.app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'durable-chat', runId: 'turn-1', state: {}, context: [], tools: [],
        messages: [{ id: 'question', role: 'user', content: 'Hello' }], forwardedProps: { temporary: true } }) });
    expect(answer.status).toBe(200);
    await answer.text();
    expect(stack.agentcore.invocationFor('durable-chat').payload.forwardedProps).not.toHaveProperty('temporary');
    expect(await stack.sessionMetadata.get('account-1', 'durable-chat')).not.toBeNull();
  } finally { await stack.stop(); }
});
