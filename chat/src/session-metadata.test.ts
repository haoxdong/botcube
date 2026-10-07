import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../../../tests/chat/fakes/stack.js';
import { DynamoDBSessionMetadata, SessionDeletedError, SessionProviderError, SessionClaimError } from './session-metadata.js';

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
  return (Items ?? []).sort((a, b) => `${a.pk}|${a.sk}`.localeCompare(`${b.pk}|${b.sk}`));
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
    const racing = metadataWith(async (command) => {
      if (command !== 'GetItemCommand' || removed) return;
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
    expect(await metadata.list('account-1')).toEqual([expect.objectContaining({ provider: 'anthropic' })]);
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
    expect(await items()).toEqual([expect.objectContaining({ provider_pending: true })]);
    expect(await metadata.get('account-1', 'session-1')).not.toHaveProperty('provider_pending');
    expect(await metadata.list('account-1')).toEqual([expect.not.objectContaining({ provider_pending: true })]);
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

    expect(await items()).toEqual([
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

    expect(await items()).toEqual([
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

    expect(await items()).toEqual([expect.objectContaining({ sk: 'SESSION#session-1', provider: 'openai' })]);
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

    expect(await metadata.list('account-1')).toEqual([
      expect.objectContaining({ session_id: 'session-b', updated_at: S3 }),
      expect.objectContaining({ session_id: 'session-c', updated_at: S2 }),
      expect.objectContaining({ session_id: 'session-a', updated_at: S1 }),
    ]);
  });

  it('keeps Sessions with the same last activity in Session ID order', async () => {
    await turn('account-1', 'session-a', T1);
    await turn('account-1', 'session-b', T1);
    await turn('account-1', 'session-c', T1);

    expect((await metadata.list('account-1')).map((session) => session.session_id)).toEqual([
      'session-a',
      'session-b',
      'session-c',
    ]);
  });

  it("leaves out the owner's fence and retired IDs", async () => {
    await turn('account-2', 'session-2', T1);
    await metadata.transferOwner('account-2', 'account-1');
    await metadata.fenceOwner('account-3');

    expect((await metadata.list('account-1')).map((session) => session.session_id)).toEqual(['session-2']);
    expect(await metadata.list('account-3')).toEqual([]);
  });
});

describe('get', () => {
  it("returns the owner's Session", async () => {
    await turn('account-1', 'session-1', T1, 'hello');

    expect(await metadata.get('account-1', 'session-1')).toEqual({
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
    };
    expect(await fence('account-1', 'session-1', T2)).toEqual(fenced);
    expect(await items()).toEqual([{ ...fenced, provider_pending: true }]);
  });

  it('keeps the first fence when fenced again', async () => {
    await turn('account-1', 'session-1', T1);
    await fence('account-1', 'session-1', T2);

    expect(await fence('account-1', 'session-1', T3)).toEqual(expect.objectContaining({ deleted_at: S2 }));
  });

  it('returns null and stores nothing when the owner has no such Session', async () => {
    await turn('account-2', 'session-1', T1);

    expect(await fence('account-1', 'session-1', T2)).toBeNull();
    expect(await items()).toEqual([expect.objectContaining({ pk: 'SESSIONS#account-2', sk: 'SESSION#session-1' })]);
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

    expect(await metadata.turnSummaries('filed-account-1')).toEqual([summarized('session-1#2', 'message-2')]);
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

    expect(await metadata.turnSummaries('filed-account-1')).toEqual([
      summarized('session-1', 'message-1'),
      summarized('session-1', 'message-2'),
    ]);
    expect(await metadata.turnSummaries('filed-account-2')).toEqual([]);
  });

  it('keeps the latest summary of a Turn summarized again', async () => {
    await turn('account-1', 'session-1', T1);
    await summarize('account-1', 'session-1', 'message-1');
    await metadata.saveTurnSummary(
      'account-1',
      { sessionId: 'session-1', filingUserId: 'filed-account-1', messageId: 'message-1' },
      { request: 'Asked again', completedAt: T3, summary: { title: 'Retitled', summary: 'Resummarized' } },
    );

    expect(await metadata.turnSummaries('filed-account-1')).toEqual([
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

    expect(await metadata.turnSummaries('filed-account-1')).toEqual([
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

    expect(await metadata.turnSummaries('filed-account-1')).toEqual([
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
    expect(await metadata.turnSummaries('filed-account-1')).toEqual([]);
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
    expect(await metadata.turnSummaries('filed-account-1')).toEqual([]);
    expect(await metadata.turnSummaries('filed-account-2')).toEqual([]);
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
    expect(await metadata.turnSummaries('filed-account-1')).toEqual([]);
  });

  it.each([
    { request: 'Request', completedAt: T2 },
    { request: 'Request', completedAt: T2, failed: 'Model overloaded' },
  ])('preserves the accepted claimed Turn Activity fields without a summary: %j', async (finished) => {
    await turn('account-1', 'session-1', T1);
    await metadata.transferOwner('account-1', 'account-2');
    await metadata.saveTurnSummary('account-1', { sessionId: 'session-1', filingUserId: 'filed-account-1', messageId: 'message-1' }, finished);
    expect(await metadata.turnSummaries('filed-account-1')).toEqual([
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

    expect(await metadata.turnSummaries('filed-account-1')).toEqual([
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
    await metadata.mainChat('account-2');
    await summarize('account-2', 'session-2', 'message-1');

    const sessions = await metadata.allSessions();

    expect(sessions.map(({ owner, session }) => [owner, session.session_id, session.filing_user_id]).sort()).toEqual([
      ['account-1', 'session-1', 'filed-account-1'],
      ['account-2', 'session-2', 'filed-account-2'],
    ]);
  });
});

describe('mainChat', () => {
  it('assigns the owner a Main Chat once and returns it on every later call', async () => {
    const id = await metadata.mainChat('account-1');

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(await metadata.mainChat('account-1')).toBe(id);
    expect(await metadata.mainChat('account-2')).not.toBe(id);
    expect(await items()).toEqual([
      { pk: 'SESSIONS#account-1', sk: 'MAIN', session_id: id },
      expect.objectContaining({ pk: 'SESSIONS#account-2', sk: 'MAIN' }),
    ]);
  });

  it('lands a first call that loses the race in the Main Chat assigned first', async () => {
    let first = true;
    const racing = metadataWith(async (command) => {
      if (command === 'PutItemCommand' && first) {
        first = false;
        await metadata.mainChat('account-1');
      }
    });

    const id = await racing.mainChat('account-1');

    expect(await items()).toEqual([{ pk: 'SESSIONS#account-1', sk: 'MAIN', session_id: id }]);
  });

  it('passes on a failure other than a lost race', async () => {
    const failure = new Error('throttled');
    const failing = metadataWith(async (command) => {
      if (command === 'PutItemCommand') throw failure;
    });

    await expect(failing.mainChat('account-1')).rejects.toBe(failure);
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

    expect(fenced.map((session) => [session.session_id, (session as { deleted_at?: string }).deleted_at])).toEqual([
      ['session-2-fenced', S1],
      ['session-1', S3],
      ['session-1-fenced', S2],
      ['session-2', S3],
    ]);
    expect(
      (await items()).map(({ pk, sk, deleted_at }) => ({ pk, sk, deleted_at })),
    ).toEqual([
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
      if (command === 'UpdateItemCommand') {
        await documents.send(
          new DeleteCommand({ TableName: table, Key: { pk: 'SESSIONS#account-1', sk: 'SESSION#session-1' } }),
        );
      }
    });

    expect(await racing.fenceOwner('account-1')).toEqual([]);
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

    expect(await items()).toEqual([
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
    expect(await items()).toEqual([
      expect.objectContaining({ pk: 'SESSIONS#account-1', sk: 'RETIRED#account-2' }),
      expect.objectContaining({ pk: 'SESSIONS#account-1', sk: 'SESSION#session-1', filing_user_id: 'filed-account-1' }),
      { pk: 'SESSIONS#account-2', sk: 'CLAIM', destination: 'account-1' },
      expect.objectContaining({ pk: 'SESSIONS#account-2', sk: 'SESSION#session-1' }),
    ]);
  });
});

describe('transferOwner of the Main Chat', () => {
  it("makes the source's Main Chat the destination's when the destination has none", async () => {
    const sourceMain = await metadata.mainChat('account-2');

    await metadata.transferOwner('account-2', 'account-1');

    expect(await metadata.mainChat('account-1')).toBe(sourceMain);
  });

  it("keeps the destination's own Main Chat", async () => {
    await metadata.mainChat('account-2');
    const destinationMain = await metadata.mainChat('account-1');

    await metadata.transferOwner('account-2', 'account-1');

    expect(await metadata.mainChat('account-1')).toBe(destinationMain);
  });

  it('assigns nothing when the source has no Main Chat', async () => {
    await metadata.transferOwner('account-2', 'account-1');

    expect(await items()).toEqual([{ pk: 'SESSIONS#account-1', sk: 'RETIRED#account-2', retired_id: 'account-2' }, { pk: 'SESSIONS#account-2', sk: 'CLAIM', destination: 'account-1' }]);
  });

  it('passes on a failure other than a destination Main Chat', async () => {
    await metadata.mainChat('account-2');
    const failure = new Error('throttled');
    let puts = 0;
    // The first two puts fence Claim and record its retired ID; the third assigns Main Chat.
    const failing = metadataWith(async (command) => {
      if (command === 'PutItemCommand' && ++puts === 3) throw failure;
    });

    await expect(failing.transferOwner('account-2', 'account-1')).rejects.toBe(failure);
    expect(puts).toBe(3);
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
    ['mainChat', (m: DynamoDBSessionMetadata) => metadata.mainChat('account-1').then(() => m.mainChat('account-1')), 'GetItemCommand'],
  ] as const)('%s reads consistently', async (_name, operation, command) => {
    expect(await readsOf(operation)).toEqual(_name === 'recordTurn' ? [[command, true], [command, true]] : [[command, true]]);
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
    expect(await items()).toEqual([]);
    const id = await metadata.mainChat('account-1');
    expect(await metadata.ownsMainChat('account-1', id)).toBe(true);
    expect(await metadata.ownsMainChat('account-2', id)).toBe(false);
    expect(await metadata.ownsMainChat('account-1', 'unknown-session')).toBe(false);
    expect(await metadata.get('account-1', id)).toBeNull();
  });

  it('rejects an assigned Main Chat after its Session is fenced', async () => {
    const id = await metadata.mainChat('account-1');
    await turn('account-1', id, T1);
    await metadata.fence('account-1', id);
    expect(await metadata.ownsMainChat('account-1', id)).toBe(false);
  });

  it('rejects an assigned Main Chat after its owner is fenced without a first Turn', async () => {
    const id = await metadata.mainChat('account-1');
    await metadata.fenceOwner('account-1');
    expect(await metadata.ownsMainChat('account-1', id)).toBe(false);
  });

  it('rejects the retired owner after Account Claim', async () => {
    const id = await metadata.mainChat('account-1');
    await metadata.transferOwner('account-1', 'account-2');
    expect(await metadata.ownsMainChat('account-1', id)).toBe(false);
    expect(await metadata.ownsMainChat('account-2', id)).toBe(true);
  });

  it('propagates a failed read', async () => {
    const failing = metadataWith(async () => { throw new Error('Main Chat read denied'); });
    await expect(failing.ownsMainChat('account-1', 'unknown-session')).rejects.toThrow('Main Chat read denied');
  });
});
