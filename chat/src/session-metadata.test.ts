import { defined } from '../test/defined.js';
import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../test/fakes/stack.js';
import { type SessionPurge, DynamoDBSessionMetadata, SessionDeletedError, SessionProviderError, SessionClaimError } from './session-metadata.js';
import { purgeQueue } from './purges.js';
import { sessionLifecycle } from './session-lifecycle.js';

const REJECTED_TARGET = 'configured-runtime';
const T1 = '2026-01-02T03:04:05.678Z';
const T2 = '2026-01-02T03:04:06.000Z';
const T3 = '2026-01-02T03:04:07.009Z';
/** The stored form of T1..T3: ISO 8601 with microseconds and a +00:00 offset. */
const S1 = '2026-01-02T03:04:05.678000+00:00';
const S2 = '2026-01-02T03:04:06.000000+00:00';
const S3 = '2026-01-02T03:04:07.009000+00:00';

function client(region = 'us-east-1'): DynamoDBClient {
  return new DynamoDBClient({
    region,
    endpoint: inject('dynamodbEndpoint'),
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  });
}

const tableName = () => `chat-${Math.random().toString(36).slice(2)}`;

let table: string;
let metadata: DynamoDBSessionMetadata;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T1);
  table = tableName();
  await createChatTable(inject('dynamodbEndpoint'), table);
  metadata = new DynamoDBSessionMetadata(table, client());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Every stored item, ordered by key. */
async function items(): Promise<Record<string, unknown>[]> {
  const { Items } = await DynamoDBDocumentClient.from(client()).send(new ScanCommand({ TableName: table }));
  return (Items ?? []).filter((item) => item.pk !== 'RUNTIME_DISPATCHERS').sort((a, b) => `${a.pk}|${a.sk}`.localeCompare(`${b.pk}|${b.sk}`));
}

async function tracked(session: SessionPurge): Promise<SessionPurge> {
  const stored = (await items()).find((item) => item.session_id === session.session_id && item.filing_user_id === session.filing_user_id && String(item.sk).startsWith('SESSION#'));
  return { ...session, ...(stored?.runtime_binding === undefined ? {} : { runtime_binding: defined(typeof stored.runtime_binding === 'string' ? stored.runtime_binding : undefined, 'runtime binding') }), ...(stored?.runtime_generation === undefined ? {} : { runtime_generation: defined(typeof stored.runtime_generation === 'string' ? stored.runtime_generation : undefined, 'runtime generation') }) };
}

async function turn(owner: string, sessionId: string, at: string, title = `title ${sessionId}`): Promise<string> {
  vi.setSystemTime(at);
  return metadata.recordTurn(owner, sessionId, { filingUserId: `filed-${owner}`, title });
}

async function fence(owner: string, sessionId: string, at: string) {
  vi.setSystemTime(at);
  return metadata.fence(owner, sessionId);
}

/** Session Metadata over this test's table whose client runs `before` ahead of each command it sends. */
function metadataWith(before: (command: string) => Promise<unknown>): DynamoDBSessionMetadata {
  const intercepted = client();
  intercepted.middlewareStack.add(
    (next, context) => async (args) => {
      const output = await before(context.commandName as string);
      return output === undefined ? next(args) : ({ output, response: {} } as Awaited<ReturnType<typeof next>>);
    },
    { step: 'initialize' },
  );
  return new DynamoDBSessionMetadata(table, intercepted);
}

describe('checkHealth', () => {
  it('passes on an active, readable table', async () => {
    await expect(metadata.checkHealth()).resolves.toBeUndefined();
  });

  it('fails on a missing table', async () => {
    await expect(new DynamoDBSessionMetadata(tableName(), client()).checkHealth()).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('fails on a table that is not active yet', async () => {
    const creating = metadataWith(async (command) =>
      command === 'DescribeTableCommand' ? { Table: { TableStatus: 'CREATING' } } : undefined,
    );

    await expect(creating.checkHealth()).rejects.toThrow(new Error('Session Metadata table is not active'));
  });

  it('fails when the table cannot be read', async () => {
    const denied = metadataWith(async (command) => {
      if (command === 'GetItemCommand') throw new Error('AccessDenied');
    });

    await expect(denied.checkHealth()).rejects.toThrow(new Error('AccessDenied'));
  });
});

describe('the default client', () => {
  async function tableIn(region: string): Promise<string> {
    const name = tableName();
    await client(region).send(
      new CreateTableCommand({
        TableName: name,
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    return name;
  }

  beforeEach(() => {
    vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', inject('dynamodbEndpoint'));
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', AWS_SECRET_ACCESS_KEY);
    vi.stubEnv('AWS_REGION', undefined);
    vi.stubEnv('AWS_CONFIG_FILE', '/nonexistent');
  });

  it('uses AWS_DEFAULT_REGION', async () => {
    vi.stubEnv('AWS_DEFAULT_REGION', 'eu-west-1');

    await expect(new DynamoDBSessionMetadata(await tableIn('eu-west-1')).checkHealth()).resolves.toBeUndefined();
  });

  it('defaults to us-east-1', async () => {
    vi.stubEnv('AWS_DEFAULT_REGION', undefined);

    await expect(new DynamoDBSessionMetadata(await tableIn('us-east-1')).checkHealth()).resolves.toBeUndefined();
  });
});

describe('recordTurn', () => {
  it('replaces the latest message marker and preserves it when no message is added', async () => {
    await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't', messageId: 'request-1' });
    expect(await metadata.get('account-1', 'session-1')).toMatchObject({ latest_message_id: 'request-1' });
    await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't', messageId: 'post-2' });
    expect(await metadata.get('account-1', 'session-1')).toMatchObject({ latest_message_id: 'post-2' });
    await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't' });
    expect(await metadata.get('account-1', 'session-1')).toMatchObject({ latest_message_id: 'post-2' });
  });

  it('keeps a Session without a message marker readable', async () => {
    await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't' });
    expect(await metadata.get('account-1', 'session-1')).not.toHaveProperty('latest_message_id');
  });

  it.each(['without Claim', 'after Claim'])('fails loud if an accepted Turn loses its stored row %s', async (stage) => {
    let removed = false;
    let accepted = false;
    const racing = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand') { accepted = true; return; }
      if (command !== 'GetItemCommand' || removed || !accepted) return;
      removed = true;
      if (stage === 'after Claim') await metadata.transferOwner('account-1', 'account-2');
      await DynamoDBDocumentClient.from(client()).send(new DeleteCommand({
        TableName: table, Key: { pk: `SESSIONS#${stage === 'after Claim' ? 'account-2' : 'account-1'}`, sk: 'SESSION#missing-after-turn' },
      }));
    });
    await expect(racing.recordTurn('account-1', 'missing-after-turn', { filingUserId: 'hint', title: 'turn', provider: 'anthropic' }))
      .rejects.toThrow('Session metadata missing after accepted Turn');
    expect(removed).toBe(true);
  });


  async function legacySession() {
    await DynamoDBDocumentClient.from(client()).send(new PutCommand({ TableName: table, Item: {
      pk: 'SESSIONS#account-1', sk: 'SESSION#legacy', session_id: 'legacy',
      filing_user_id: 'filed-account-1', title: 'old Anthropic conversation', created_at: S1, updated_at: S1,
    } }));
  }

  it('keeps pre-existing provider-less Sessions on Anthropic when reading and replaying', async () => {
    await legacySession();
    expect(await metadata.get('account-1', 'legacy')).toEqual(expect.objectContaining({ provider: 'anthropic' }));
    expect(await metadata.list('account-1')).toMatchObject([expect.objectContaining({ provider: 'anthropic' })]);
  });

  it('rejects another provider for a pre-existing provider-less Session without changing it', async () => {
    await legacySession();
    const before = await items();
    await expect(metadata.recordTurn('account-1', 'legacy', { filingUserId: 'f', title: 't', provider: 'openai' }))
      .rejects.toThrow(new SessionProviderError('anthropic'));
    expect(await items()).toEqual(before);
    await expect(metadata.recordTurn('account-1', 'legacy', { filingUserId: 'f', title: 't', provider: 'anthropic' }))
      .resolves.toBe('filed-account-1');
    expect(await metadata.get('account-1', 'legacy')).toEqual(expect.objectContaining({ provider: 'anthropic' }));
  });

  it('does not expose the new unbound marker in Session summaries', async () => {
    await turn('account-1', 'session-1', T1);
    expect(await items()).toMatchObject([expect.objectContaining({ provider_pending: true })]);
    expect(await metadata.get('account-1', 'session-1')).not.toHaveProperty('provider_pending');
    expect(await metadata.list('account-1')).toMatchObject([expect.not.objectContaining({ provider_pending: true })]);
    await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't', provider: 'openai' });
    expect((await items())[0]).not.toHaveProperty('provider_pending');
  });

  it('does not mark a legacy Session unbound when another writer creates it first', async () => {
    let transactions = 0;
    const racing = metadataWith(async (command) => {
      if (command !== 'TransactWriteItemsCommand') return;
      transactions += 1;
      if (transactions > 2) throw new Error('Unexpected Session write after retrying the competing writer');
      if (transactions === 1) await legacySession();
    });
    await racing.recordTurn('account-1', 'legacy', { filingUserId: 'f', title: 't' });
    expect(transactions).toBe(2);
    expect((await items())[0]).not.toHaveProperty('provider_pending');
    await expect(metadata.recordTurn('account-1', 'legacy', { filingUserId: 'f', title: 't', provider: 'openai' }))
      .rejects.toThrow(new SessionProviderError('anthropic'));
  });

  it('refuses a competing explicit provider without a model-less retry', async () => {
    let transactions = 0;
    const racing = metadataWith(async (command) => {
      if (command !== 'TransactWriteItemsCommand') return;
      transactions += 1;
      if (transactions > 1) throw new Error('Unexpected retry of an explicit provider binding');
      await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'first', title: 'first', provider: 'anthropic' });
    });
    await expect(racing.recordTurn('account-1', 'session-1', { filingUserId: 'second', title: 'second', provider: 'openai' }))
      .rejects.toThrow(new SessionProviderError('anthropic'));
    expect(transactions).toBe(1);
    expect(await metadata.get('account-1', 'session-1'))
      .toEqual(expect.objectContaining({ provider: 'anthropic', filing_user_id: 'first' }));
  });

  it('keeps a provider bound by the writer that creates a new Session first', async () => {
    let first = true;
    const racing = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand' && first) {
        first = false;
        await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'first', title: 'first', provider: 'openai' });
      }
    });
    await expect(racing.recordTurn('account-1', 'session-1', { filingUserId: 'second', title: 'second' }))
      .resolves.toBe('first');
    expect(await metadata.get('account-1', 'session-1')).toEqual(expect.objectContaining({ provider: 'openai' }));
    expect((await items())[0]).not.toHaveProperty('provider_pending');
  });

  it("creates the Session's metadata on its first Turn", async () => {
    expect(await turn('account-1', 'session-1', T1, 'hello')).toBe('filed-account-1');

    expect(await items()).toMatchObject([
      {
        pk: 'SESSIONS#account-1',
        sk: 'SESSION#session-1',
        session_id: 'session-1',
        filing_user_id: 'filed-account-1',
        title: 'hello',
        provider_pending: true,
        created_at: S1,
        updated_at: S1,
      },
    ]);
  });

  it('bumps only the last activity on a later Turn, and returns the filing user ID first recorded', async () => {
    await turn('account-1', 'session-1', T1, 'hello');
    vi.setSystemTime(T2);

    expect(await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'someone-else', title: 'bye' })).toBe(
      'filed-account-1',
    );

    expect(await items()).toMatchObject([
      {
        pk: 'SESSIONS#account-1',
        sk: 'SESSION#session-1',
        session_id: 'session-1',
        filing_user_id: 'filed-account-1',
        title: 'hello',
        provider_pending: true,
        created_at: S1,
        updated_at: S2,
      },
    ]);
  });

  it("records the first model Turn's provider and keeps it", async () => {
    await turn('account-1', 'session-1', T1, 'hello');
    await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't', provider: 'openai' });
    await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't', provider: 'openai' });

    expect(await items()).toMatchObject([expect.objectContaining({ sk: 'SESSION#session-1', provider: 'openai' })]);
    await expect(
      metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't', provider: 'anthropic' }),
    ).rejects.toThrow(new SessionProviderError('openai'));
  });

  it("refuses a Turn on a fenced Session as deleted, whatever the Turn's provider", async () => {
    await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't', provider: 'openai' });
    await fence('account-1', 'session-1', T2);

    await expect(
      metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't', provider: 'anthropic' }),
    ).rejects.toBeInstanceOf(SessionDeletedError);
  });

  it("refuses a Turn once the owner's history is fenced as deleted, whatever the Turn's provider", async () => {
    await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't', provider: 'openai' });
    await metadata.fenceOwner('account-1');

    await expect(
      metadata.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't', provider: 'anthropic' }),
    ).rejects.toBeInstanceOf(SessionDeletedError);
  });

  it('refuses a Turn on a fenced Session', async () => {
    await turn('account-1', 'session-1', T1);
    await fence('account-1', 'session-1', T2);

    let transactions = 0;
    const deleted = metadataWith(async (command) => {
      if (command !== 'TransactWriteItemsCommand') return;
      transactions += 1;
      if (transactions > 1) throw new Error('Unexpected Session write after its deletion fence');
    });
    await expect(deleted.recordTurn('account-1', 'session-1', { filingUserId: 'filed-account-1', title: 'later' }))
      .rejects.toThrow(new SessionDeletedError('session-1'));
    expect(transactions).toBe(1);
  });

  it("refuses a Turn once the owner's history is fenced", async () => {
    await metadata.fenceOwner('account-1');

    await expect(turn('account-1', 'session-new', T2)).rejects.toThrow(new SessionDeletedError('session-new'));
    await expect(turn('account-1', 'session-new', T2)).rejects.toBeInstanceOf(SessionDeletedError);
  });

  it('refuses a Turn on a fenced Session of a fenced owner', async () => {
    await turn('account-1', 'session-1', T1);
    await metadata.fenceOwner('account-1');

    await expect(turn('account-1', 'session-1', T2)).rejects.toBeInstanceOf(SessionDeletedError);
  });

  it('passes on a cancelled transaction that no fence caused', async () => {
    const conflict = new TransactionCanceledException({
      message: 'Transaction cancelled',
      $metadata: {},
      CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
    });
    const conflicted = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand') throw conflict;
    });

    await expect(
      conflicted.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't' }),
    ).rejects.toBe(conflict);
  });

  it('passes on a failure other than a fence', async () => {
    const missing = new DynamoDBSessionMetadata(tableName(), client());

    await expect(
      missing.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't' }),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });
});

