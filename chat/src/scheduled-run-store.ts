import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { HttpError } from './cartridge.js';

interface ScheduledPostIdentity {
  session_id: string;
  filing_user_id: string;
  runtime_binding?: string;
  runtime_generation?: string;
  legacy_settlement_unproved?: true;
}

export interface ScheduledDelivery {
  owner: string;
  taskId: string;
  deliveryId: string;
  filingUserId: string;
  mainChat: string;
  mainFilingUserId?: string;
  sideChat: string;
  runId: string;
  inputMessageId: string;
  postMessageId: string;
  startedAt: string;
  attempt: string;
  phase: 'reserved' | 'admitted' | 'posting' | 'posted' | 'completed';
  postSession?: ScheduledPostIdentity;
  postToken?: string;
  failed?: boolean;
}

const ownerFenceKey = (owner: string) => ({ pk: `SESSIONS#${owner}`, sk: 'DELETED' });
const key = (owner: string, deliveryId: string) => ({ pk: ownerFenceKey(owner).pk, sk: `SCHEDULED_DELIVERY#${deliveryId}` });

export class ScheduledRunStore {
  private readonly documents: DynamoDBDocumentClient;
  constructor(private readonly tableName: string, client: DynamoDBClient) {
    this.documents = DynamoDBDocumentClient.from(client);
  }

  async get(owner: string, deliveryId: string, taskId: string): Promise<ScheduledDelivery | null> {
    const { Item } = await this.documents.send(new GetCommand({ TableName: this.tableName, Key: key(owner, deliveryId), ConsistentRead: true }));
    if (Item === undefined) return null;
    if (Item.owner !== owner || Item.deliveryId !== deliveryId || Item.taskId !== taskId ||
        !['reserved', 'admitted', 'posting', 'posted', 'completed'].includes(String(Item.phase)) ||
        !['filingUserId', 'mainChat', 'sideChat', 'runId', 'inputMessageId', 'postMessageId', 'startedAt', 'attempt'].every((name) => typeof Item[name] === 'string')) {
      throw new HttpError(503, 'Scheduled delivery identity is invalid');
    }
    if (Item.mainFilingUserId !== undefined && (typeof Item.mainFilingUserId !== 'string' || Item.mainFilingUserId === '')) {
      throw new HttpError(503, 'Scheduled Main filing identity is invalid');
    }
    if (Item.phase !== 'reserved' && Item.phase !== 'admitted') {
      const session = Item.postSession as ScheduledPostIdentity | undefined;
      if (session === undefined || session.session_id !== Item.mainChat || typeof session.filing_user_id !== 'string' ||
          !/^runtime-[0-9a-f-]{36}$/.test(session.runtime_binding ?? '') ||
          !(session.runtime_generation === 'tracked-v1' && session.legacy_settlement_unproved === undefined ||
            session.runtime_generation === 'continuation-v1' && session.legacy_settlement_unproved === true) ||
          typeof Item.postToken !== 'string' || !/^[0-9a-f-]{36}$/.test(Item.postToken) || typeof Item.failed !== 'boolean') {
        throw new HttpError(503, 'Scheduled post receipt identity is invalid');
      }
    }
    return Item as ScheduledDelivery;
  }

