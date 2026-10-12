import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DeleteTableCommand, DynamoDBClient, ResourceNotFoundException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../test/fakes/stack.js';
import { DynamoDBAgentDocuments } from './agent-documents.js';
import { HttpError } from './cartridge.js';
import { DynamoDBSessionMetadata } from './session-metadata.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';

// The test Cartridge's templates (botcube/chat/test/in-process.ts).
const TEMPLATE_IDENTITY = { name: 'Test Bot', character: 'A test agent', vibe: 'Plain', avatar: '' };
const TEMPLATE_SOUL = 'Be brief.';

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess();
});
afterAll(() => stack.stop());

/** Each test acts as its own account, so edits never leak between tests. */
const as = (owner: string) => ({
  request(path: string, init: RequestInit = {}) {
    return stack.app.request(path, { ...init, headers: { 'x-test-owner': owner, ...init.headers } });
  },
  put(path: string, body: unknown) {
    return this.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  },
  async turn(threadId: string) {
    const response = await this.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId, runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: {} }),
    });
    return response.text();
  },
});

const forwarded = (threadId: string) => stack.agentcore.invocationFor(threadId).payload.forwardedProps;

describe('Agent Identity and Soul', () => {
  it("start as the Cartridge's templates and reach every Turn", async () => {
    const user = as('docs-template');

    expect(await (await user.request('/agent/identity')).json()).toEqual(TEMPLATE_IDENTITY);
    expect(await (await user.request('/agent/soul')).json()).toEqual({ content: TEMPLATE_SOUL });
    expect(await (await user.request('/agent')).json()).toEqual({ name: 'Test Bot', avatar: '', picture: null, status: 'online' });
    await user.turn('docs-template-turn');
    expect(forwarded('docs-template-turn')).toEqual({
      sessionUserId: 'filed-docs-template',
      agentIdentity: TEMPLATE_IDENTITY,
      soul: TEMPLATE_SOUL,
      model: 'plan',
    });
  });

  it("the user's edits reach the profile and the next Turn, for that account only", async () => {
    const user = as('docs-edited');
    const renamed = { name: 'Quill', character: 'A careful analyst', vibe: 'Dry', avatar: '🪶' };

    expect((await user.put('/agent/identity', renamed)).status).toBe(204);
    expect((await user.put('/agent/soul', { content: 'Answer in haiku.' })).status).toBe(204);

    expect(await (await user.request('/agent')).json()).toEqual({ name: 'Quill', avatar: '🪶', picture: null, status: 'online' });
    await user.turn('docs-edited-turn');
    expect(forwarded('docs-edited-turn')).toMatchObject({ agentIdentity: renamed, soul: 'Answer in haiku.' });
    expect(await (await as('docs-other').request('/agent/identity')).json()).toEqual(TEMPLATE_IDENTITY);
  });

  it.each([
    ['/agent/identity', { ...TEMPLATE_IDENTITY, vibe: 3 }, 'Agent Identity vibe must be a string'],
    ['/agent/identity', { ...TEMPLATE_IDENTITY, name: '  ' }, 'Agent Identity name must not be blank'],
    ['/agent/identity', 'not json', 'Agent Identity name must be a string'],
    ['/agent/soul', { content: null }, 'Soul content must be a string'],
    ['/agent/soul', 'not json', 'Soul content must be a string'],
  ])('refuses a malformed edit to %s', async (path, body, detail) => {
    const user = as('docs-malformed');

    const response = await user.request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail });
    expect(await (await user.request('/agent/identity')).json()).toEqual(TEMPLATE_IDENTITY);
  });

  it("saves the agent's own edits from its Turn stream and relays them to the UI", async () => {
    const user = as('docs-agent-edit');
    const identityEdit = { document: 'agentIdentity', content: { ...TEMPLATE_IDENTITY, name: 'Quill' } };
    const soulEdit = { document: 'soul', content: 'Answer in haiku.' };
    stack.agentcore.script('docs-agent-edit-turn', {
      kind: 'stream',
      frames: [
        `data: ${JSON.stringify({ type: 'CUSTOM', name: 'botcube:agent-document-edited', value: identityEdit })}`,
        `data: ${JSON.stringify({ type: 'CUSTOM', name: 'botcube:agent-document-edited', value: soulEdit })}`,
        'data: {"type":"RUN_FINISHED"}',
      ],
    });

    const body = await user.turn('docs-agent-edit-turn');

    expect(body).toBe(
      `data: {"type":"CUSTOM","name":"botcube:agent-document-edited","value":${JSON.stringify(identityEdit)}}\n\n` +
        `data: {"type":"CUSTOM","name":"botcube:agent-document-edited","value":${JSON.stringify(soulEdit)}}\n\n` +
        'data: {"type":"RUN_FINISHED"}\n\n',
    );
    expect(await (await user.request('/agent')).json()).toEqual({ name: 'Quill', avatar: '', picture: null, status: 'online' });
    expect(await (await user.request('/agent/soul')).json()).toEqual({ content: 'Answer in haiku.' });
  });

  it.each([
    ['soul', { document: 'soul', content: 7 }, 'Soul content must be a string'],
    ['identity', { document: 'agentIdentity', content: null }, 'Agent Identity name must be a string'],
    ['memory', { document: 'memory', content: 'x' }, 'The edit names no agent document'],
    ['none', null, 'The edit names no agent document'],
  ])('fails the Turn loudly on an agent edit it cannot save (%s)', async (label, value, reason) => {
    const user = as('docs-agent-bad-edit');
    const threadId = `docs-agent-bad-edit-${label}`;
    stack.agentcore.script(threadId, {
      kind: 'stream',
      frames: [`data: ${JSON.stringify({ type: 'CUSTOM', name: 'botcube:agent-document-edited', value })}`, 'data: {"type":"RUN_FINISHED"}'],
    });

    const body = await user.turn(threadId);

    expect(body).toBe(
      `data: {"type":"RUN_ERROR","message":"The agent's edit could not be saved: ${reason}","code":"AGENT_DOCUMENT_SAVE_FAILED"}\n\n`,
    );
    expect(await (await user.request('/agent/soul')).json()).toEqual({ content: TEMPLATE_SOUL });
    expect(await (await user.request('/agent/identity')).json()).toEqual(TEMPLATE_IDENTITY);
  });

  it("are deleted with the account, beside its Sessions' purge", async () => {
    const user = as('docs-deleted');
    await user.put('/agent/soul', { content: 'Answer in haiku.' });
    await user.turn('docs-deleted-turn');

    await stack.history.delete('docs-deleted');

    expect(await (await user.request('/agent/soul')).json()).toEqual({ content: TEMPLATE_SOUL });
    await vi.waitFor(() =>
      expect(stack.sessionApi.events()).toContainEqual({ operation: 'purge', sessionId: 'docs-deleted-turn', userId: 'filed-docs-deleted' }),
    );
  });
});