describe('list', () => {
  it("lists the owner's unfenced Sessions, newest activity first", async () => {
    await turn('account-1', 'session-a', T1);
    await turn('account-1', 'session-b', T3);
    await turn('account-1', 'session-c', T2);
    await turn('account-1', 'session-fenced', T1);
    await fence('account-1', 'session-fenced', T2);
    await turn('account-2', 'session-other', T2);

    expect(await metadata.list('account-1')).toMatchObject([
      expect.objectContaining({ session_id: 'session-b', updated_at: S3 }),
      expect.objectContaining({ session_id: 'session-c', updated_at: S2 }),
      expect.objectContaining({ session_id: 'session-a', updated_at: S1 }),
    ]);
  });

  it('keeps Sessions with the same last activity in Session ID order', async () => {
    await turn('account-1', 'session-a', T1);
    await turn('account-1', 'session-b', T1);
    await turn('account-1', 'session-c', T1);

    expect((await metadata.list('account-1')).map((session) => session.session_id)).toMatchObject([
      'session-a',
      'session-b',
      'session-c',
    ]);
  });

  it("leaves out the owner's fence and retired IDs", async () => {
    await turn('account-2', 'session-2', T1);
    await metadata.transferOwner('account-2', 'account-1');
    await metadata.fenceOwner('account-3');

    expect((await metadata.list('account-1')).map((session) => session.session_id)).toMatchObject(['session-2']);
    expect(await metadata.list('account-3')).toMatchObject([]);
  });
});

describe('get', () => {
  it("returns the owner's Session", async () => {
    await turn('account-1', 'session-1', T1, 'hello');

    expect(await metadata.get('account-1', 'session-1')).toMatchObject({
      pk: 'SESSIONS#account-1',
      sk: 'SESSION#session-1',
      session_id: 'session-1',
      filing_user_id: 'filed-account-1',
      title: 'hello',
      created_at: S1,
      updated_at: S1,
    });
  });

  it("returns null for a missing, fenced or another owner's Session", async () => {
    await turn('account-1', 'session-1', T1);
    await turn('account-1', 'session-fenced', T1);
    await fence('account-1', 'session-fenced', T2);

    expect(await metadata.get('account-1', 'session-missing')).toBeNull();
    expect(await metadata.get('account-1', 'session-fenced')).toBeNull();
    expect(await metadata.get('account-2', 'session-1')).toBeNull();
  });
});

describe('fence', () => {
  it('sets the deletion fence and drops the title', async () => {
    await turn('account-1', 'session-1', T1);

    const fenced = {
      pk: 'SESSIONS#account-1',
      sk: 'SESSION#session-1',
      session_id: 'session-1',
      filing_user_id: 'filed-account-1',
      created_at: S1,
      updated_at: S1,
      deleted_at: S2,
      purge_registered: true,
    };
    expect(await fence('account-1', 'session-1', T2)).toMatchObject(fenced);
    expect(await items()).toMatchObject([
      { pk: 'PURGES', sk: '["filed-account-1","session-1"]', session_id: 'session-1', filing_user_id: 'filed-account-1' },
      { ...fenced, provider_pending: true },
    ]);
  });

  it('keeps the first fence when fenced again', async () => {
    await turn('account-1', 'session-1', T1);
    await fence('account-1', 'session-1', T2);

    expect(await fence('account-1', 'session-1', T3)).toEqual(expect.objectContaining({ deleted_at: S2 }));
  });

  it('returns null and stores nothing when the owner has no such Session', async () => {
    await turn('account-2', 'session-1', T1);

    expect(await fence('account-1', 'session-1', T2)).toBeNull();
    expect(await items()).toMatchObject([expect.objectContaining({ pk: 'SESSIONS#account-2', sk: 'SESSION#session-1' })]);
  });

  it('passes on a failure other than a missing Session', async () => {
    await expect(new DynamoDBSessionMetadata(tableName(), client()).fence('account-1', 'session-1')).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it("deletes the Session's Turn summaries and keeps other Sessions'", async () => {
    await turn('account-1', 'session-1', T1);
    await turn('account-1', 'session-1#2', T1);
    await summarize('account-1', 'session-1', 'message-1');
    await summarize('account-1', 'session-1#2', 'message-2');

    await fence('account-1', 'session-1', T2);

    expect(await metadata.turnSummaries('filed-account-1')).toMatchObject([summarized('session-1#2', 'message-2')]);
  });
});

async function summarize(owner: string, sessionId: string, messageId: string): Promise<void> {
  await metadata.saveTurnSummary(
    owner,
    { sessionId, filingUserId: `filed-${owner}`, messageId },
    { request: `Request ${messageId}`, completedAt: T2, summary: { title: `Title ${messageId}`, summary: `Summary of ${messageId}` } },
  );
}

/** The row `summarize` saves. */
const summarized = (sessionId: string, messageId: string) => ({
  session_id: sessionId,
  message_id: messageId,
  request: `Request ${messageId}`,
  completed_at: T2,
  title: `Title ${messageId}`,
  summary: `Summary of ${messageId}`,
});

describe('Turn summaries', () => {
  it("lists each finished Turn's summary under its Session's filing user", async () => {
    await turn('account-1', 'session-1', T1);
    await summarize('account-1', 'session-1', 'message-1');
    await summarize('account-1', 'session-1', 'message-2');

    expect(await metadata.turnSummaries('filed-account-1')).toMatchObject([
      summarized('session-1', 'message-1'),
      summarized('session-1', 'message-2'),
    ]);
    expect(await metadata.turnSummaries('filed-account-2')).toMatchObject([]);
  });

  it('keeps the latest summary of a Turn summarized again', async () => {
    await turn('account-1', 'session-1', T1);
    await summarize('account-1', 'session-1', 'message-1');
    await metadata.saveTurnSummary(
      'account-1',
      { sessionId: 'session-1', filingUserId: 'filed-account-1', messageId: 'message-1' },
      { request: 'Asked again', completedAt: T3, summary: { title: 'Retitled', summary: 'Resummarized' } },
    );

    expect(await metadata.turnSummaries('filed-account-1')).toMatchObject([
      { session_id: 'session-1', message_id: 'message-1', request: 'Asked again', completed_at: T3, title: 'Retitled', summary: 'Resummarized' },
    ]);
  });

  it('saves a Turn the summary model could not summarize with its request and completion time alone', async () => {
    await turn('account-1', 'session-1', T1);
    await metadata.saveTurnSummary(
      'account-1',
      { sessionId: 'session-1', filingUserId: 'filed-account-1', messageId: 'message-1' },
      { request: 'Plot EURUSD', completedAt: T2 },
    );

    expect(await metadata.turnSummaries('filed-account-1')).toMatchObject([
      { session_id: 'session-1', message_id: 'message-1', request: 'Plot EURUSD', completed_at: T2 },
    ]);
  });

  it('saves a failed Turn with its request, completion time and error', async () => {
    await turn('account-1', 'session-1', T1);
    await metadata.saveTurnSummary(
      'account-1',
      { sessionId: 'session-1', filingUserId: 'filed-account-1', messageId: 'message-1' },
      { request: 'Plot EURUSD', completedAt: T2, failed: 'Model overloaded' },
    );

    expect(await metadata.turnSummaries('filed-account-1')).toMatchObject([
      { session_id: 'session-1', message_id: 'message-1', request: 'Plot EURUSD', completed_at: T2, failed: 'Model overloaded' },
    ]);
  });

  it.each(['Session', 'owner'])('keeps the claimed destination %s deletion fence when finishing an accepted Turn', async (deleted) => {
    await turn('account-1', 'session-1', T1);
    await metadata.transferOwner('account-1', 'account-2');
    if (deleted === 'Session') await metadata.fence('account-2', 'session-1');
    else await metadata.fenceOwner('account-2');
    await expect(summarize('account-1', 'session-1', 'message-1')).rejects.toBeInstanceOf(SessionDeletedError);
    expect(await metadata.get('account-1', 'session-1')).toBeNull();
    expect(await metadata.get('account-2', 'session-1')).toBeNull();
    expect(await metadata.turnSummaries('filed-account-1')).toMatchObject([]);
  });

  it('refuses a summary under a filing identity different from the claimed Session', async () => {
    await turn('account-1', 'session-1', T1);
    await metadata.transferOwner('account-1', 'account-2');
    await expect(metadata.saveTurnSummary(
      'account-1',
      { sessionId: 'session-1', filingUserId: 'filed-account-2', messageId: 'message-1' },
      { request: 'Request', completedAt: T2, summary: { title: 'Title', summary: 'Summary' } },
    )).rejects.toBeInstanceOf(SessionDeletedError);
    expect(await metadata.get('account-1', 'session-1')).toBeNull();
    expect(await metadata.get('account-2', 'session-1')).toMatchObject({ filing_user_id: 'filed-account-1' });
    expect(await metadata.turnSummaries('filed-account-1')).toMatchObject([]);
    expect(await metadata.turnSummaries('filed-account-2')).toMatchObject([]);
  });

  it('propagates a storage failure while saving the summary under its claimed owner', async () => {
    await turn('account-1', 'session-1', T1);
    await metadata.transferOwner('account-1', 'account-2');
    const failure = new Error('destination summary storage unavailable');
    let transactions = 0;
    const failing = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand' && ++transactions === 2) throw failure;
    });
    await expect(failing.saveTurnSummary(
      'account-1',
      { sessionId: 'session-1', filingUserId: 'filed-account-1', messageId: 'message-1' },
      { request: 'Request', completedAt: T2, summary: { title: 'Title', summary: 'Summary' } },
    )).rejects.toBe(failure);
    expect(await metadata.turnSummaries('filed-account-1')).toMatchObject([]);
  });

  it.each([
    { request: 'Request', completedAt: T2 },
    { request: 'Request', completedAt: T2, failed: 'Model overloaded' },
  ])('preserves the accepted claimed Turn Activity fields without a summary: %j', async (finished) => {
    await turn('account-1', 'session-1', T1);
    await metadata.transferOwner('account-1', 'account-2');
    await metadata.saveTurnSummary('account-1', { sessionId: 'session-1', filingUserId: 'filed-account-1', messageId: 'message-1' }, finished);
    expect(await metadata.turnSummaries('filed-account-1')).toMatchObject([
      { session_id: 'session-1', message_id: 'message-1', request: finished.request, completed_at: finished.completedAt, ...('failed' in finished ? { failed: finished.failed } : {}) },
    ]);
  });

  it("stores nothing for a missing or fenced Session, or a fenced owner's", async () => {
    await turn('account-1', 'fenced', T1);
    await fence('account-1', 'fenced', T2);
    await turn('account-2', 'session-2', T1);
    await metadata.fenceOwner('account-2');
    const before = await items();

    for (const [owner, sessionId] of [['account-1', 'missing'], ['account-1', 'fenced'], ['account-2', 'session-2']] as const) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against the same table
      await expect(summarize(owner, sessionId, 'message-1')).rejects.toBeInstanceOf(SessionDeletedError);
    }
    expect(await items()).toEqual(before);
  });
});

