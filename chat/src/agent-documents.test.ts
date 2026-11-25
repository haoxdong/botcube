import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';
import { DeleteTableCommand, DynamoDBClient, ResourceNotFoundException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createChatTable } from '../test/fakes/stack.js';
import { DynamoDBAgentDocuments } from './agent-documents.js';
import { HttpError } from './http-error.js';
import { DynamoDBSessionMetadata } from './session-metadata.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { motoAws, motoEndpoint } from '../test/fakes/moto.js';
import { eventually } from '../test/eventually.js';
import { filed } from '../test/stock-bot.js';

// The test bot's templates (botcube/chat/test/stock-bot.ts), its vibe the bot settings' default.
const TEMPLATE_IDENTITY = { name: 'Test Bot', character: 'A test agent', vibe: 'Direct, precise, and calm', avatar: '' };
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
    if (await stack.sessionMetadata.get(owner, threadId) === null) await stack.allocate(owner, threadId);
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
  it("start as the bot's templates and reach every Turn", async ({ onTestFinished }) => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-03T22:00:00.250Z') });
    onTestFinished(() => { vi.useRealTimers(); });
    const user = as('acct_docs-template');

    expect(await (await user.request('/agent/identity')).json()).toEqual(TEMPLATE_IDENTITY);
    expect(await (await user.request('/agent/soul')).json()).toEqual({ content: TEMPLATE_SOUL });
    expect(await (await user.request('/agent')).json()).toEqual({ name: 'Test Bot', avatar: '', picture: null, status: 'online' });
    await user.turn('docs-template-turn');
    expect(forwarded('docs-template-turn')).toEqual({
      sessionUserId: filed('acct_docs-template'),
      turnStartedAt: '2026-11-03T22:00:00.250Z',
      agentIdentity: TEMPLATE_IDENTITY,
      soul: TEMPLATE_SOUL,
      model: 'quick',
      // The local Agent Computer's CDP endpoint for this Session.
      agentComputerCdpUrl: expect.stringMatching(/^ws:\/\//),
    });
  });

  it("the user's edits reach the profile and the next Turn, for that account only", async () => {
    const user = as('acct_docs-edited');
    const renamed = { name: 'Quill', character: 'A careful analyst', vibe: 'Dry', avatar: '🪶' };

    expect((await user.put('/agent/identity', renamed)).status).toBe(204);
    expect((await user.put('/agent/soul', { content: 'Answer in haiku.' })).status).toBe(204);

    expect(await (await user.request('/agent')).json()).toEqual({ name: 'Quill', avatar: '🪶', picture: null, status: 'online' });
    await user.turn('docs-edited-turn');
    expect(forwarded('docs-edited-turn')).toMatchObject({ agentIdentity: renamed, soul: 'Answer in haiku.' });
    expect(await (await as('acct_docs-other').request('/agent/identity')).json()).toEqual(TEMPLATE_IDENTITY);
  });

  it.each([
    ['/agent/identity', { ...TEMPLATE_IDENTITY, vibe: 3 }, 'Agent Identity vibe must be a string'],
    ['/agent/identity', { ...TEMPLATE_IDENTITY, name: '  ' }, 'Agent Identity name must not be blank'],
    ['/agent/identity', 'not json', 'Agent Identity name must be a string'],
    ['/agent/soul', { content: null }, 'Soul content must be a string'],
    ['/agent/soul', 'not json', 'Soul content must be a string'],
  ])('refuses a malformed edit to %s', async (path, body, detail) => {
    const user = as('acct_docs-malformed');

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
    const user = as('acct_docs-agent-edit');
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
    const user = as('acct_docs-agent-bad-edit');
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
    const user = as('acct_docs-deleted');
    await user.put('/agent/soul', { content: 'Answer in haiku.' });
    await user.turn('docs-deleted-turn');

    await stack.history.delete('acct_docs-deleted');

    expect(await (await user.request('/agent/soul')).json()).toEqual({ content: TEMPLATE_SOUL });
    await eventually(() =>
      expect(stack.sessionApi.events()).toContainEqual({ operation: 'purge', sessionId: 'docs-deleted-turn', userId: filed('acct_docs-deleted') }),
    );
  });
});

/** A PNG chunk: length, type, data and the CRC of type and data. */
const pngChunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
// A 1x1 transparent PNG, built here rather than carried as an encoded blob.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
  pngChunk('IEND', Buffer.alloc(0)),
]);
const PICTURE = `data:image/png;base64,${PNG.toString('base64')}`;
const pictureOf = async (user: ReturnType<typeof as>) => ((await (await user.request('/agent')).json()) as { picture: unknown }).picture;
const PICTURE_BYTES = { contentType: 'image/png', data: PNG };

/** The public document owner over the run's DynamoDB endpoint, with the existing fixture credentials. */
const pictureDocuments = (table: string, endpoint = motoEndpoint()) => {
  const client = new DynamoDBClient({ ...motoAws(), endpoint });
  return {
    client,
    documents: new DynamoDBAgentDocuments(table, client),
    metadata: new DynamoDBSessionMetadata(table, client),
  };
};