// A 1x1 PNG.
const PICTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pictureOf = async (user: ReturnType<typeof as>) => ((await (await user.request('/agent')).json()) as { picture: unknown }).picture;
const PICTURE_BYTES = {
  contentType: 'image/png',
  data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
};

/** The public document owner over the run's DynamoDB endpoint, with the existing fixture credentials. */
const pictureDocuments = (table: string, endpoint = inject('dynamodbEndpoint')) => {
  const client = new DynamoDBClient({
    region: 'us-east-1', endpoint,
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  });
  return {
    client,
    documents: new DynamoDBAgentDocuments(table, client),
    metadata: new DynamoDBSessionMetadata(table, client),
  };
};


describe("The agent's picture", () => {

  it('rejects a late picture upload after account-history deletion without recreating the image', async () => {
    const user = as('picture-delete-race');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    // The route resolves its requester before reading this body. No DynamoDB call admits the test.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        entered();
        await blocked;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ picture: PICTURE })));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request('http://localhost/agent/picture', {
      method: 'PUT',
      headers: { 'x-test-owner': 'picture-delete-race', 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const upload = Promise.resolve(stack.app.request(request));
    try {
      await Promise.race([
        started,
        upload.then(() => { throw new Error('The upload completed before reading its picture body'); }),
      ]);
      await stack.history.delete('picture-delete-race');
      release();
      const response = await upload;
      expect(await pictureOf(user)).toBeNull();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ detail: 'Account history is deleted' });
    } finally {
      release();
      await upload;
    }
  });

  it('preserves a missing-table storage failure instead of reporting deleted account history', async () => {
    const { client, documents } = pictureDocuments('picture-table-missing');
    try {
      await expect(documents.savePicture('picture-missing-table', PICTURE_BYTES))
        .rejects.toBeInstanceOf(ResourceNotFoundException);
    } finally {
      client.destroy();
    }
  });

  it('preserves a transaction conflict that no owner fence caused', async () => {
    // The supported cancellation fixture is also used by session-metadata.test.ts.
    const backend = createServer((request, response) => {
      request.resume();
      response.writeHead(400, { 'content-type': 'application/x-amz-json-1.0' });
      response.end(JSON.stringify({
        __type: 'com.amazonaws.dynamodb.v20120810#TransactionCanceledException',
        Message: 'Transaction cancelled',
        CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
      }));
    });
    await new Promise<void>((resolve, reject) => {
      backend.once('error', reject);
      backend.listen(0, '127.0.0.1', resolve);
    });
    const address = backend.address();
    assert(address !== null && typeof address !== 'string');
    const { client, documents } = pictureDocuments('picture-conflict', `http://127.0.0.1:${address.port}`);
    try {
      const upload = documents.savePicture('picture-conflict-owner', PICTURE_BYTES);
      await expect(upload).rejects.toBeInstanceOf(TransactionCanceledException);
      await expect(upload).rejects.toMatchObject({
        CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
      });
    } finally {
      client.destroy();
      await new Promise<void>((resolve, reject) => { backend.close((error) => error ? reject(error) : resolve()); });
    }
  });

  it('preserves the DynamoDB cancellation as the classified picture-fence error cause', async () => {
    const table = `picture-fence-${Math.random().toString(36).slice(2)}`;
    await createChatTable(inject('dynamodbEndpoint'), table);
    const { client, documents, metadata } = pictureDocuments(table);
    try {
      await metadata.fenceOwner('picture-fenced-owner');
      const upload = documents.savePicture('picture-fenced-owner', PICTURE_BYTES);
      await expect(upload).rejects.toBeInstanceOf(HttpError);
      await expect(upload).rejects.toMatchObject({
        status: 409,
        detail: 'Account history is deleted',
        cause: expect.any(TransactionCanceledException),
      });
      await expect(documents.picture('picture-fenced-owner')).resolves.toBeNull();
    } finally {
      try {
        await client.send(new DeleteTableCommand({ TableName: table }));
      } finally {
        client.destroy();
      }
    }
  });

  it('stays out of the Agent Identity every Turn carries', async () => {
    const user = as('picture-turn');
    await user.put('/agent/picture', { picture: PICTURE });

    await user.turn('picture-turn-turn');

    expect(await pictureOf(user)).toBe(PICTURE);
    expect(JSON.stringify(forwarded('picture-turn-turn'))).not.toContain('iVBORw0KGgo');
  });

  it('is deleted with the account', async () => {
    const user = as('picture-deleted');
    await user.put('/agent/picture', { picture: PICTURE });

    await stack.history.delete('picture-deleted');

    expect(await pictureOf(user)).toBeNull();
  });

  it.each([
    ['no data URL', { picture: 'https://example.com/a.png' }],
    ['no picture', {}],
    ['no JSON', 'not json'],
  ])('refuses %s', async (_, body) => {
    const user = as('picture-malformed');

    const response = await user.request('/agent/picture', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "The agent's picture must be a base64 data URL" });
  });
});