describe('the Activity backfill writes', () => {
  const turnOf = (messageId: string) => ({ sessionId: 'session-1', filingUserId: 'filed-account-1', messageId });

  /** A row saved before the Activity backfill: the summary alone. */
  async function oldRow(messageId: string) {
    await DynamoDBDocumentClient.from(client()).send(
      new PutCommand({
        TableName: table,
        Item: {
          pk: 'TURN_SUMMARIES#filed-account-1',
          sk: `SESSION#session-1#TURN#${messageId}`,
          session_id: 'session-1',
          message_id: messageId,
          title: `Title ${messageId}`,
          summary: `Summary of ${messageId}`,
        },
      }),
    );
  }

  it("adds a Turn's request and completion time to its summary row, and creates the row of a Turn without one", async () => {
    await turn('account-1', 'session-1', T1);
    await oldRow('message-1');

    await metadata.backfillTurn('account-1', turnOf('message-1'), { request: 'Request message-1', completedAt: T2 });
    await metadata.backfillTurn('account-1', turnOf('message-2'), { request: 'Request message-2', completedAt: T3 });

    expect(await metadata.turnSummaries('filed-account-1')).toMatchObject([
      summarized('session-1', 'message-1'),
      { session_id: 'session-1', message_id: 'message-2', request: 'Request message-2', completed_at: T3 },
    ]);
  });

  it('keeps the request and completion time a row already holds', async () => {
    await turn('account-1', 'session-1', T1);
    await summarize('account-1', 'session-1', 'message-1');
    const before = await items();

    await metadata.backfillTurn('account-1', turnOf('message-1'), { request: 'Another request', completedAt: T3 });

    expect(await items()).toEqual(before);
  });

  it("stores nothing for a missing or fenced Session, or a fenced owner's", async () => {
    await turn('account-1', 'fenced', T1);
    await fence('account-1', 'fenced', T2);
    await turn('account-2', 'session-2', T1);
    await metadata.fenceOwner('account-2');
    const before = await items();

    for (const [owner, sessionId] of [['account-1', 'missing'], ['account-1', 'fenced'], ['account-2', 'session-2']] as const) {
      // eslint-disable-next-line no-await-in-loop -- each refusal is checked against the same table
      await expect(
        metadata.backfillTurn(owner, { sessionId, filingUserId: `filed-${owner}`, messageId: 'message-1' }, { request: 'r', completedAt: T3 }),
      ).rejects.toBeInstanceOf(SessionDeletedError);
    }
    expect(await items()).toEqual(before);
  });
});

describe('allSessions', () => {
  it("lists every owner's unfenced Sessions with their owner", async () => {
    await turn('account-1', 'session-1', T1);
    await turn('account-1', 'fenced', T1);
    await fence('account-1', 'fenced', T2);
    await turn('account-2', 'session-2', T2);
    await metadata.mainChat('account-2', 'filed-account-2');
    await summarize('account-2', 'session-2', 'message-1');

    const sessions = await metadata.allSessions();

    expect(sessions.map(({ owner, session }) => [owner, session.session_id, session.filing_user_id]).sort()).toMatchObject([
      ['account-1', 'session-1', 'filed-account-1'],
      ['account-2', 'session-2', 'filed-account-2'],
    ]);
  });
});

describe('mainChat', () => {
  it('assigns the owner a Main Chat once and returns it on every later call', async () => {
    const id = await metadata.mainChat('account-1', 'filed-account-1');

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await metadata.mainChat('account-1', 'filed-account-1')).toBe(id);
    expect(await metadata.mainChat('account-2', 'filed-account-2')).not.toBe(id);
    expect((await items()).filter((item) => item.sk === 'MAIN')).toMatchObject([
      { pk: 'SESSIONS#account-1', sk: 'MAIN', session_id: id },
      expect.objectContaining({ pk: 'SESSIONS#account-2', sk: 'MAIN' }),
    ]);
  });

  it('lands a first call that loses the race in the Main Chat assigned first', async () => {
    let first = true;
    const racing = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand' && first) {
        first = false;
        await metadata.mainChat('account-1', 'filed-account-1');
      }
    });

    const id = await racing.mainChat('account-1', 'filed-account-1');

    expect((await items()).filter((item) => item.sk === 'MAIN')).toMatchObject([{ pk: 'SESSIONS#account-1', sk: 'MAIN', session_id: id }]);
  });

  it('passes on a failure other than a lost race', async () => {
    const failure = new Error('throttled');
    const failing = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand') throw failure;
    });

    await expect(failing.mainChat('account-1', 'filed-account-1')).rejects.toBe(failure);
  });
});

describe('fenceOwner', () => {
  it("fences the owner and every Session it answers for, retired IDs' included", async () => {
    await turn('account-2', 'session-2', T1);
    await turn('account-2', 'session-2-fenced', T1);
    await fence('account-2', 'session-2-fenced', T1);
    await metadata.transferOwner('account-2', 'account-1');
    await turn('account-1', 'session-1', T1);
    await turn('account-1', 'session-1-fenced', T1);
    await fence('account-1', 'session-1-fenced', T2);
    await turn('account-3', 'session-3', T1);

    vi.setSystemTime(T3);
    const fenced = await metadata.fenceOwner('account-1');

    expect(fenced.map((session) => [session.session_id, (session as { deleted_at?: string }).deleted_at])).toMatchObject([
      ['session-2-fenced', S1],
      ['session-1', S3],
      ['session-1-fenced', S2],
      ['session-2', S3],
    ]);
    expect(
      (await items()).map(({ pk, sk, deleted_at }) => ({ pk, sk, deleted_at })),
    ).toMatchObject([
      { pk: 'PURGES', sk: '["filed-account-1","session-1-fenced"]', deleted_at: undefined },
      { pk: 'PURGES', sk: '["filed-account-1","session-1"]', deleted_at: undefined },
      { pk: 'PURGES', sk: '["filed-account-2","session-2-fenced"]', deleted_at: undefined },
      { pk: 'PURGES', sk: '["filed-account-2","session-2"]', deleted_at: undefined },
      { pk: 'SESSIONS#account-1', sk: 'DELETED', deleted_at: S3 },
      { pk: 'SESSIONS#account-1', sk: 'RETIRED#account-2', deleted_at: undefined },
      { pk: 'SESSIONS#account-1', sk: 'SESSION#session-1', deleted_at: S3 },
      { pk: 'SESSIONS#account-1', sk: 'SESSION#session-1-fenced', deleted_at: S2 },
      { pk: 'SESSIONS#account-1', sk: 'SESSION#session-2', deleted_at: S3 },
      { pk: 'SESSIONS#account-2', sk: 'CLAIM', deleted_at: undefined },
      { pk: 'SESSIONS#account-2', sk: 'DELETED', deleted_at: S3 },
      { pk: 'SESSIONS#account-2', sk: 'SESSION#session-2-fenced', deleted_at: S1 },
      { pk: 'SESSIONS#account-3', sk: 'SESSION#session-3', deleted_at: undefined },
    ]);
  });

  it('leaves out a Session deleted while it fences', async () => {
    await turn('account-1', 'session-1', T1);
    const documents = DynamoDBDocumentClient.from(client());
    const racing = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand') {
        await documents.send(
          new DeleteCommand({ TableName: table, Key: { pk: 'SESSIONS#account-1', sk: 'SESSION#session-1' } }),
        );
      }
    });

    expect(await racing.fenceOwner('account-1')).toMatchObject([]);
    expect(await metadata.pendingPurges()).toMatchObject([]);
  });
});

