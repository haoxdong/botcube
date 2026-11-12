import { randomUUID } from 'node:crypto';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const scheduledSessionKey = (sessionId: string) => ({ pk: `SCHEDULED_SESSION#${sessionId}`, sk: 'META' });

export const SCHEDULED_EXECUTION_KEY = { pk: 'PAID_EXECUTION#scheduled-tasks', sk: 'META' };

export class ScheduledExecution {
  private readonly holder = randomUUID();

  constructor(private readonly tableName: string, private readonly documents: DynamoDBDocumentClient) {}

  async acquire(owner: string, sessionId: string): Promise<void> {
    try {
      await this.documents.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { ...SCHEDULED_EXECUTION_KEY, holder: this.holder, owner, sessionId, phase: 'running' }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: this.tableName, Item: scheduledSessionKey(sessionId) } },
      ] }));
    } catch (error) {
      if (error instanceof TransactionCanceledException && error.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') throw new Error('The scheduled execution slot is occupied; prior teardown must be confirmed');
      throw error;
    }
  }

  async stopping(): Promise<void> {
    await this.documents.send(new UpdateCommand({ TableName: this.tableName, Key: SCHEDULED_EXECUTION_KEY,
      UpdateExpression: 'SET #phase = :stopping', ConditionExpression: 'holder = :holder',
      ExpressionAttributeNames: { '#phase': 'phase' }, ExpressionAttributeValues: { ':holder': this.holder, ':stopping': 'stopping' } }));
  }

  async finish(stops: readonly (() => Promise<unknown> | undefined)[], release: boolean, primary?: unknown): Promise<void> {
    await this.stopping();
    const results = await Promise.allSettled(stops.map((stop) => Promise.resolve().then(stop)));
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(primary === undefined ? failures : [primary, ...failures], 'Scheduled execution teardown is unproved; admission retained');
    if (release) await this.release();
  }

  async release(): Promise<void> {
    await this.documents.send(new DeleteCommand({ TableName: this.tableName, Key: SCHEDULED_EXECUTION_KEY,
      ConditionExpression: 'holder = :holder AND #phase = :stopping', ExpressionAttributeNames: { '#phase': 'phase' },
      ExpressionAttributeValues: { ':holder': this.holder, ':stopping': 'stopping' } }));
  }
}