describe('Memory', () => {
  const remembering = (owner: string) => {
    stack.sessionApi.memories.set(`filed-${owner}`, [
      { id: 'mem-copper', text: 'Trades copper' },
      { id: 'mem-paris', text: 'Lives in Paris' },
    ]);
    return as(owner);
  };

  it("reads the account's Memory lines from the session API", async () => {
    const user = remembering('memory-read');

    expect(await (await user.request('/agent/memory')).json()).toEqual({
      lines: [
        { id: 'mem-copper', text: 'Trades copper' },
        { id: 'mem-paris', text: 'Lives in Paris' },
      ],
    });
    expect(stack.sessionApi.events()).toContainEqual({ operation: 'memory', userId: 'filed-memory-read' });
  });

  it('edits and deletes lines through the session API', async () => {
    const user = remembering('memory-edited');

    expect((await user.put('/agent/memory/mem-paris', { text: 'Lives in London' })).status).toBe(204);
    expect((await user.request('/agent/memory/mem-copper', { method: 'DELETE' })).status).toBe(204);

    expect(stack.sessionApi.events()).toEqual(
      expect.arrayContaining([
        { operation: 'memory-edit', userId: 'filed-memory-edited', recordId: 'mem-paris', text: 'Lives in London' },
        { operation: 'memory-delete', userId: 'filed-memory-edited', recordId: 'mem-copper' },
      ]),
    );
    expect(await (await user.request('/agent/soul')).json()).toEqual({ content: TEMPLATE_SOUL });
  });

  it('answers 404 for a delete or edit of a line Memory does not have', async () => {
    const user = remembering('memory-missing');

    const response = await user.request('/agent/memory/mem-gold', { method: 'DELETE' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: 'Memory has no line mem-gold' });
    expect((await user.put('/agent/memory/mem-gold', { text: 'Trades gold' })).status).toBe(404);
  });

  it('surfaces a failed deletion with the session API diagnostics', async () => {
    const user = remembering('memory-upstream-failure');
    const diagnostics = { error: 'Memory unavailable', stackTrace: ['at memory_delete (/var/task/session_api.py:3484)'] };
    const originalFetch = globalThis.fetch;
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === `${stack.sessionApi.url}/invocations` && typeof init?.body === 'string' && JSON.parse(init.body).operation === 'memory-delete') {
        return Promise.resolve(new Response(JSON.stringify(diagnostics), { status: 503 }));
      }
      return originalFetch(input, init);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await user.request('/agent/memory/mem-copper', { method: 'DELETE' });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ detail: 'Session API returned HTTP 503' });
      expect(errors).toHaveBeenCalledWith('DELETE /agent/memory/mem-copper failed', expect.objectContaining({
        status: 503, detail: 'Session API returned HTTP 503', cause: diagnostics,
      }));
      expect(stack.sessionApi.memories.get('filed-memory-upstream-failure')).toHaveLength(2);
    } finally {
      transport.mockRestore();
      errors.mockRestore();
    }
  });

  it.each([{ text: '' }, { text: ' \n' }, { text: null }, 'not json'])('refuses the line %j without asking the session API', async (body) => {
    const user = remembering('memory-malformed');

    const response = await user.request('/agent/memory/mem-paris', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: 'A Memory line must be non-blank text' });
    expect(stack.sessionApi.events()).not.toContainEqual(expect.objectContaining({ userId: 'filed-memory-malformed' }));
  });
});