describe('transferOwner', () => {
  it('keeps a Session deleted during Account Claim fenced and retryable', async () => {
    await turn('account-2', 'session-deleted', T1);
    await turn('account-2', 'session-live', T1);
    let deleted = false;
    const racing = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand' && !deleted) {
        deleted = true;
        await fence('account-2', 'session-deleted', T2);
      }
    });

    await expect(racing.transferOwner('account-2', 'account-1')).rejects.toBeInstanceOf(
      TransactionCanceledException,
    );
    expect(await metadata.get('account-1', 'session-deleted')).toBeNull();
    expect(await items()).toContainEqual(
      expect.objectContaining({ pk: 'SESSIONS#account-2', sk: 'SESSION#session-deleted', deleted_at: S2 }),
    );
    await expect(turn('account-2', 'session-deleted', T3)).rejects.toBeInstanceOf(SessionDeletedError);

    await metadata.transferOwner('account-2', 'account-1');

    expect(await metadata.get('account-1', 'session-deleted')).toBeNull();
    expect(await metadata.get('account-1', 'session-live')).toEqual(
      expect.objectContaining({ session_id: 'session-live', filing_user_id: 'filed-account-2' }),
    );
  });

  it("moves the source's unfenced Sessions to the destination and records the source as retired", async () => {
    await turn('account-2', 'session-2', T1, 'moved');
    await turn('account-2', 'session-2-fenced', T1);
    await fence('account-2', 'session-2-fenced', T2);
    await turn('account-1', 'session-1', T2);

    await metadata.transferOwner('account-2', 'account-1');

    expect(await items()).toMatchObject([
      { pk: 'PURGES', sk: '["filed-account-2","session-2-fenced"]', session_id: 'session-2-fenced', filing_user_id: 'filed-account-2' },
      { pk: 'SESSIONS#account-1', sk: 'RETIRED#account-2', retired_id: 'account-2' },
      expect.objectContaining({ pk: 'SESSIONS#account-1', sk: 'SESSION#session-1' }),
      {
        pk: 'SESSIONS#account-1',
        sk: 'SESSION#session-2',
        session_id: 'session-2',
        filing_user_id: 'filed-account-2',
        title: 'moved',
        provider_pending: true,
        created_at: S1,
        updated_at: S1,
      },
      { pk: 'SESSIONS#account-2', sk: 'CLAIM', destination: 'account-1' },
      expect.objectContaining({ pk: 'SESSIONS#account-2', sk: 'SESSION#session-2-fenced', deleted_at: S2 }),
    ]);
  });

  it('refuses, changing nothing, when the destination already owns a Session ID', async () => {
    await turn('account-2', 'session-1', T1);
    await turn('account-1', 'session-1', T1);
    const before = await items();

    await expect(metadata.transferOwner('account-2', 'account-1')).rejects.toThrow(
      new Error('destination already owns this Session ID'),
    );
    expect(await items()).toEqual(before);
  });

  it("refuses the move of a Session the destination holds fenced", async () => {
    await turn('account-2', 'session-1', T1);
    await turn('account-1', 'session-1', T1);
    await fence('account-1', 'session-1', T1);

    await expect(metadata.transferOwner('account-2', 'account-1')).rejects.toBeInstanceOf(
      TransactionCanceledException,
    );
    expect(await items()).toMatchObject([
      { pk: 'PURGES', sk: '["filed-account-1","session-1"]', session_id: 'session-1', filing_user_id: 'filed-account-1' },
      expect.objectContaining({ pk: 'SESSIONS#account-1', sk: 'RETIRED#account-2' }),
      expect.objectContaining({ pk: 'SESSIONS#account-1', sk: 'SESSION#session-1', filing_user_id: 'filed-account-1' }),
      { pk: 'SESSIONS#account-2', sk: 'CLAIM', destination: 'account-1' },
      expect.objectContaining({ pk: 'SESSIONS#account-2', sk: 'SESSION#session-1' }),
    ]);
  });
});

describe('transferOwner of the Main Chat', () => {
  it("makes the source's Main Chat the destination's when the destination has none", async () => {
    const sourceMain = await metadata.mainChat('account-2', 'filed-account-2');

    await metadata.transferOwner('account-2', 'account-1');

    expect(await metadata.mainChat('account-1', 'filed-account-1')).toBe(sourceMain);
  });

  it("keeps the destination's own Main Chat", async () => {
    await metadata.mainChat('account-2', 'filed-account-2');
    const destinationMain = await metadata.mainChat('account-1', 'filed-account-1');

    await metadata.transferOwner('account-2', 'account-1');

    expect(await metadata.mainChat('account-1', 'filed-account-1')).toBe(destinationMain);
  });

  it('assigns nothing when the source has no Main Chat', async () => {
    await metadata.transferOwner('account-2', 'account-1');

    expect(await items()).toMatchObject([{ pk: 'SESSIONS#account-1', sk: 'RETIRED#account-2', retired_id: 'account-2' }, { pk: 'SESSIONS#account-2', sk: 'CLAIM', destination: 'account-1' }]);
  });

  it('passes on a failure other than a destination Main Chat', async () => {
    await metadata.mainChat('account-2', 'filed-account-2');
    const failure = new Error('throttled');
    let puts = 0;
    // The first two puts fence Claim and record its retired ID; the third assigns Main Chat.
    const failing = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand' && ++puts === 1) throw failure;
    });

    await expect(failing.transferOwner('account-2', 'account-1')).rejects.toBe(failure);
    expect(puts).toBe(1);
  });
});

describe('strongly consistent reads', () => {
  /** Each read the operation sends, with the ConsistentRead flag it sent. */
  async function readsOf(operation: (metadata: DynamoDBSessionMetadata) => Promise<unknown>) {
    const reads: [string, unknown][] = [];
    const capturing = client();
    capturing.middlewareStack.add(
      (next, context) => async (args) => {
        if (['GetItemCommand', 'QueryCommand'].includes(context.commandName as string)) {
          reads.push([context.commandName as string, (args.input as { ConsistentRead?: boolean }).ConsistentRead]);
        }
        return next(args);
      },
      { step: 'initialize' },
    );
    await operation(new DynamoDBSessionMetadata(table, capturing));
    return reads;
  }

  beforeEach(async () => {
    await turn('account-1', 'session-1', T1);
  });

  it.each([
    ['checkHealth', (m: DynamoDBSessionMetadata) => m.checkHealth(), 'GetItemCommand'],
    [
      'recordTurn',
      (m: DynamoDBSessionMetadata) => m.recordTurn('account-1', 'session-1', { filingUserId: 'f', title: 't' }),
      'GetItemCommand',
    ],
    ['get', (m: DynamoDBSessionMetadata) => m.get('account-1', 'session-1'), 'GetItemCommand'],
    ['list', (m: DynamoDBSessionMetadata) => m.list('account-1'), 'QueryCommand'],
    ['mainChat', (m: DynamoDBSessionMetadata) => metadata.mainChat('account-1', 'filed-account-1').then(() => m.mainChat('account-1', 'filed-account-1')), 'GetItemCommand'],
  ] as const)('%s reads consistently', async (_name, operation, command) => {
    expect(await readsOf(operation)).toEqual(_name === 'recordTurn' ? [[command, true], [command, true]] : [[command, true]]);
  });
});

describe('durable fenced Session cleanup', () => {
  it('persists cleanup with the fence and acknowledges it idempotently without reopening the Session', async () => {
    await turn('owner', 'session', T1);
    await metadata.fence('owner', 'session');
    const replacement = new DynamoDBSessionMetadata(table, client());
    expect(await replacement.pendingPurges()).toMatchObject([{ session_id: 'session', filing_user_id: 'filed-owner' }]);
    await replacement.completePurge(await tracked({ session_id: 'session', filing_user_id: 'filed-owner' }));
    await replacement.completePurge(await tracked({ session_id: 'session', filing_user_id: 'filed-owner' }));
    expect(await metadata.pendingPurges()).toMatchObject([]);
    expect(await replacement.get('owner', 'session')).toBeNull();
  });

  it('retains both filing identities when accounts use the same Session ID', async () => {
    await turn('owner-1', 'session', T1);
    await turn('owner-2', 'session', T1);
    await metadata.fence('owner-1', 'session');
    await metadata.fence('owner-2', 'session');
    expect(await metadata.pendingPurges()).toMatchObject([
      { session_id: 'session', filing_user_id: 'filed-owner-1' },
      { session_id: 'session', filing_user_id: 'filed-owner-2' },
    ]);
    await metadata.completePurge(await tracked({ session_id: 'session', filing_user_id: 'filed-owner-1' }));
    expect(await metadata.pendingPurges()).toMatchObject([{ session_id: 'session', filing_user_id: 'filed-owner-2' }]);
    await metadata.completePurge(await tracked({ session_id: 'session', filing_user_id: 'filed-owner-1' }));
    expect(await metadata.pendingPurges()).toMatchObject([{ session_id: 'session', filing_user_id: 'filed-owner-2' }]);
  });

  it('leaves neither a fence nor cleanup work when their transaction fails', async () => {
    await turn('owner', 'session', T1);
    const failure = new Error('fence transaction failed');
    const failing = metadataWith(async (command) => { if (command === 'TransactWriteItemsCommand') throw failure; });
    await expect(failing.fence('owner', 'session')).rejects.toBe(failure);
    expect(await metadata.get('owner', 'session')).toMatchObject({ session_id: 'session' });
    expect(await metadata.pendingPurges()).toMatchObject([]);
  });

  it('does not queue cleanup or recreate the source when ownership moves after its pre-read', async () => {
    await turn('source', 'session', T1);
    const racing = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand') await metadata.transferOwner('source', 'destination');
    });
    expect(await racing.fence('source', 'session')).toBeNull();
    expect(await metadata.get('source', 'session')).toBeNull();
    expect(await metadata.get('destination', 'session')).toMatchObject({ session_id: 'session', filing_user_id: 'filed-source' });
    expect(await metadata.pendingPurges()).toMatchObject([]);
  });
});

