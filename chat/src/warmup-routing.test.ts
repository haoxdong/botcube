import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { defined } from '../test/defined.js';

// A runtime session is one microVM, so a warmup only helps the Turn that reuses its session ID.
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess({ cartridge: { requester: async (c) => ({ owner: defined(c.req.header('x-account'), 'an x-account header') }) } });
});
afterAll(() => stack.stop());

const as = (account: string, path: string, method = 'GET') => stack.app.request(path, { method, headers: { 'x-account': account } });
const post = (account: string, path: string, body: unknown) => stack.app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-account': account }, body: JSON.stringify(body),
});
const turn = async (account: string, threadId: string, runId: string) => {
  const response = await post(account, '/', {
    threadId, runId, state: {}, messages: [{ id: runId, role: 'user', content: 'hello' }], tools: [], context: [], forwardedProps: {},
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('RUN_FINISHED');
};

const sandboxes = (threadId: string) => stack.agentcore.invocations()
  .map((request) => ({ session: request.headers[SESSION_HEADER], payload: JSON.parse(request.body) as { threadId?: string; runId?: string } }))
  .filter(({ payload }) => payload.threadId === threadId)
  .map(({ session, payload }) => ({ runId: payload.runId, session }));

describe('a warmup and the Turn after it use the same Sandbox', () => {
  it('in a new Side Chat', async () => {
    const { id } = await (await as('route-new', '/threads', 'POST')).json() as { id: string };

    expect((await post('route-new', '/warmup', { threadId: id })).status).toBe(200);
    await turn('route-new', id, 'first');

    expect(sandboxes(id)).toEqual([{ runId: '__warmup__', session: id }, { runId: 'first', session: id }]);
  });

  it('in an existing Side Chat warmed again on reopen', async () => {
    const { id } = await (await as('route-existing', '/threads', 'POST')).json() as { id: string };
    await turn('route-existing', id, 'earlier');

    expect((await post('route-existing', '/warmup', { threadId: id })).status).toBe(200);
    await turn('route-existing', id, 'after-reopen');

    expect(sandboxes(id)).toEqual([
      { runId: 'earlier', session: id }, { runId: '__warmup__', session: id }, { runId: 'after-reopen', session: id },
    ]);
  });

  it('in a new Main Chat warmed by name', async () => {
    expect((await post('route-main', '/warmup', { mainChat: true })).status).toBe(200);
    const { id } = await (await as('route-main', '/main-chat')).json() as { id: string };
    await turn('route-main', id, 'first');

    expect(sandboxes(id)).toEqual([{ runId: '__warmup__', session: id }, { runId: 'first', session: id }]);
  });

  it('in a Main Chat moved off a pre-cutover Session, warmed before the page reads it', async () => {
    const old = '0d9c8b7a-6f5e-4d3c-9b2a-1f0e9d8c7b6a';
    const binding = { filing_user_id: 'filed-route-moved', runtime_binding: 'runtime-00000000-0000-4000-8000-000000000000', runtime_generation: 'tracked-v1', read_only: true };
    const documents = DynamoDBDocumentClient.from(stack.table.client);
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: {
      pk: 'SESSIONS#route-moved', sk: `SESSION#${old}`, session_id: old, ...binding, title: 'Before the cutover',
      created_at: '2026-10-01T00:00:00.000000+00:00', updated_at: '2026-10-01T00:00:00.000000+00:00', provider: 'openai',
    } }));
    await documents.send(new PutCommand({ TableName: stack.table.name, Item: { pk: 'SESSIONS#route-moved', sk: 'MAIN', session_id: old, ...binding } }));

    expect((await post('route-moved', '/warmup', { mainChat: true })).status).toBe(200);
    const { id } = await (await as('route-moved', '/main-chat')).json() as { id: string };
    expect(id).not.toBe(old);
    await turn('route-moved', id, 'first');

    expect(sandboxes(id)).toEqual([{ runId: '__warmup__', session: id }, { runId: 'first', session: id }]);
    expect(sandboxes(old)).toEqual([]);
  });
});
