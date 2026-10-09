import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { startInProcess } from '../test/in-process.js';

it.each(['Main', 'Side'])('continues ordinary registered HTTP Turns in a legacy %s Chat without replacing its identity or history', async (kind) => {
  const stack = await startInProcess();
  const documents = DynamoDBDocumentClient.from(stack.table.client);
  const sessionId = `legacy-${kind.toLowerCase()}`;
  const key = { pk: 'SESSIONS#account-1', sk: `SESSION#${sessionId}` };
  const messages = [{ id: 'old-message', role: 'user', content: 'Original visible history' }];
  try {
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: {
      ...key, session_id: sessionId, filing_user_id: 'original-filing-user', title: 'Original Chat',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', provider: 'openai',
    } }));
    if (kind === 'Main') await documents.send(new PutCommand({ TableName: stack.table.name, Item: {
      pk: 'SESSIONS#account-1', sk: 'MAIN', session_id: sessionId, filing_user_id: 'original-filing-user',
    } }));
    stack.sessionApi.reply(sessionId, 200, { messages });
    const path = kind === 'Main' ? '/main-chat' : `/threads/${sessionId}`;
    const before = await stack.app.request(path);
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ id: sessionId, messages });

    const turn = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: sessionId, runId: 'continuation-run', state: {}, messages: [{ id: 'new-message', role: 'user', content: 'Continue this Chat' }], tools: [], context: [], forwardedProps: {} }),
    });
    expect(turn.status).toBe(200);
    expect(await turn.text()).toContain('RUN_FINISHED');
    const invocation = stack.agentcore.invocationFor(sessionId);
    expect(invocation.payload).toMatchObject({ threadId: sessionId, forwardedProps: { sessionUserId: 'original-filing-user' } });
    expect(invocation.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toMatch(/^runtime-[0-9a-f-]{36}$/);
    const stored = await documents.send(new GetCommand({ TableName: stack.table.name, Key: key, ConsistentRead: true }));
    expect(stored.Item).toMatchObject({ session_id: sessionId, filing_user_id: 'original-filing-user', legacy_settlement_unproved: true, runtime_binding: invocation.headers['x-amzn-bedrock-agentcore-runtime-session-id'] });
    expect(stored.Item?.runtime_generation).toBe('continuation-v1');
    const warmed = await stack.app.request('/warmup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(kind === 'Main' ? { mainChat: true } : { threadId: sessionId }),
    });
    expect(warmed.status).toBe(200);
    expect(stack.agentcore.invocations().map((request) => request.headers['x-amzn-bedrock-agentcore-runtime-session-id'])).toEqual([stored.Item?.runtime_binding, stored.Item?.runtime_binding]);
    expect(await (await stack.app.request(path)).json()).toMatchObject({ id: sessionId, messages });
    expect(stack.sessionApi.events()).toContainEqual(expect.objectContaining({ operation: 'get', sessionId, userId: 'original-filing-user' }));
    if (kind === 'Main') {
      const main = await documents.send(new GetCommand({ TableName: stack.table.name, Key: { pk: key.pk, sk: 'MAIN' }, ConsistentRead: true }));
      expect(main.Item).toMatchObject({ session_id: sessionId, filing_user_id: 'original-filing-user' });
    }
    await expect(stack.history.delete('account-1')).rejects.toMatchObject({ status: 503, detail: expect.stringContaining('deletion remains pending') });
    expect(await stack.sessionMetadata.pendingPurges()).toContainEqual(expect.objectContaining({ session_id: sessionId, filing_user_id: 'original-filing-user', legacy_settlement_unproved: true }));
    expect(stack.sessionApi.events().filter(({ operation }) => operation === 'purge')).toEqual([]);
  } finally { await stack.stop(); }
});