describe('durable Session dispatch admission', () => {
  it('keeps unclassified dispatches and mismatched rejected bindings pending after replacement', async () => {
    await turn('account-1', 'session-1', T1);
    const admission = await metadata.beginDispatch('account-1', 'session-1');
    const session = defined(admission.session, 'bound admission');
    expect(await new DynamoDBSessionMetadata(table, client()).rejectedDispatches(session, REJECTED_TARGET)).toEqual([]);
    await metadata.fence('account-1', 'session-1');
    await expect(metadata.assertNoDispatch(session)).rejects.toThrow('still registered');
    await defined(admission.markRejected, 'durable rejection classifier')(REJECTED_TARGET);
    expect(await metadata.rejectedDispatches(session, 'different-runtime')).toEqual([]);
    await DynamoDBDocumentClient.from(client()).send(new UpdateCommand({ TableName: table,
      Key: { pk: `DISPATCH#${JSON.stringify([session.filing_user_id, session.session_id])}`, sk: admission.token },
      UpdateExpression: 'SET rejected_runtime_binding = :wrong', ExpressionAttributeValues: { ':wrong': 'runtime-00000000-0000-4000-8000-000000000099' },
    }));
    expect(await metadata.rejectedDispatches(session, REJECTED_TARGET)).toEqual([]);
    await expect(metadata.assertNoDispatch(session)).rejects.toThrow('still registered');
  });

  it('recovers durable successful stop proof after acknowledgement failure and replacement', async () => {
    const failing = metadataWith(async (command) => {
      if (command === 'DeleteItemCommand') throw new Error('registration delete unavailable');
    });
    await turn('account-1', 'session-1', T1);
    const admission = await failing.beginDispatch('account-1', 'session-1');
    const session = defined(admission.session, 'bound admission');
    const stop = vi.fn(async () => undefined);
    const old = sessionLifecycle({ label: 'AgentCore', runtimeTarget: REJECTED_TARGET, invoke: async () => { throw new Error('headers lost'); } }, stop);
    await expect(old.invokeRegistered('{}', session, admission)).rejects.toThrow('headers lost');
    await metadata.fence('account-1', 'session-1');
    await expect(old.stop(session)).rejects.toThrow('registration delete unavailable');
    expect(stop).toHaveBeenCalledWith(session.runtime_binding);
    const recovered = await new DynamoDBSessionMetadata(table, client()).rejectedDispatches(session, REJECTED_TARGET);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.stopConfirmed).toBe(true);
    const replacementStop = vi.fn(async () => 'absent' as const);
    const replacement = sessionLifecycle({ label: 'AgentCore', invoke: async () => new Response() }, replacementStop);
    replacement.restoreFailedDispatch(session, recovered);
    await replacement.settleFailedDispatch(session);
    expect(replacementStop).not.toHaveBeenCalled();
    await expect(metadata.assertNoDispatch(session)).resolves.toBeUndefined();
  });

  it('requires durable exact stop proof before recovered acknowledgement', async () => {
    await turn('account-1', 'session-1', T1);
    const admission = await metadata.beginDispatch('account-1', 'session-1');
    const session = defined(admission.session, 'bound admission');
    await defined(admission.markRejected, 'durable rejection classifier')(REJECTED_TARGET);
    const [recovered] = await metadata.rejectedDispatches(session, REJECTED_TARGET);
    await expect(defined(recovered, 'recovered registration')()).rejects.toThrow();
    await expect(metadata.assertNoDispatch(session)).rejects.toThrow('still registered');
    await defined(recovered?.confirmStopped, 'durable stop acknowledgement')();
    await defined(recovered, 'recovered registration')();
    await expect(metadata.assertNoDispatch(session)).resolves.toBeUndefined();
  });

  it('keeps a broker registration blocking alongside a classified rejected admission', async () => {
    await turn('account-1', 'session-1', T1);
    const admission = await metadata.beginDispatch('account-1', 'session-1');
    const broker = await metadata.beginDispatch('account-1', 'session-1');
    const session = defined(admission.session, 'bound admission');
    await defined(admission.markRejected, 'durable rejection classifier')(REJECTED_TARGET);
    await metadata.fence('account-1', 'session-1');
    const recovered = await metadata.rejectedDispatches(session, REJECTED_TARGET);
    expect(recovered.map((registration) => registration.token)).toEqual([admission.token]);
    await expect(metadata.assertNoDispatch(session, recovered.map((registration) => defined(registration.token, 'rejected token')))).rejects.toThrow(String(broker.token));
    expect(await metadata.rejectedDispatches({ ...session, legacy_settlement_unproved: true }, REJECTED_TARGET)).toEqual([]);
  });

  it('does not resurrect a rejected registration acknowledged by concurrent recovery', async () => {
    await turn('account-1', 'session-1', T1);
    const admission = await metadata.beginDispatch('account-1', 'session-1');
    const session = defined(admission.session, 'bound admission');
    await defined(admission.markRejected, 'durable rejection classifier')(REJECTED_TARGET);
    const [first] = await metadata.rejectedDispatches(session, REJECTED_TARGET);
    const [second] = await metadata.rejectedDispatches(session, REJECTED_TARGET);
    await defined(first?.confirmStopped, 'first confirmed stop')();
    await defined(first, 'first recovered registration')();
    await defined(second?.confirmStopped, 'concurrent confirmed stop')();
    await defined(second, 'concurrent recovered registration')();
    expect(await metadata.rejectedDispatches(session, REJECTED_TARGET)).toEqual([]);
    await expect(metadata.assertNoDispatch(session)).resolves.toBeUndefined();
  });

  it('orders another process admission against thread deletion and retains a pending dispatch until acknowledged', async () => {
    const other = new DynamoDBSessionMetadata(table, client());
    await turn('owner', 'session', T1);
    const complete = await other.beginDispatch('owner', 'session');
    await metadata.fence('owner', 'session');
    await expect(metadata.assertNoDispatch(await tracked({ session_id: 'session', filing_user_id: 'filed-owner' }))).rejects.toThrow('Session dispatch is still registered');
    await expect(other.beginDispatch('owner', 'session')).rejects.toBeInstanceOf(SessionDeletedError);
    await complete();
    await expect(metadata.assertNoDispatch(await tracked({ session_id: 'session', filing_user_id: 'filed-owner' }))).resolves.toBeUndefined();
  });

  it('resumes purge when another dispatcher completes after the ordinary retry budget', async () => {
    const other = new DynamoDBSessionMetadata(table, client());
    await turn('owner', 'session', T1);
    const complete = await other.beginDispatch('owner', 'session');
    const summary = await metadata.fence('owner', 'session');
    if (summary === null) throw new Error('the recorded Session must be fenced');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stop = vi.fn(async () => { await metadata.assertNoDispatch(await tracked({ session_id: 'session', filing_user_id: 'filed-owner' })); });
    const purge = vi.fn(async () => ({}));
    try {
      purgeQueue(purge, stop, [0])([summary]);
      await expect.poll(() => logged.mock.calls.length).toBe(1);
      expect(purge).not.toHaveBeenCalled();
      await complete();
      await expect.poll(() => purge.mock.calls.length, { timeout: 1_000 }).toBe(1);
      expect(purge.mock.calls).toMatchObject([[{ operation: 'purge', sessionId: 'session', userId: 'filed-owner' }, 900]]);
    } finally {
      logged.mockRestore();
      warnings.mockRestore();
    }
  });

  it('refuses delayed admission after another process fences the owner', async () => {
    const other = new DynamoDBSessionMetadata(table, client());
    await turn('owner', 'session', T1);
    await metadata.fenceOwner('owner');
    await expect(other.beginDispatch('owner', 'session')).rejects.toBeInstanceOf(SessionDeletedError);
    await expect(metadata.assertNoDispatch(await tracked({ session_id: 'session', filing_user_id: 'filed-owner' }))).resolves.toBeUndefined();
    await expect(other.beginDispatch('missing', 'missing')).rejects.toBeInstanceOf(SessionDeletedError);
  });

  it('registers warmup without listing a Session and rejects deleted Session and owner warmups', async () => {
    const session = { session_id: 'new-session', filing_user_id: 'filed-owner' };
    const complete = await metadata.beginDispatch('owner', session.session_id, session.filing_user_id);
    expect(await metadata.list('owner')).toMatchObject([]);
    await expect(metadata.assertNoDispatch(await tracked(session))).rejects.toThrow('Session dispatch is still registered');
    await complete();
    await expect(metadata.assertNoDispatch(await tracked(session))).resolves.toBeUndefined();
    await turn('owner', 'existing', T1);
    await metadata.fence('owner', 'existing');
    await expect(metadata.beginDispatch('owner', 'existing', 'filed-owner')).rejects.toBeInstanceOf(SessionDeletedError);
    await metadata.fenceOwner('owner');
    await expect(metadata.beginDispatch('owner', 'new-session', 'filed-owner')).rejects.toBeInstanceOf(SessionDeletedError);
    await DynamoDBDocumentClient.from(client()).send(new PutCommand({ TableName: table, Item: { pk: 'SESSIONS#claim-owner', sk: 'CLAIM', destination: 'destination' } }));
    await expect(metadata.beginDispatch('claim-owner', 'new-session', 'filed-claim')).rejects.toBeInstanceOf(SessionClaimError);
  });

  it('keeps an existing dispatch visible through Account Claim and destination deletion', async () => {
    const other = new DynamoDBSessionMetadata(table, client());
    await turn('source', 'session', T1);
    const complete = await other.beginDispatch('source', 'session');
    await metadata.transferOwner('source', 'destination');
    await metadata.fenceOwner('destination');
    await expect(metadata.assertNoDispatch(await tracked({ session_id: 'session', filing_user_id: 'filed-source' }))).rejects.toThrow('Session dispatch is still registered');
    await complete();
    await expect(metadata.assertNoDispatch(await tracked({ session_id: 'session', filing_user_id: 'filed-source' }))).resolves.toBeUndefined();
  });

  it('stores non-expiring identifiable registrations so a crashed dispatcher blocks deletion', async () => {
    await turn('owner', 'session', T1);
    await metadata.beginDispatch('owner', 'session');
    const registration = (await items()).find((item) => item.pk === 'DISPATCH#["filed-owner","session"]');
    expect(registration).toMatchObject({ sk: expect.any(String), dispatcher: expect.any(String), created_at: S1 });
    expect(registration).not.toHaveProperty('ttl');
    await metadata.fence('owner', 'session');
    await expect(metadata.assertNoDispatch(await tracked({ session_id: 'session', filing_user_id: 'filed-owner' }))).rejects.toThrow(`registration=${String(registration?.sk)} dispatcher=${String(registration?.dispatcher)}`);
  });
});

describe('purge recovery across task replacement', () => {
  it('does not create a completed job when acknowledgement has no matching durable job', async () => {
    await expect(metadata.completePurge(await tracked({ session_id: 'missing', filing_user_id: 'filed-owner' }))).rejects.toThrow();
    expect(await items()).toMatchObject([]);
  });

  it('continues a strongly consistent recovery Scan after an empty filtered page', async () => {
    await turn('owner', 'session', T1);
    const documents = DynamoDBDocumentClient.from(client());
    await documents.send(new UpdateCommand({
      TableName: table, Key: { pk: 'SESSIONS#owner', sk: 'SESSION#session' },
      UpdateExpression: 'SET deleted_at = :now', ExpressionAttributeValues: { ':now': S2 },
    }));
    const legacy = (await items()).filter((item) => item.deleted_at !== undefined);
    let scans = 0;
    const recording = client();
    recording.middlewareStack.add((next, context) => async (args) => {
      if (context.commandName !== 'ScanCommand') return next(args);
      expect(args.input).toMatchObject({ ConsistentRead: true });
      scans += 1;
      const output = scans === 1
        ? { $metadata: {}, Items: [], LastEvaluatedKey: { pk: 'unrelated', sk: 'row' } }
        : { $metadata: {}, Items: legacy };
      return { output, response: {} };
    }, { step: 'initialize' });
    expect(await new DynamoDBSessionMetadata(table, recording).pendingPurges()).toMatchObject([
      { session_id: 'session', filing_user_id: 'filed-owner' },
    ]);
    expect(scans).toBe(2);
  });

  it('recovers legacy deletion fences once and preserves their completion through later discovery', async () => {
    await turn('owner', 'session', T1);
    await DynamoDBDocumentClient.from(client()).send(new UpdateCommand({
      TableName: table, Key: { pk: 'SESSIONS#owner', sk: 'SESSION#session' },
      UpdateExpression: 'SET deleted_at = :now REMOVE title', ExpressionAttributeValues: { ':now': S2 },
    }));
    const replacement = new DynamoDBSessionMetadata(table, client());
    const job = { session_id: 'session', filing_user_id: 'filed-owner' };
    expect(await replacement.pendingPurges()).toMatchObject([job]);
    await replacement.completePurge(await tracked(job));
    expect(await new DynamoDBSessionMetadata(table, client()).pendingPurges()).toMatchObject([]);
    expect(await replacement.pendingPurges()).toMatchObject([]);
    await replacement.fence('owner', 'session');
    expect(await replacement.pendingPurges()).toMatchObject([job]);
  });

  it.each([2, 3])('recovers the current owner after interruption before owner tombstone %i', async (interruptedAt) => {
    await turn('retired-a', 'claimed-session', T1);
    await metadata.transferOwner('retired-a', 'owner');
    await metadata.transferOwner('retired-b', 'owner');
    await turn('owner', 'current-session', T1);
    await turn('other-owner', 'other-session', T1);
    let tombstones = 0;
    const interrupted = metadataWith(async (command) => {
      if (command === 'PutItemCommand' && ++tombstones === interruptedAt) throw new Error('task terminated');
    });
    await expect(interrupted.fenceOwner('owner')).rejects.toThrow('task terminated');
    const replacement = new DynamoDBSessionMetadata(table, client());
    expect(await replacement.pendingPurges()).toMatchObject([
      { session_id: 'current-session', filing_user_id: 'filed-owner' },
      { session_id: 'claimed-session', filing_user_id: 'filed-retired-a' },
    ]);
    expect(await replacement.list('owner')).toMatchObject([]);
    await expect(replacement.recordTurn('owner', 'new-session', { filingUserId: 'filed-owner', title: 'Blocked' })).rejects.toBeInstanceOf(SessionDeletedError);
    expect(await replacement.get('other-owner', 'other-session')).toEqual(expect.objectContaining({ session_id: 'other-session' }));
  });

  it.each([1, 2])('recovers account deletion interrupted before Session fence transaction %i', async (interruptedAt) => {
    await turn('owner', 'session-1', T1);
    await turn('owner', 'session-2', T1);
    let fences = 0;
    const interrupted = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand' && ++fences === interruptedAt) throw new Error('task terminated');
    });
    await expect(interrupted.fenceOwner('owner')).rejects.toThrow('task terminated');
    expect((await items()).some((row) => row.sk === 'DELETED')).toBe(true);
    const replacement = new DynamoDBSessionMetadata(table, client());
    const jobs = await replacement.pendingPurges();
    expect(jobs).toMatchObject([
      { session_id: 'session-1', filing_user_id: 'filed-owner' },
      { session_id: 'session-2', filing_user_id: 'filed-owner' },
    ]);
    expect(await replacement.list('owner')).toMatchObject([]);
    await Promise.all(jobs.map(async (job) => replacement.completePurge(await tracked(job))));
    expect(await new DynamoDBSessionMetadata(table, client()).pendingPurges()).toMatchObject([]);
  });
});

