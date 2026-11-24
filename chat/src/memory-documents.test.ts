import { PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { expect, it } from 'vitest';
import { memoryDocuments } from '../test/memory-documents.js';

it('reports each transaction condition in request order and applies no writes on cancellation', async () => {
  const documents = memoryDocuments();
  const Key = { pk: 'account', sk: 'existing' };
  const Item = { pk: 'account', sk: 'new' };
  await documents.send(new PutCommand({ TableName: 'test', Item: { ...Key, version: 1 } }));

  await expect(documents.send(new TransactWriteCommand({ TransactItems: [
    { ConditionCheck: { TableName: 'test', Key, ConditionExpression: 'attribute_not_exists(pk)', ReturnValuesOnConditionCheckFailure: 'ALL_OLD' } },
    { Put: { TableName: 'test', Item, ConditionExpression: 'attribute_not_exists(pk)' } },
    { Delete: { TableName: 'test', Key: { pk: 'account', sk: 'missing' }, ConditionExpression: 'attribute_exists(pk)' } },
  ] }))).rejects.toMatchObject({
    name: 'TransactionCanceledException',
    CancellationReasons: [
      { Code: 'ConditionalCheckFailed', Item: { pk: { S: 'account' }, sk: { S: 'existing' }, version: { N: '1' } } },
      { Code: 'None' },
      { Code: 'ConditionalCheckFailed' },
    ],
  });
  expect([...documents.items.values()]).toEqual([{ ...Key, version: 1 }]);
});
