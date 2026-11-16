import { setTimeout as delay } from 'node:timers/promises';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const key = (pk: string, sk = 'META') => ({ pk, sk });

export async function claimFilesPoolSlot(store: { tableName: string; call(operation: string, command: { input: object }): Promise<unknown> }, userId: string, accessPointArn: string, directory: string): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop -- DynamoDB transaction conflicts require a bounded retry
        await store.call('TransactWriteItems', new TransactWriteCommand({
          TransactItems: [
            { ConditionCheck: { TableName: store.tableName, Key: key('FILES_CLEANUP', userId), ConditionExpression: 'attribute_not_exists(pk)' } },
            { Put: { TableName: store.tableName, Item: { ...key(`FILES_EFS#${userId}`), accessPointArn }, ConditionExpression: 'attribute_not_exists(pk)' } },
            { Put: { TableName: store.tableName, Item: { ...key('FILES_POOL', directory), userId, accessPointArn }, ConditionExpression: 'attribute_not_exists(pk)' } },
          ],
        }));
        return true;
      } catch (error) {
        if (!(error instanceof Error) || !(error.cause instanceof TransactionCanceledException)) throw error;
        const reasons = error.cause.CancellationReasons;
        if (!reasons || reasons.some(reason => reason.Code === 'ConditionalCheckFailed')) return false;
        if (!reasons.some(reason => reason.Code === 'TransactionConflict') || attempt === 3) throw error;
        // eslint-disable-next-line no-await-in-loop -- back off only after a DynamoDB transaction conflict
        await delay(10 * 2 ** attempt);
      }
    }
    throw new Error('Files pool transaction attempts exhausted');
}