  async claim(owner: string, taskId: string, deliveryId: string, filingUserId: string, mainChat: string): Promise<ScheduledDelivery> {
    const main = await this.mainIdentity(owner, mainChat);
    const record: ScheduledDelivery = {
      owner, taskId, deliveryId, filingUserId, mainChat, mainFilingUserId: main.filingUserId,
      sideChat: randomUUID(), runId: randomUUID(), inputMessageId: randomUUID(), postMessageId: randomUUID(),
      startedAt: new Date().toISOString(), attempt: randomUUID(), phase: 'reserved',
    };
    await this.documents.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.tableName, Key: ownerFenceKey(owner), ConditionExpression: 'attribute_not_exists(pk)' } },
      { ConditionCheck: { TableName: this.tableName, Key: { pk: ownerFenceKey(owner).pk, sk: 'CLAIM' }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ...main.checks,
      { Put: { TableName: this.tableName, Item: { ...key(owner, deliveryId), ...record }, ConditionExpression: 'attribute_not_exists(pk)' } },
    ] }));
    return record;
  }

  private async mainIdentity(owner: string, mainChat: string) {
    const sessionKey = { pk: ownerFenceKey(owner).pk, sk: `SESSION#${mainChat}` };
    const session = await this.documents.send(new GetCommand({ TableName: this.tableName, Key: sessionKey, ConsistentRead: true }));
    const supplierKey = session.Item === undefined ? { pk: ownerFenceKey(owner).pk, sk: 'MAIN' } : sessionKey;
    const supplier = session.Item === undefined
      ? await this.documents.send(new GetCommand({ TableName: this.tableName, Key: supplierKey, ConsistentRead: true })) : session;
    const filingUserId: unknown = supplier.Item?.filing_user_id;
    if (supplier.Item?.session_id !== mainChat || typeof filingUserId !== 'string' || filingUserId === '' || supplier.Item.deleted_at !== undefined) {
      throw new HttpError(503, 'Scheduled Main filing identity is unavailable');
    }
    const checks: NonNullable<TransactWriteCommandInput['TransactItems']> = [{ ConditionCheck: { TableName: this.tableName, Key: supplierKey,
      ConditionExpression: 'session_id = :session AND filing_user_id = :filing AND attribute_not_exists(deleted_at)',
      ExpressionAttributeValues: { ':session': mainChat, ':filing': filingUserId },
    } }];
    if (session.Item === undefined) checks.push({ ConditionCheck: { TableName: this.tableName, Key: sessionKey,
      ConditionExpression: 'attribute_not_exists(pk)',
    } });
    return { filingUserId, checks };
  }

  async executionOwner(record: ScheduledDelivery): Promise<string> {
    const { Item } = await this.documents.send(new GetCommand({
      TableName: this.tableName, Key: { pk: ownerFenceKey(record.owner).pk, sk: 'CLAIM' }, ConsistentRead: true,
    }));
    if (Item === undefined) return record.owner;
    if (typeof Item.destination !== 'string' || Item.destination === '' || Item.destination === record.owner) {
      throw new HttpError(503, 'Scheduled delivery Claim authority is unavailable; delivery remains pending');
    }
    return Item.destination;
  }

  async reclaim(record: ScheduledDelivery, executionOwner = record.owner): Promise<ScheduledDelivery> {
    const next = { ...record, attempt: randomUUID() };
    await this.reservationWrite(record, executionOwner, 'SET attempt = :next', { ':next': next.attempt });
    return next;
  }

  async admit(record: ScheduledDelivery, executionOwner = record.owner): Promise<void> {
    await this.reservationWrite(record, executionOwner, 'SET #phase = :admitted', { ':admitted': 'admitted' });
  }

  private async reservationWrite(record: ScheduledDelivery, executionOwner: string, expression: string, values: Record<string, string>): Promise<void> {
    await this.documents.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.tableName, Key: ownerFenceKey(record.owner), ConditionExpression: 'attribute_not_exists(pk)' } },
      { ConditionCheck: { TableName: this.tableName, Key: { pk: ownerFenceKey(record.owner).pk, sk: 'CLAIM' },
        ...(executionOwner === record.owner ? { ConditionExpression: 'attribute_not_exists(pk)' } : {
          ConditionExpression: 'destination = :destination', ExpressionAttributeValues: { ':destination': executionOwner },
        }),
      } },
      ...(executionOwner === record.owner ? [] : [
        { ConditionCheck: { TableName: this.tableName, Key: ownerFenceKey(executionOwner), ConditionExpression: 'attribute_not_exists(pk)' } },
        { ConditionCheck: { TableName: this.tableName, Key: { pk: ownerFenceKey(executionOwner).pk, sk: 'CLAIM' }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { ConditionCheck: { TableName: this.tableName, Key: { pk: ownerFenceKey(executionOwner).pk, sk: `SESSION#${record.mainChat}` },
          ConditionExpression: 'session_id = :session AND filing_user_id = :filing AND attribute_not_exists(deleted_at)',
          ExpressionAttributeValues: { ':session': record.mainChat, ':filing': record.mainFilingUserId },
        } },
      ]),
      { Update: { TableName: this.tableName, Key: key(record.owner, record.deliveryId), UpdateExpression: expression,
        ConditionExpression: '#phase = :reserved AND attempt = :attempt AND taskId = :task AND postMessageId = :message',
        ExpressionAttributeNames: { '#phase': 'phase' },
        ExpressionAttributeValues: { ':reserved': 'reserved', ':attempt': record.attempt, ':task': record.taskId, ':message': record.postMessageId, ...values },
      } },
    ] }));
  }

  async posting(record: ScheduledDelivery, complete: { session?: ScheduledPostIdentity; token?: string }, failed: boolean): Promise<ScheduledDelivery> {
    if (complete.session === undefined || complete.token === undefined || complete.session.session_id !== record.mainChat ||
        complete.session.runtime_binding === undefined || complete.session.runtime_generation === undefined) {
      throw new HttpError(503, 'Scheduled post registration identity is unavailable');
    }
    const postSession: ScheduledPostIdentity = {
      session_id: complete.session.session_id, filing_user_id: complete.session.filing_user_id,
      runtime_binding: complete.session.runtime_binding, runtime_generation: complete.session.runtime_generation,
      ...(complete.session.legacy_settlement_unproved === true ? { legacy_settlement_unproved: true } : {}),
    };
    const next: ScheduledDelivery = { ...record, phase: 'posting', postSession, postToken: complete.token, failed };
    await this.documents.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.tableName,
        Key: { pk: `DISPATCH#${JSON.stringify([complete.session.filing_user_id, complete.session.session_id])}`, sk: complete.token },
        ConditionExpression: 'session_id = :session AND filing_user_id = :filing AND runtime_binding = :binding AND runtime_generation = :generation',
        ExpressionAttributeValues: { ':session': complete.session.session_id, ':filing': complete.session.filing_user_id,
          ':binding': complete.session.runtime_binding, ':generation': complete.session.runtime_generation },
      } },
      { Update: { TableName: this.tableName, Key: key(record.owner, record.deliveryId),
      UpdateExpression: 'SET #phase = :posting, postSession = :session, postToken = :token, failed = :failed',
      ConditionExpression: '#phase = :admitted AND attempt = :attempt AND taskId = :task AND postMessageId = :message',
      ExpressionAttributeNames: { '#phase': 'phase' },
      ExpressionAttributeValues: { ':posting': 'posting', ':admitted': 'admitted', ':attempt': record.attempt, ':task': record.taskId, ':message': record.postMessageId, ':session': postSession, ':token': complete.token, ':failed': failed },
      } },
    ] }));
    return next;
  }

  postedTransaction(record: ScheduledDelivery) {
    return { Update: { TableName: this.tableName, Key: key(record.owner, record.deliveryId),
      UpdateExpression: 'SET #phase = :posted',
      ConditionExpression: '#phase = :posting AND taskId = :task AND postMessageId = :message AND postToken = :token AND postSession = :session',
      ExpressionAttributeNames: { '#phase': 'phase' },
      ExpressionAttributeValues: { ':posted': 'posted', ':posting': 'posting', ':task': record.taskId, ':message': record.postMessageId, ':token': record.postToken, ':session': record.postSession },
    } };
  }

  async complete(record: ScheduledDelivery): Promise<void> {
    await this.documents.send(new UpdateCommand({ TableName: this.tableName, Key: key(record.owner, record.deliveryId),
      UpdateExpression: 'SET #phase = :completed',
      ConditionExpression: '(#phase = :posted OR #phase = :completed) AND taskId = :task AND postToken = :token AND postSession = :session',
      ExpressionAttributeNames: { '#phase': 'phase' },
      ExpressionAttributeValues: { ':posted': 'posted', ':completed': 'completed', ':task': record.taskId, ':token': record.postToken, ':session': record.postSession },
    }));
  }

  async retryFailed(record: ScheduledDelivery): Promise<void> {
    await this.documents.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: this.tableName, Key: ownerFenceKey(record.owner), ConditionExpression: 'attribute_not_exists(pk)' } },
      { ConditionCheck: { TableName: this.tableName, Key: { pk: ownerFenceKey(record.owner).pk, sk: 'CLAIM' }, ConditionExpression: 'attribute_not_exists(pk)' } },
      { Delete: { TableName: this.tableName, Key: key(record.owner, record.deliveryId),
        ConditionExpression: '#phase = :completed AND failed = :failed AND taskId = :task AND postToken = :token AND postSession = :session',
        ExpressionAttributeNames: { '#phase': 'phase' },
        ExpressionAttributeValues: { ':completed': 'completed', ':failed': true, ':task': record.taskId, ':token': record.postToken, ':session': record.postSession },
      } },
    ] }));
  }
}
