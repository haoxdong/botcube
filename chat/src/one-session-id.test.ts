import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
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

const as = (account: string, path: string, method = 'GET') =>
  stack.app.request(path, { method, headers: { 'x-account': account } });

const turn = (account: string, threadId: string) => stack.app.request('/', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-account': account },
  body: JSON.stringify({ threadId, runId: 'run-1', state: {}, messages: [{ id: 'm1', role: 'user', content: 'hello' }], tools: [], context: [], forwardedProps: {} }),
});

const stored = async (account: string, sessionId: string) => (await DynamoDBDocumentClient.from(stack.table.client).send(new GetCommand({
  TableName: stack.table.name, Key: { pk: `SESSIONS#${account}`, sk: `SESSION#${sessionId}` }, ConsistentRead: true,
}))).Item;

const stops = () => stack.agentcore.requests
  .filter((request) => request.path.includes('/stopruntimesession'))
  .map((request) => request.headers[SESSION_HEADER]);

describe('one Session ID per chat', () => {
  it('runs and stops a Side Chat Sandbox under the Session ID the server issued', async () => {
    const { id } = await (await as('side-one-id', '/threads', 'POST')).json() as { id: string };
    expect(id).toMatch(UUID);

    const response = await turn('side-one-id', id);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('RUN_FINISHED');
    expect(stack.agentcore.invocationFor(id).headers[SESSION_HEADER]).toBe(id);

    expect((await as('side-one-id', `/threads/${id}`, 'DELETE')).status).toBe(204);
    expect((await turn('side-one-id', id)).status).toBe(410);
    const warmup = await stack.app.request('/warmup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-account': 'side-one-id' }, body: JSON.stringify({ threadId: id }),
    });
    expect(warmup.status).toBe(503);
    expect(await warmup.json()).toMatchObject({ error: 'AgentCore warmup failed' });
    await expect.poll(() => stack.sessionApi.events()).toContainEqual(expect.objectContaining({ operation: 'purge', sessionId: id }));
    expect(stops()).toContain(id);
  });

  it('completes the purge of a deleted chat the server issued, after a Turn ran in it', async () => {
    const { id } = await (await as('purged-one-id', '/threads', 'POST')).json() as { id: string };
    const response = await turn('purged-one-id', id);
    expect(response.status).toBe(200);
    await response.text();

    expect((await as('purged-one-id', `/threads/${id}`, 'DELETE')).status).toBe(204);

    await expect.poll(async () => (await stack.sessionMetadata.pendingPurges()).filter(({ session_id }) => session_id === id)).toEqual([]);
  });

  it('runs a new Main Chat Sandbox under the Session ID the server issued', async () => {
    const { id } = await (await as('main-one-id', '/main-chat')).json() as { id: string };
    expect(id).toMatch(UUID);

    const response = await turn('main-one-id', id);
    expect(response.status).toBe(200);
    await response.text();
    expect(stack.agentcore.invocationFor(id).headers[SESSION_HEADER]).toBe(id);
  });

  it("refuses a Turn on another User's Session ID and starts no Sandbox", async () => {
    const { id } = await (await as('issued-owner', '/threads', 'POST')).json() as { id: string };

    const response = await turn('id-borrower', id);

    expect(response.status).toBe(404);
    const warmup = await stack.app.request('/warmup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-account': 'id-borrower' }, body: JSON.stringify({ threadId: id }),
    });
    expect(warmup.status).toBe(404);
    expect(stack.agentcore.invocations().filter((request) => request.headers[SESSION_HEADER] === id)).toEqual([]);
    expect(await stored('id-borrower', id)).toBeUndefined();
  });
});