describe('dispatch isolation between filing identities', () => {
  it('keeps legacy bare Session registrations as deletion blockers until they are released', async () => {
    const documents = DynamoDBDocumentClient.from(client());
    const Key = { pk: 'DISPATCH#shared', sk: 'legacy-dispatch' };
    await documents.send(new PutCommand({ TableName: table, Item: { ...Key, dispatcher: 'legacy-task' } }));
    await turn('alice', 'shared', T1);
    const alice = { session_id: 'shared', filing_user_id: 'filed-alice' };
    await expect(metadata.assertNoDispatch(await tracked(alice))).rejects.toThrow('legacy-task');
    await documents.send(new DeleteCommand({ TableName: table, Key }));
    await expect(metadata.assertNoDispatch(await tracked(alice))).resolves.toBeUndefined();
  });

  it('registers a claimed Session under its original filing identity rather than the new owner', async () => {
    await turn('source', 'shared', T1);
    await metadata.transferOwner('source', 'destination');
    const complete = await metadata.beginDispatch('destination', 'shared');
    expect((await items()).filter((item) => String(item.pk).startsWith('DISPATCH#'))).toMatchObject([
      expect.objectContaining({ pk: 'DISPATCH#["filed-source","shared"]' }),
    ]);
    await expect(metadata.assertNoDispatch(await tracked({ session_id: 'shared', filing_user_id: 'filed-source' }))).rejects.toThrow('Session dispatch is still registered');
    await complete();
  });

  it('refuses registration when its filing identity changes after the admission pre-read', async () => {
    await turn('owner', 'shared', T1);
    const changed = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand') {
        await DynamoDBDocumentClient.from(client()).send(new UpdateCommand({
          TableName: table, Key: { pk: 'SESSIONS#owner', sk: 'SESSION#shared' },
          UpdateExpression: 'SET filing_user_id = :filing', ExpressionAttributeValues: { ':filing': 'another-filing-user' },
        }));
      }
    });
    await expect(changed.beginDispatch('owner', 'shared')).rejects.toBeInstanceOf(SessionDeletedError);
    expect((await items()).filter((item) => String(item.pk).startsWith('DISPATCH#'))).toMatchObject([]);
  });

  it('does not let another account block deletion of the same public Session ID', async () => {
    await turn('alice', 'shared', T1);
    await turn('bob', 'shared', T1);
    const aliceDone = await metadata.beginDispatch('alice', 'shared');
    const bobDone = await metadata.beginDispatch('bob', 'shared');
    const alice = { session_id: 'shared', filing_user_id: 'filed-alice' };
    const bob = { session_id: 'shared', filing_user_id: 'filed-bob' };
    await metadata.fence('alice', 'shared');
    await expect(metadata.assertNoDispatch(await tracked(alice))).rejects.toThrow('Session dispatch is still registered');
    await aliceDone();
    await expect(metadata.assertNoDispatch(await tracked(alice))).resolves.toBeUndefined();
    await expect(metadata.assertNoDispatch(await tracked(bob))).rejects.toThrow('Session dispatch is still registered');
    await bobDone();
  });
});