describe('bounded document recovery probes', () => {
  it('keeps concurrent Soul, Identity and Memory updates in one account without losing fields', async () => {
    const user = as('probe-concurrent');
    stack.sessionApi.memories.set('filed-probe-concurrent', [{ id: 'line', text: 'old' }]);
    const responses = await Promise.all([
      user.put('/agent/soul', { content: 'Concurrent instructions' }),
      user.put('/agent/identity', { ...TEMPLATE_IDENTITY, name: 'Concurrent Agent' }),
      user.put('/agent/memory/line', { text: 'new' }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([204, 204, 204]);
    await user.turn('probe-concurrent-turn');
    expect(forwarded('probe-concurrent-turn')).toMatchObject({ soul: 'Concurrent instructions', agentIdentity: { name: 'Concurrent Agent' } });
    expect(stack.sessionApi.memories.get('filed-probe-concurrent')).toEqual([{ id: 'line', text: 'new' }]);
    expect(await (await as('probe-concurrent-other').request('/agent/soul')).json()).toEqual({ content: TEMPLATE_SOUL });
  });

  it('reports a failed Soul save and allows an explicit subsequent retry without changing the prior document', async () => {
    const user = as('probe-save-recovery');
    expect((await user.put('/agent/soul', { content: 'Prior instructions' })).status).toBe(204);
    const failure = vi.spyOn(DynamoDBAgentDocuments.prototype, 'save').mockRejectedValueOnce(new Error('storage unavailable'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await user.put('/agent/soul', { content: 'New instructions' })).status).toBe(500);
      expect(await (await user.request('/agent/soul')).json()).toEqual({ content: 'Prior instructions' });
      expect((await user.put('/agent/soul', { content: 'New instructions' })).status).toBe(204);
      await user.turn('probe-save-recovery-turn');
      expect(forwarded('probe-save-recovery-turn')).toMatchObject({ soul: 'New instructions' });
    } finally {
      failure.mockRestore();
      errors.mockRestore();
    }
  });
});


describe('Agent document deletion boundary probe', () => {
  it.each([
    ['/agent/soul', { content: 'Private resurrected instructions' }, { content: TEMPLATE_SOUL }],
    ['/agent/identity', { ...TEMPLATE_IDENTITY, name: 'Private resurrected identity' }, TEMPLATE_IDENTITY],
  ])('rejects an admitted edit to %s whose body completes after account purge without recreating the document', async (path, edit, template) => {
    const owner = `probe-document-delete-race-${path.split('/').at(-1)}`;
    const user = as(owner);
    await user.put('/agent/soul', { content: 'Private old instructions' });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        entered();
        await blocked;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(edit)));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request(`http://localhost${path}`, {
      method: 'PUT', headers: { 'x-test-owner': owner, 'content-type': 'application/json' }, body, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const save = Promise.resolve(stack.app.request(request));
    try {
      await Promise.race([started, save.then(() => { throw new Error('Save finished before body consumption'); })]);
      await stack.history.delete(owner);
      expect(await (await user.request(path)).json()).toEqual(template);
      release();
      const response = await save;
      expect(await (await user.request(path)).json()).toEqual(template);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ detail: 'Account history is deleted' });
      expect(await (await as('probe-unrelated-owner').request(path)).json()).toEqual(template);
    } finally {
      release();
      await save;
    }
  });
});
