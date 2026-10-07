import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable } from '../../../tests/chat/fakes/stack.js';
import { DynamoDBSessionMetadata, SessionDeletedError } from './session-metadata.js';

let table: string;
let client: DynamoDBClient;
let metadata: DynamoDBSessionMetadata;

beforeEach(async () => {
  table = `chat-${Math.random().toString(36).slice(2)}`;
  await createChatTable(inject('dynamodbEndpoint'), table);
  client = new DynamoDBClient({
    region: 'us-east-1',
    endpoint: inject('dynamodbEndpoint'),
    credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
  });
  metadata = new DynamoDBSessionMetadata(table, client);
});

/** Reject an unexpected retry so a deletion or preserved binding fails by assertion, not timeout. */
function refuseTransactionRetry(): void {
  let transactions = 0;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName === 'TransactWriteItemsCommand') {
        transactions += 1;
        if (transactions > 1) throw new Error('The Session write retried without a competing writer');
      }
      return next(args);
    },
    { step: 'initialize' },
  );
}

describe('model-less Turns after a Session already exists', () => {
  it.each([undefined, 'anthropic', 'openai'])('preserves a Session first recorded with provider %s', async (provider) => {
    await metadata.recordTurn('owner', 'conversation', { filingUserId: 'original-filing-user', title: 'Original', ...(provider === undefined ? {} : { provider }) });
    refuseTransactionRetry();

    await expect(metadata.recordTurn('owner', 'conversation', { filingUserId: 'replacement', title: 'Later' }))
      .resolves.toBe('original-filing-user');
    const session = await metadata.get('owner', 'conversation');
    expect(session).toEqual(expect.objectContaining({
      session_id: 'conversation', filing_user_id: 'original-filing-user', title: 'Original',
    }));
    if (provider === undefined) expect(session).not.toHaveProperty('provider');
    else expect(session).toHaveProperty('provider', provider);
  });

  it('rejects a model-less Turn after deletion without retrying its fenced Session', async () => {
    await metadata.recordTurn('owner', 'conversation', { filingUserId: 'filing-user', title: 'Original' });
    await metadata.fence('owner', 'conversation');
    refuseTransactionRetry();

    await expect(metadata.recordTurn('owner', 'conversation', { filingUserId: 'filing-user', title: 'Later' }))
      .rejects.toBeInstanceOf(SessionDeletedError);
    expect(await metadata.get('owner', 'conversation')).toBeNull();
  });
});

describe('serialized provider-binding writes', () => {
  it.each([
    ['anthropic', false],
    ['openai', true],
  ] as const)('sends only the expression values used by a %s binding', async (provider, needsPending) => {
    const writes: { TransactItems: { Update?: { ExpressionAttributeValues: Record<string, unknown> } }[] }[] = [];
    client.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === 'TransactWriteItemsCommand') {
          const { body } = args.request as { body: string | Uint8Array };
          writes.push(JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body)));
        }
        return next(args);
      },
      { step: 'finalizeRequest' },
    );

    await expect(metadata.recordTurn('owner', 'conversation', { filingUserId: 'filing-user', title: 'Original', provider }))
      .resolves.toBe('filing-user');

    expect(writes).toHaveLength(1);
    const values = writes[0]?.TransactItems[1]?.Update?.ExpressionAttributeValues;
    expect(values).toHaveProperty(':provider', { S: provider });
    if (needsPending) expect(values).toHaveProperty(':pending', { BOOL: true });
    else expect(values).not.toHaveProperty(':pending');
    expect(await metadata.get('owner', 'conversation')).toEqual(expect.objectContaining({ provider }));
  });
});
