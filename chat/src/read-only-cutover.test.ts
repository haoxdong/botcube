import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess({ cartridge: { requester: async (c) => ({ owner: defined(c.req.header('x-account'), 'an x-account header') }) } });
});
afterAll(() => stack.stop());

const documents = () => DynamoDBDocumentClient.from(stack.table.client);
const as = (account: string, path: string, method = 'GET') => stack.app.request(path, { method, headers: { 'x-account': account } });
const post = (account: string, path: string, body: unknown) => stack.app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-account': account }, body: JSON.stringify(body),
});
const turn = (account: string, threadId: string) => post(account, '/', {
  threadId, runId: 'run-1', state: {}, messages: [{ id: 'm1', role: 'user', content: 'Continue this Chat' }], tools: [], context: [], forwardedProps: {},
});

async function preCutoverChat(account: string, sessionId: string, main = false): Promise<void> {
  const binding = { filing_user_id: `filed-${account}`, runtime_binding: 'runtime-00000000-0000-4000-8000-000000000000', runtime_generation: 'tracked-v1', read_only: true };
  await documents().send(new PutCommand({ TableName: stack.table.name, Item: {
    pk: `SESSIONS#${account}`, sk: `SESSION#${sessionId}`, session_id: sessionId, ...binding,
    title: 'Before the cutover', created_at: '2026-10-01T00:00:00.000000+00:00', updated_at: '2026-10-01T00:00:00.000000+00:00', provider: 'openai',
  } }));
  if (main) await documents().send(new PutCommand({ TableName: stack.table.name, Item: { pk: `SESSIONS#${account}`, sk: 'MAIN', session_id: sessionId, ...binding } }));
  stack.sessionApi.reply(sessionId, 200, { messages: [{ id: 'old', role: 'user', content: 'Original history' }] });
}

const invokedFor = (sessionId: string) => stack.agentcore.invocations()
  .filter((request) => (JSON.parse(request.body) as { threadId?: string }).threadId === sessionId || request.headers[SESSION_HEADER] === sessionId);

describe('chats from before the one-ID cutover', () => {
  it('replay their history but refuse a Turn and a warmup without starting a Sandbox', async () => {
    const sessionId = '3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f8a9b0c';
    await preCutoverChat('reader', sessionId);

    const replay = await as('reader', `/threads/${sessionId}`);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: sessionId, readOnly: true, messages: [{ id: 'old', content: 'Original history' }] });

    const refused = await turn('reader', sessionId);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'SESSION_READ_ONLY' });
    expect((await post('reader', '/warmup', { threadId: sessionId })).status).toBe(409);
    expect(invokedFor(sessionId)).toEqual([]);
  });

  it('start no Sandbox for a Stop or a steering message while no Turn runs', async () => {
    const sessionId = '5b2d3c4e-6f70-4a81-9b2c-3d4e5f607182';
    await preCutoverChat('idle-reader', sessionId);

    const stop = await post('idle-reader', `/threads/${sessionId}/stop`, { runId: 'run-1' });
    const steer = await post('idle-reader', `/threads/${sessionId}/steer`, { id: 'steer-1', content: 'Also this' });

    expect([stop.status, steer.status]).toEqual([409, 409]);
    expect(invokedFor(sessionId)).toEqual([]);
  });

  it('tell a client a chat the server issued is not read-only', async () => {
    const { id } = await (await as('writer', '/threads', 'POST')).json() as { id: string };
    stack.sessionApi.reply(id, 200, { messages: [] });

    const replay = await (await as('writer', `/threads/${id}`)).json() as Record<string, unknown>;

    expect(replay).toMatchObject({ id });
    expect(replay).not.toHaveProperty('readOnly');
  });

  it('follow the migrated read_only marker, whatever the binding says', async () => {
    const { id } = await (await as('marked', '/threads', 'POST')).json() as { id: string };
    stack.sessionApi.reply(id, 200, { messages: [] });
    await documents().send(new UpdateCommand({ TableName: stack.table.name, Key: { pk: 'SESSIONS#marked', sk: `SESSION#${id}` }, UpdateExpression: 'SET read_only = :marked', ExpressionAttributeValues: { ':marked': true } }));

    expect(await (await as('marked', `/threads/${id}`)).json()).toMatchObject({ id, readOnly: true });
    const refused = await turn('marked', id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'SESSION_READ_ONLY' });
    expect(invokedFor(id)).toEqual([]);
  });

  it('cannot be created by a client naming a new ID', async () => {
    const response = await turn('inventor', 'a-client-chosen-id');

    expect(response.status).toBe(404);
    expect(invokedFor('a-client-chosen-id')).toEqual([]);
  });

  it('move the Main Chat to a new Session, keeping the old one readable in the chat list', async () => {
    const old = '7c0e9d1a-2b3c-4d5e-8f60-718293a4b5c6';
    await preCutoverChat('main-mover', old, true);

    const landed = await as('main-mover', '/main-chat');
    expect(landed.status).toBe(200);
    const { id } = await landed.json() as { id: string };
    expect(id).toMatch(UUID);
    expect(id).not.toBe(old);
    expect((await documents().send(new GetCommand({ TableName: stack.table.name, Key: { pk: 'SESSIONS#main-mover', sk: 'MAIN' }, ConsistentRead: true }))).Item)
      .toMatchObject({ session_id: id, previous_session_id: old });
    expect((await (await as('main-mover', '/main-chat')).json() as { id: string }).id).toBe(id);

    const { threads } = await (await as('main-mover', '/threads')).json() as { threads: { id: string }[] };
    expect(threads.map((thread) => thread.id)).toContain(old);
    expect((await as('main-mover', `/threads/${old}`)).status).toBe(200);

    const response = await turn('main-mover', id);
    expect(response.status).toBe(200);
    await response.text();
    expect(stack.agentcore.invocationFor(id).headers[SESSION_HEADER]).toBe(id);
  });
});