describe('Runtime namespace rollout readiness', () => {
  it('refuses a missing readiness marker', async () => {
    await DynamoDBDocumentClient.from(client()).send(new DeleteCommand({ TableName: table, Key: { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED' } }));
    await expect(metadata.checkRuntimeNamespaceReady()).rejects.toThrow('Session Runtime namespace is not ready');
  });

  it.each([false, 'true'])('refuses a readiness marker whose value is %s', async (runtime_namespaced) => {
    await DynamoDBDocumentClient.from(client()).send(new PutCommand({
      TableName: table, Item: { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED', old_chat_retired: runtime_namespaced, memory_broker_only: true },
    }));
    await expect(metadata.checkRuntimeNamespaceReady()).rejects.toThrow('Session Runtime namespace is not ready');
  });

  it('accepts an explicitly ready marker through a strongly consistent read', async () => {
    await DynamoDBDocumentClient.from(client()).send(new PutCommand({
      TableName: table, Item: { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED', old_chat_retired: true, memory_broker_only: true },
    }));
    const recording = client();
    const reads: unknown[] = [];
    recording.middlewareStack.add((next, context) => async (args) => {
      if (context.commandName === 'GetItemCommand') reads.push(args.input);
      return next(args);
    }, { step: 'initialize' });
    await expect(new DynamoDBSessionMetadata(table, recording).checkRuntimeNamespaceReady()).resolves.toBeUndefined();
    expect(reads).toMatchObject([expect.objectContaining({ ConsistentRead: true, Key: { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED' } })]);
  });

  it('propagates failure to read the readiness marker', async () => {
    const failure = new Error('readiness read denied');
    const denied = metadataWith(async (command) => { if (command === 'GetItemCommand') throw failure; });
    await expect(denied.checkRuntimeNamespaceReady()).rejects.toBe(failure);
  });
});

describe('durable Turn summary erasure recovery', () => {
  it('finishes interrupted summary erasure before acknowledging cleanup and preserves other Session records', async () => {
    await turn('alice', 'shared', T1);
    await turn('alice', 'shared#2', T1);
    await turn('bob', 'shared', T1);
    await summarize('alice', 'shared', 'alice-message');
    await summarize('alice', 'shared#2', 'longer-session');
    await summarize('bob', 'shared', 'bob-message');
    const failure = new Error('task terminated during summary deletion');
    const interrupted = metadataWith(async (command) => { if (command === 'DeleteItemCommand') throw failure; });
    await expect(interrupted.fence('alice', 'shared')).rejects.toBe(failure);
    const job = { session_id: 'shared', filing_user_id: 'filed-alice' };
    expect(await metadata.pendingPurges()).toMatchObject([job]);
    expect(await metadata.turnSummaries('filed-alice')).toHaveLength(2);
    await expect(summarize('alice', 'shared', 'late-summary')).rejects.toBeInstanceOf(SessionDeletedError);
    await expect(interrupted.completePurge(await tracked(job))).rejects.toBe(failure);
    expect(await metadata.pendingPurges()).toMatchObject([job]);
    expect((await items()).find((item) => item.pk === 'PURGES')).not.toHaveProperty('completed_at');
    const replacement = new DynamoDBSessionMetadata(table, client());
    await replacement.completePurge(await tracked(job));
    expect(await replacement.pendingPurges()).toMatchObject([]);
    expect(await replacement.turnSummaries('filed-alice')).toMatchObject([
      { session_id: 'shared#2', message_id: 'longer-session', request: 'Request longer-session', completed_at: '2026-01-02T03:04:06.000Z', title: 'Title longer-session', summary: 'Summary of longer-session' },
    ]);
    expect(await replacement.turnSummaries('filed-bob')).toMatchObject([
      { session_id: 'shared', message_id: 'bob-message', request: 'Request bob-message', completed_at: '2026-01-02T03:04:06.000Z', title: 'Title bob-message', summary: 'Summary of bob-message' },
    ]);
  });
});

// A page opened mid-Turn polls while the Session's Turn runs.
describe('the running mark', () => {
  it.each(['ready', 'end'])('does not %s a newer run ID sharing the same start timestamp', async (operation) => {
    await metadata.recordTurn('same-time', 'same-session', { filingUserId: 'f', title: 'first', running: { startedAt: T1, runId: 'first' } });
    await metadata.recordTurn('same-time', 'same-session', { filingUserId: 'f', title: 'second', running: { startedAt: T1, runId: 'second' } });
    if (operation === 'ready') await expect(metadata.turnStarted('same-time', 'same-session', { startedAt: T1, runId: 'first' })).rejects.toThrow();
    else await metadata.turnEnded('same-time', 'same-session', { startedAt: T1, runId: 'first' }, undefined);
    expect(await metadata.get('same-time', 'same-session')).toMatchObject({ turn_running_since: T1, turn_run_id: 'second', turn_preparing: true });
  });

  it('readies and ends a preparing Turn after Account Claim moves its operational row', async () => {
    await metadata.recordTurn('preparing-source', 'claim-running', { filingUserId: 'original-filing', title: 'waiting', running: { startedAt: T1, runId: 'run-claim' } });
    await metadata.transferOwner('preparing-source', 'preparing-destination');
    await metadata.turnStarted('preparing-source', 'claim-running', { startedAt: T1, runId: 'run-claim' });
    const started = await metadata.get('preparing-destination', 'claim-running');
    expect(started).toMatchObject({ filing_user_id: 'original-filing', turn_running_since: T1, turn_run_id: 'run-claim' });
    expect(started).not.toHaveProperty('turn_preparing');
    await metadata.turnEnded('preparing-source', 'claim-running', { startedAt: T1, runId: 'run-claim' }, undefined);
    const ended = await metadata.get('preparing-destination', 'claim-running');
    expect(ended).not.toHaveProperty('turn_running_since');
    expect(ended).not.toHaveProperty('turn_run_id');
    expect(await metadata.get('preparing-source', 'claim-running')).toBeNull();
  });

  it('does not ready a newer Turn when an older RUN_STARTED arrives', async () => {
    await metadata.recordTurn('ready-race', 'same-session', { filingUserId: 'f', title: 'first', running: { startedAt: T1, runId: 'first' } });
    await metadata.recordTurn('ready-race', 'same-session', { filingUserId: 'f', title: 'second', running: { startedAt: T2, runId: 'second' } });
    await expect(metadata.turnStarted('ready-race', 'same-session', { startedAt: T1, runId: 'first' })).rejects.toThrow();
    expect(await metadata.get('ready-race', 'same-session')).toMatchObject({ turn_running_since: T2, turn_run_id: 'second', turn_preparing: true });
  });

  it('does not resurrect a transferred Session deleted before RUN_STARTED', async () => {
    await metadata.recordTurn('deleted-source', 'deleted-running', { filingUserId: 'f', title: 'waiting', running: { startedAt: T1, runId: 'run-deleted' } });
    await metadata.transferOwner('deleted-source', 'deleted-destination');
    await metadata.fence('deleted-destination', 'deleted-running');
    await expect(metadata.turnStarted('deleted-source', 'deleted-running', { startedAt: T1, runId: 'run-deleted' })).rejects.toThrow();
    expect(await metadata.get('deleted-destination', 'deleted-running')).toBeNull();
    expect(await metadata.get('deleted-source', 'deleted-running')).toBeNull();
  });

  const start = (startedAt: string) =>
    metadata.recordTurn('account-1', 'session-1', {
      filingUserId: 'filed-account-1',
      title: 'hello',
      running: { startedAt, runId: `run-${startedAt}` },
    });

  it("marks the Session's Turn running from its start, with its run ID for a Stop", async () => {
    await start(T1);

    expect(await metadata.get('account-1', 'session-1')).toMatchObject({ turn_running_since: T1, turn_run_id: `run-${T1}` });
  });

  it('clears the mark once its Turn ends', async () => {
    await start(T1);

    await metadata.turnEnded('account-1', 'session-1', { startedAt: T1, runId: `run-${T1}` }, undefined);

    const session = await metadata.get('account-1', 'session-1');
    expect(session).not.toHaveProperty('turn_running_since');
    expect(session).not.toHaveProperty('turn_run_id');
  });

  it('records why the Turn failed as its mark clears, until the next Turn starts', async () => {
    const failure = { code: 'PROVIDER_ERROR', message: 'The provider failed' };
    await start(T1);

    await metadata.turnEnded('account-1', 'session-1', { startedAt: T1, runId: `run-${T1}` }, failure);
    const failed = await metadata.get('account-1', 'session-1');
    await start(T2);

    expect(failed).toMatchObject({ turn_failure: failure });
    expect(failed).not.toHaveProperty('turn_running_since');
    expect(await metadata.get('account-1', 'session-1')).not.toHaveProperty('turn_failure');
  });

  it("keeps a newer Turn's mark when an earlier Turn ends", async () => {
    await start(T1);
    await start(T2);

    await metadata.turnEnded('account-1', 'session-1', { startedAt: T1, runId: `run-${T1}` }, { code: 'PROVIDER_ERROR', message: 'The provider failed' });

    const session = await metadata.get('account-1', 'session-1');
    expect(session).toMatchObject({ turn_running_since: T2, turn_run_id: `run-${T2}` });
    expect(session).not.toHaveProperty('turn_failure');
  });

  // The summary runs on after the stream closed, so it can fail on either side of turnEnded.
  const summaryFailure = { code: 'TURN_SUMMARY_FAILED', message: 'The Turn summary could not be saved: throttled' };

  it.each(['before', 'after'])('records why the Turn summary failed %s the Turn ends', async (side) => {
    const running = { startedAt: T1, runId: `run-${T1}` };
    await start(T1);

    if (side === 'after') await metadata.turnEnded('account-1', 'session-1', running, undefined);
    await metadata.turnSummaryFailed('account-1', 'session-1', running, summaryFailure);
    if (side === 'before') await metadata.turnEnded('account-1', 'session-1', running, undefined);

    const session = await metadata.get('account-1', 'session-1');
    expect(session).toMatchObject({ turn_failure: { ...summaryFailure, runId: running.runId } });
    expect(session).not.toHaveProperty('turn_run_id');
  });

  it("keeps a newer Turn's mark when an earlier Turn's summary fails", async () => {
    await start(T1);
    await start(T2);

    await metadata.turnSummaryFailed('account-1', 'session-1', { startedAt: T1, runId: `run-${T1}` }, summaryFailure);

    const session = await metadata.get('account-1', 'session-1');
    expect(session).toMatchObject({ turn_running_since: T2, turn_run_id: `run-${T2}` });
    expect(session).not.toHaveProperty('turn_failure');
  });

  it("does not mark a newer, finished Turn failed when an earlier Turn's summary fails", async () => {
    await start(T1);
    await start(T2);
    await metadata.turnEnded('account-1', 'session-1', { startedAt: T2, runId: `run-${T2}` }, undefined);

    await metadata.turnSummaryFailed('account-1', 'session-1', { startedAt: T1, runId: `run-${T1}` }, summaryFailure);

    expect(await metadata.get('account-1', 'session-1')).not.toHaveProperty('turn_failure');
  });

  it("does not mark a later scheduled Turn failed when an earlier Turn's summary fails", async () => {
    await start(T1);
    await metadata.turnEnded('account-1', 'session-1', { startedAt: T1, runId: `run-${T1}` }, undefined);
    await metadata.recordTurn('account-1', 'session-1', { filingUserId: 'filed-account-1', title: 'hello' });

    await metadata.turnSummaryFailed('account-1', 'session-1', { startedAt: T1, runId: `run-${T1}` }, summaryFailure);

    expect(await metadata.get('account-1', 'session-1')).not.toHaveProperty('turn_failure');
  });

  it('creates no Session for a summary failure', async () => {
    await metadata.turnSummaryFailed('account-1', 'never-recorded', { startedAt: T1, runId: `run-${T1}` }, summaryFailure);

    expect(await metadata.get('account-1', 'never-recorded')).toBeNull();
  });
});

describe('running identity retry', () => {
  it('keeps the running identity when the first model-less Turn retries a competing writer', async () => {
    let writes = 0;
    const racing = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand' && ++writes === 1) {
        await metadata.recordTurn('account-1', 'legacy', { filingUserId: 'original', title: 'original', provider: 'anthropic' });
      }
    });
    await racing.recordTurn('account-1', 'legacy', { filingUserId: 'f', title: 't', running: { startedAt: T1, runId: 'raced-run' }, messageId: 'raced-message' });
    expect(writes).toBe(2);
    expect(await metadata.get('account-1', 'legacy')).toMatchObject({ turn_running_since: T1, turn_run_id: 'raced-run', latest_message_id: 'raced-message' });
  });
});

describe('Account Claim failure recovery', () => {
  it('retries a partial transfer without refiling checkpoints or losing a bound provider', async () => {
    await metadata.recordTurn('claim-source', 'a-bound', { filingUserId: 'original-filing', title: 'bound', provider: 'openai' });
    await metadata.recordTurn('claim-source', 'b-unbound', { filingUserId: 'original-filing', title: 'unbound' });
    const failure = new Error('second-write outage');
    let writes = 0;
    const failing = metadataWith(async (command) => {
      if (command === 'TransactWriteItemsCommand' && ++writes === 2) throw failure;
    });
    await expect(failing.transferOwner('claim-source', 'claim-destination')).rejects.toBe(failure);
    expect(await metadata.get('claim-destination', 'a-bound')).toEqual(expect.objectContaining({ filing_user_id: 'original-filing', provider: 'openai' }));
    expect(await metadata.get('claim-source', 'b-unbound')).not.toBeNull();
    await expect(metadata.recordTurn('claim-source', 'blocked', { filingUserId: 'original-filing', title: 'blocked', provider: 'openai' })).rejects.toBeInstanceOf(SessionClaimError);
    await metadata.transferOwner('claim-source', 'claim-destination');
    await metadata.transferOwner('claim-source', 'claim-destination');
    expect(await metadata.recordTurn('claim-destination', 'a-bound', { filingUserId: 'replacement-filing', title: 'resumed', provider: 'openai' })).toBe('original-filing');
    await expect(metadata.recordTurn('claim-destination', 'a-bound', { filingUserId: 'replacement-filing', title: 'wrong provider', provider: 'anthropic' })).rejects.toBeInstanceOf(SessionProviderError);
    expect(await metadata.recordTurn('claim-destination', 'b-unbound', { filingUserId: 'replacement-filing', title: 'first model', provider: 'openai' })).toBe('original-filing');
    expect(await metadata.get('claim-source', 'a-bound')).toBeNull();
    expect(await metadata.get('claim-source', 'b-unbound')).toBeNull();
    expect((await items()).filter((item) => item.sk === 'RETIRED#claim-source')).toHaveLength(1);
  });
});


describe('ownsMainChat', () => {
  it('recognizes only the assigned owner before its first Turn without allocating on a probe', async () => {
    expect(await metadata.ownsMainChat('unassigned-account', 'unknown-session')).toBe(false);
    expect(await items()).toMatchObject([]);
    const id = await metadata.mainChat('account-1', 'filed-account-1');
    expect(await metadata.ownsMainChat('account-1', id)).toBe(true);
    expect(await metadata.ownsMainChat('account-2', id)).toBe(false);
    expect(await metadata.ownsMainChat('account-1', 'unknown-session')).toBe(false);
    expect(await metadata.get('account-1', id)).toMatchObject({ session_id: id, filing_user_id: 'filed-account-1', runtime_generation: 'tracked-v1' });
  });

  it('rejects an assigned Main Chat after its Session is fenced', async () => {
    const id = await metadata.mainChat('account-1', 'filed-account-1');
    await turn('account-1', id, T1);
    await metadata.fence('account-1', id);
    expect(await metadata.ownsMainChat('account-1', id)).toBe(false);
  });

  it('rejects an assigned Main Chat after its owner is fenced without a first Turn', async () => {
    const id = await metadata.mainChat('account-1', 'filed-account-1');
    await metadata.fenceOwner('account-1');
    expect(await metadata.ownsMainChat('account-1', id)).toBe(false);
  });

  it('rejects the retired owner after Account Claim', async () => {
    const id = await metadata.mainChat('account-1', 'filed-account-1');
    await metadata.transferOwner('account-1', 'account-2');
    expect(await metadata.ownsMainChat('account-1', id)).toBe(false);
    expect(await metadata.ownsMainChat('account-2', id)).toBe(true);
  });

  it('propagates a failed read', async () => {
    const failing = metadataWith(async () => { throw new Error('Main Chat read denied'); });
    await expect(failing.ownsMainChat('account-1', 'unknown-session')).rejects.toThrow('Main Chat read denied');
  });
});


describe('tracked new Session Runtime admission', () => {
  const closed = async () => {
    await DynamoDBDocumentClient.from(client()).send(new PutCommand({ TableName: table,
      Item: { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED', old_chat_retired: true, memory_broker_only: true },
    }));
  };

  it('atomically gives concurrent first admissions one opaque binding and retains it through Claim and recovery', async () => {
    await closed();
    await Promise.all([turn('alice', 'shared', T1), turn('alice', 'shared', T1)]);
    const admitted = await metadata.get('alice', 'shared');
    expect(admitted).toMatchObject({ runtime_generation: 'tracked-v1', runtime_binding: expect.stringMatching(/^runtime-[0-9a-f-]{36}$/) });
    await turn('bob', 'shared', T1);
    const bob = await metadata.get('bob', 'shared');
    expect(bob).toMatchObject({ runtime_generation: 'tracked-v1', runtime_binding: expect.stringMatching(/^runtime-[0-9a-f-]{36}$/) });
    expect(bob).not.toMatchObject({ runtime_binding: (admitted as unknown as { runtime_binding: string }).runtime_binding });
    await metadata.transferOwner('alice', 'destination');
    expect(await metadata.get('destination', 'shared')).toMatchObject({ ...admitted, pk: 'SESSIONS#destination' });
    await metadata.fence('destination', 'shared');
    expect(await new DynamoDBSessionMetadata(table, client()).pendingPurges()).toMatchObject([expect.objectContaining({
      session_id: 'shared', filing_user_id: 'filed-alice',
      runtime_generation: 'tracked-v1', runtime_binding: (admitted as unknown as { runtime_binding: string }).runtime_binding,
    })]);
  });

  it('does not silently promote an existing legacy Session and leaves its fenced purge pending', async () => {
    await DynamoDBDocumentClient.from(client()).send(new PutCommand({ TableName: table, Item: {
      pk: 'SESSIONS#alice', sk: 'SESSION#legacy', session_id: 'legacy', filing_user_id: 'filed-alice',
      title: 'Legacy', created_at: T1, updated_at: T1,
    } }));
    await closed();
    await turn('alice', 'legacy', T2);
    const legacy = await metadata.fence('alice', 'legacy');
    expect(legacy).toMatchObject({ session_id: 'legacy', filing_user_id: 'filed-alice' });
    expect(legacy).not.toHaveProperty('runtime_generation');
    await expect(metadata.assertNoDispatch(defined(legacy, 'stored Session identity'))).rejects.toThrow('legacy settlement is unproved');
    await expect(metadata.completePurge(defined(legacy, 'stored Session identity'))).rejects.toThrow('legacy settlement is unproved');
    expect(await metadata.pendingPurges()).toMatchObject([{ session_id: 'legacy', filing_user_id: 'filed-alice' }]);
  });

  it('rejects new tracked admission before the closed retirement prerequisite', async () => {
    await DynamoDBDocumentClient.from(client()).send(new DeleteCommand({ TableName: table, Key: { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED' } }));
    await expect(turn('alice', 'new', T1)).rejects.toThrow('old Chat dispatchers');
    expect(await metadata.get('alice', 'new')).toBeNull();
    await closed();
    await turn('alice', 'new', T1);
    expect(await metadata.get('alice', 'new')).toMatchObject({ runtime_generation: 'tracked-v1' });
  });
});


describe('Main Chat tracked admission through Claim', () => {
  it('keeps the same opaque binding and original filing identity when Claim precedes warmup and the first Turn', async () => {
    const id = await metadata.mainChat('source', 'original-filing');
    await metadata.transferOwner('source', 'destination');
    const admitted = await metadata.beginDispatch('destination', id, 'original-filing');
    expect(admitted.session).toMatchObject({ session_id: id, filing_user_id: 'original-filing', runtime_generation: 'tracked-v1', runtime_binding: expect.stringMatching(/^runtime-[0-9a-f-]{36}$/) });
    expect(await metadata.list('destination')).toEqual([]);
    await admitted();
    await expect(metadata.recordTurn('destination', id, { filingUserId: 'destination-filing', title: 'First Turn' })).resolves.toBe('original-filing');
    expect(await metadata.get('destination', id)).toMatchObject({ ...admitted.session, title: 'First Turn' });
  });

  it('moves an already warmed Session with its binding even before it has a visible title', async () => {
    const id = await metadata.mainChat('source', 'original-filing');
    const admitted = await metadata.beginDispatch('source', id, 'original-filing');
    await metadata.transferOwner('source', 'destination');
    expect(await metadata.get('destination', id)).toMatchObject(defined(admitted.session, 'stored Session identity'));
    await expect(metadata.assertNoDispatch(defined(admitted.session, 'stored Session identity'))).rejects.toThrow('Session dispatch is still registered');
    await admitted();
    await expect(metadata.recordTurn('destination', id, { filingUserId: 'another-filing', title: 'First Turn' })).resolves.toBe('original-filing');
  });

  it('never promotes an existing MAIN-only legacy Session or an unknown future generation', async () => {
    const documents = DynamoDBDocumentClient.from(client());
    await documents.send(new PutCommand({ TableName: table, Item: { pk: 'SESSIONS#legacy', sk: 'MAIN', session_id: 'legacy-main' } }));
    await expect(metadata.beginDispatch('legacy', 'legacy-main', 'original-filing')).rejects.toThrow('legacy settlement is unproved');
    expect(await metadata.get('legacy', 'legacy-main')).toBeNull();
    await expect(metadata.fenceOwner('legacy')).rejects.toThrow('account history deletion remains pending');
    await turn('future', 'unknown-generation', T1);
    const fenced = await metadata.fence('future', 'unknown-generation');
    await expect(metadata.completePurge({ ...defined(fenced, 'stored Session identity'), runtime_generation: 'tracked-v2' })).rejects.toThrow('legacy settlement is unproved');
    expect((await items()).find((item) => item.pk === 'SESSIONS#legacy' && item.sk === 'DELETED')).toMatchObject({ legacy_main_pending: 'legacy-main' });
  });
});


it('keeps account erasure pending for a legacy MAIN-only warmup across recovery without blocking tracked cleanup', async () => {
  await DynamoDBDocumentClient.from(client()).send(new PutCommand({ TableName: table, Item: { pk: 'SESSIONS#legacy', sk: 'MAIN', session_id: 'legacy-warmup' } }));
  await turn('tracked', 'tracked-side', T1);
  await metadata.fence('tracked', 'tracked-side');
  await expect(metadata.fenceOwner('legacy')).rejects.toThrow('account history deletion remains pending');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const replacement = new DynamoDBSessionMetadata(table, client());
    const jobs = await replacement.pendingPurges();
    expect(jobs).toMatchObject([{ session_id: 'tracked-side', filing_user_id: 'filed-tracked', runtime_generation: 'tracked-v1' }]);
    expect((await items()).find((item) => item.pk === 'SESSIONS#legacy' && item.sk === 'DELETED')).toMatchObject({ legacy_main_pending: 'legacy-warmup' });
    await replacement.completePurge(defined(jobs[0], 'stored Session identity'));
    await expect(replacement.fenceOwner('legacy')).rejects.toThrow('account history deletion remains pending');
  } finally { errors.mockRestore(); }
});

it('retains the source Main Chat binding as a Side Chat when Claim destination already has Main Chat', async () => {
  const sourceMain = await metadata.mainChat('source', 'filed-source');
  const destinationMain = await metadata.mainChat('destination', 'filed-destination');
  const original = (await items()).find((item) => item.pk === 'SESSIONS#source' && item.sk === 'MAIN');
  await metadata.transferOwner('source', 'destination');
  await metadata.recordTurn('destination', sourceMain, { filingUserId: 'filed-destination', title: 'Claimed Main Chat' });
  expect(await metadata.mainChat('destination', 'filed-destination')).toBe(destinationMain);
  expect(await metadata.get('destination', sourceMain)).toMatchObject({
    filing_user_id: 'filed-source', runtime_generation: 'tracked-v1', runtime_binding: defined(original, 'stored Session identity').runtime_binding,
  });
});

it.each(['owner deletion', 'Account Claim'])('refuses a new Main Chat allocation after %s', async (fence) => {
  if (fence === 'owner deletion') await metadata.fenceOwner('source');
  else await metadata.transferOwner('source', 'destination');
  await expect(metadata.mainChat('source', 'filed-source')).rejects.toThrow();
  expect((await items()).filter((item) => item.pk === 'SESSIONS#source' && item.sk === 'MAIN')).toEqual([]);
});

it('keeps a claimed legacy MAIN-only Session unknown when the destination has its own Main Chat', async () => {
  await DynamoDBDocumentClient.from(client()).send(new PutCommand({ TableName: table, Item: { pk: 'SESSIONS#source', sk: 'MAIN', session_id: 'legacy-source-main' } }));
  await metadata.mainChat('destination', 'filed-destination');
  await metadata.transferOwner('source', 'destination');
  await expect(metadata.recordTurn('destination', 'legacy-source-main', { filingUserId: 'filed-destination', title: 'Must remain unknown' })).rejects.toThrow('legacy settlement is unproved');
  expect(await metadata.get('destination', 'legacy-source-main')).toBeNull();
});

it('admits concurrent first model Turns on the same provider with one binding', async () => {
  const modelTurn = { filingUserId: 'original-filing', title: 'First Turn', provider: 'anthropic' };
  await expect(Promise.all([metadata.recordTurn('model-owner', 'concurrent-model', modelTurn), metadata.recordTurn('model-owner', 'concurrent-model', modelTurn)])).resolves.toEqual(['original-filing', 'original-filing']);
  expect(await metadata.get('model-owner', 'concurrent-model')).toMatchObject({ provider: 'anthropic', runtime_generation: 'tracked-v1', runtime_binding: expect.stringMatching(/^runtime-[0-9a-f-]{36}$/) });
});

it('retains one legacy continuation binding through concurrent registration, restart, Claim and pending purge', async () => {
  await DynamoDBDocumentClient.from(client()).send(new PutCommand({ TableName: table, Item: {
    pk: 'SESSIONS#source', sk: 'SESSION#legacy-continuation', session_id: 'legacy-continuation', filing_user_id: 'original-filing',
    title: 'Original history', created_at: T1, updated_at: T1,
  } }));
  const [first, second] = await Promise.all([metadata.beginDispatch('source', 'legacy-continuation'), metadata.beginDispatch('source', 'legacy-continuation')]);
  expect(first.session).toEqual(second.session);
  expect(first.session).toMatchObject({ session_id: 'legacy-continuation', filing_user_id: 'original-filing', runtime_generation: 'continuation-v1', legacy_settlement_unproved: true, runtime_binding: expect.stringMatching(/^runtime-[0-9a-f-]{36}$/) });
  const replacement = new DynamoDBSessionMetadata(table, client());
  const restarted = await replacement.beginDispatch('source', 'legacy-continuation');
  expect(restarted.session).toEqual(first.session);
  await Promise.all([first(), second(), restarted()]);
  await metadata.transferOwner('source', 'destination');
  const claimed = await metadata.beginDispatch('destination', 'legacy-continuation');
  expect(claimed.session).toEqual(first.session);
  await claimed();
  await metadata.recordTurn('destination', 'legacy-continuation', { filingUserId: 'new-filing', title: 'Next Turn' });
  expect(await metadata.get('destination', 'legacy-continuation')).toMatchObject(first.session ?? {});
  const fenced = defined(await metadata.fence('destination', 'legacy-continuation'), 'fenced continuation');
  expect(fenced).toMatchObject(first.session ?? {});
  await expect(metadata.assertNoDispatch(fenced)).rejects.toThrow('legacy settlement is unproved');
  await expect(metadata.completePurge(fenced)).rejects.toThrow('legacy settlement is unproved');
  expect(await replacement.pendingPurges()).toContainEqual(first.session);
});

it.each([
  { runtime_generation: 'tracked-v2', runtime_binding: 'runtime-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
  { runtime_generation: 'tracked-v1', runtime_binding: 'runtime-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', legacy_settlement_unproved: true },
  { runtime_binding: 'runtime-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
])('refuses to overwrite an unproved Runtime identity %j', async (identity) => {
  await DynamoDBDocumentClient.from(client()).send(new PutCommand({ TableName: table, Item: {
    pk: 'SESSIONS#source', sk: 'SESSION#unproved', session_id: 'unproved', filing_user_id: 'original-filing',
    title: 'Original', created_at: T1, updated_at: T1, ...identity,
  } }));
  await expect(metadata.beginDispatch('source', 'unproved')).rejects.toThrow('Session Runtime binding is unproved');
  expect(await metadata.get('source', 'unproved')).toMatchObject(identity);
  const fenced = defined(await metadata.fence('source', 'unproved'), 'fenced unproved identity');
  await expect(metadata.assertNoDispatch(fenced)).rejects.toThrow('legacy settlement is unproved');
});

it('requires closed retirement before allocating a legacy continuation', async () => {
  const documents = DynamoDBDocumentClient.from(client());
  await documents.send(new PutCommand({ TableName: table, Item: {
    pk: 'SESSIONS#source', sk: 'SESSION#legacy', session_id: 'legacy', filing_user_id: 'original-filing', title: 'Original', created_at: T1, updated_at: T1,
  } }));
  await documents.send(new DeleteCommand({ TableName: table, Key: { pk: 'RUNTIME_DISPATCHERS', sk: 'CLOSED' } }));
  await expect(metadata.beginDispatch('source', 'legacy')).rejects.toThrow('old Chat dispatchers');
  expect(await metadata.get('source', 'legacy')).not.toHaveProperty('runtime_binding');
  expect((await items()).filter((item) => String(item.pk).startsWith('DISPATCH#'))).toEqual([]);
});

it('retains a continuation allocated after Account Claim takes its Session snapshot', async () => {
  const running = { startedAt: T1, runId: 'accepted-legacy-turn' };
  await DynamoDBDocumentClient.from(client()).send(new PutCommand({ TableName: table, Item: {
    pk: 'SESSIONS#source', sk: 'SESSION#legacy-claim-race', session_id: 'legacy-claim-race', filing_user_id: 'original-filing',
    title: 'Original', created_at: T1, updated_at: T1, turn_running_since: T1, turn_run_id: running.runId,
  } }));
  let queries = 0;
  let admitted: SessionPurge | undefined;
  const claiming = metadataWith(async (command) => {
    if (command !== 'QueryCommand' || ++queries !== 2) return undefined;
    const snapshot = (await items()).filter((item) => item.pk === 'SESSIONS#source' && item.sk === 'SESSION#legacy-claim-race');
    const complete = await metadata.beginDispatch('source', 'legacy-claim-race', undefined, running);
    admitted = complete.session;
    await complete();
    return { $metadata: {}, Items: snapshot };
  });
  await claiming.transferOwner('source', 'destination');
  expect(admitted).toMatchObject({ runtime_generation: 'continuation-v1', legacy_settlement_unproved: true });
  expect(await metadata.get('destination', 'legacy-claim-race')).toMatchObject(defined(admitted, 'admitted continuation'));
  const next = await metadata.beginDispatch('destination', 'legacy-claim-race', undefined, running);
  expect(next.session).toEqual(admitted);
  await next();
});