describe("The agent's picture", () => {

  it('rejects a late picture upload after account-history deletion without recreating the image', async () => {
    const user = as('acct_picture-delete-race');
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
      headers: { 'x-test-owner': 'acct_picture-delete-race', 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const upload = Promise.resolve(stack.app.request(request));
    try {
      await Promise.race([
        started,
        upload.then(() => { throw new Error('The upload completed before reading its picture body'); }),
      ]);
      await stack.history.delete('acct_picture-delete-race');
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
    await createChatTable(motoEndpoint(), table);
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
    const user = as('acct_picture-turn');
    await user.put('/agent/picture', { picture: PICTURE });

    await user.turn('picture-turn-turn');

    expect(await pictureOf(user)).toBe(PICTURE);
    expect(JSON.stringify(forwarded('picture-turn-turn'))).not.toContain('iVBORw0KGgo');
  });

  it('is deleted with the account', async () => {
    const user = as('acct_picture-deleted');
    await user.put('/agent/picture', { picture: PICTURE });

    await stack.history.delete('acct_picture-deleted');

    expect(await pictureOf(user)).toBeNull();
  });

  it.each([
    ['no data URL', { picture: 'https://example.com/a.png' }],
    ['no picture', {}],
    ['no JSON', 'not json'],
  ])('refuses %s', async (_, body) => {
    const user = as('acct_picture-malformed');

    const response = await user.request('/agent/picture', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ detail: "The agent's picture must be a base64 data URL" });
  });
});

// The Memory panel shows Written Memory (ADR 0095): no route serves Extracted Memory records.
it.each([
  ['GET', '/agent/memory'],
  ['POST', '/agent/memory'],
  ['PUT', '/agent/memory/mem-paris'],
  ['DELETE', '/agent/memory/mem-paris'],
])('answers %s %s with 404, never asking the session API', async (method, path) => {
  const user = as('acct_memory-retired');

  const response = await user.request(path, {
    method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? null : JSON.stringify({ text: 'Lives in London' }),
  });

  expect(response.status).toBe(404);
  expect(stack.sessionApi.events()).not.toContainEqual(expect.objectContaining({ userId: filed('acct_memory-retired') }));
});

describe('bounded document recovery probes', () => {
  it('keeps concurrent Soul and Identity updates in one account without losing fields', async () => {
    const user = as('acct_probe-concurrent');
    const responses = await Promise.all([
      user.put('/agent/soul', { content: 'Concurrent instructions' }),
      user.put('/agent/identity', { ...TEMPLATE_IDENTITY, name: 'Concurrent Agent' }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([204, 204]);
    await user.turn('probe-concurrent-turn');
    expect(forwarded('probe-concurrent-turn')).toMatchObject({ soul: 'Concurrent instructions', agentIdentity: { name: 'Concurrent Agent' } });
    expect(await (await as('acct_probe-concurrent-other').request('/agent/soul')).json()).toEqual({ content: TEMPLATE_SOUL });
  });

  it('reports a failed Soul save and allows an explicit subsequent retry without changing the prior document', async () => {
    const user = as('acct_probe-save-recovery');
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
    const owner = `acct_probe-document-delete-race-${path.split('/').at(-1)}`;
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
      expect(await (await as('acct_probe-unrelated-owner').request(path)).json()).toEqual(template);
    } finally {
      release();
      await save;
    }
  });
});

// The bot settings' Extracted Memory gate. A bot with it off keeps no AgentCore Memory, and its Turns say so.
it('tells each Turn when the bot settings turn Extracted Memory off', async () => {
  const forgetful = await startInProcess({ overrides: { extractedMemory: false } });
  try {
    const user = { 'x-test-owner': 'acct_memory-off' };
    await forgetful.allocate('acct_memory-off', 'memory-off-turn');
    await (await forgetful.app.request('/', {
      method: 'POST',
      headers: { ...user, 'content-type': 'application/json' },
      // A client cannot turn Memory back on.
      body: JSON.stringify({ threadId: 'memory-off-turn', runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: { botMemory: true } }),
    })).text();
    expect(forgetful.agentcore.invocationFor('memory-off-turn').payload.forwardedProps.botMemory).toBe(false);
  } finally {
    await forgetful.stop();
  }
});

it.each([
  ['a Guest', { requester: async () => ({ owner: 'acct_written-memory', anonymous: true }) }, false],
  ['a bot with Written Memory off', { writtenMemory: false }, false],
  ['a signed-in User', {}, undefined],
] as const)('tells the Turn of %s whether it keeps Written Memory, whatever the client sends', async (_who, overrides, kept) => {
  const stack = await startInProcess({ overrides });
  try {
    await stack.allocate('acct_written-memory', 'written-memory-turn');
    const forced = kept === false;
    await (await stack.app.request('/', {
      method: 'POST',
      headers: { 'x-test-owner': 'acct_written-memory', 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'written-memory-turn', runId: 'run-1', state: {}, messages: [], tools: [], context: [], forwardedProps: { writtenMemory: forced } }),
    })).text();
    expect(stack.agentcore.invocationFor('written-memory-turn').payload.forwardedProps.writtenMemory).toBe(kept);
  } finally {
    await stack.stop();
  }
});
