import { ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand, QueryCommand, TransactWriteItemsCommand, TransactionCanceledException, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { ACTIVITY, DISPATCH, PARTITION } from './parking.mjs';

const env = (/** @type {string} */ name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

/** @typedef {import('./parking.mjs').Claim} Claim */

async function invokeTransition(/** @type {LambdaClient} */ lambda, /** @type {object} */ event) {
  const response = await lambda.send(new InvokeCommand({ FunctionName: env('TRANSITION_FUNCTION'), InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify(event)) }));
  const payload = Buffer.from(response.Payload ?? []).toString();
  if (response.FunctionError) throw new Error(`Production transition refused: ${payload}`);
  return JSON.parse(payload);
}

const claimKey = (/** @type {Claim['kind']} */ kind, /** @type {string} */ day) => ({ pk: { S: PARTITION }, sk: { S: `${kind.toUpperCase()}#${day}` } });

function claimUpdate(/** @type {string} */ TableName, /** @type {Claim} */ { kind, day, at }, /** @type {number} */ debounceMs) {
  return {
    TableName, Key: claimKey(kind, day),
    UpdateExpression: 'SET lastAt = :at ADD claims :one',
    ConditionExpression: '(attribute_not_exists(lastAt) OR lastAt < :edge)',
    ExpressionAttributeValues: { ':one': { N: '1' }, ':at': { N: String(at) }, ':edge': { N: String(at - debounceMs) } },
  };
}

export function wakePorts({ dynamodb = new DynamoDBClient({}), lambda = new LambdaClient({}) } = {}) {
  const TableName = env('BOTCUBE_CHAT_TABLE');
  const lastClaim = async (/** @type {string} */ day) => {
    const { Item } = await dynamodb.send(new GetItemCommand({ TableName, Key: claimKey('wake', day), ConsistentRead: true }));
    return Item?.lastAt?.N === undefined ? null : Number(Item.lastAt.N);
  };
  return {
    now: Date.now,
    transition: () => invokeTransition(lambda, { op: 'wake-state' }),
    async claimWake(/** @type {string} */ day, /** @type {number} */ at, /** @type {number} */ cap, /** @type {number} */ debounceMs) {
      const update = claimUpdate(TableName, { kind: 'wake', day, at }, debounceMs);
      try {
        await dynamodb.send(new TransactWriteItemsCommand({ TransactItems: [
          { Update: {
            ...update,
            ConditionExpression: `${update.ConditionExpression} AND (attribute_not_exists(claims) OR claims < :cap)`,
            ExpressionAttributeValues: { ...update.ExpressionAttributeValues, ':cap': { N: String(cap) } },
          } },
          { Put: {
            TableName, ConditionExpression: 'attribute_not_exists(sk)',
            Item: { pk: { S: PARTITION }, sk: { S: `${DISPATCH}${at}` },
              action: { S: 'unpark' }, kind: { S: 'wake' }, day: { S: day }, at: { N: String(at) } },
          } },
        ] }));
        return 'claimed';
      } catch (error) {
        if (!(error instanceof TransactionCanceledException)) throw error;
        const [claim, dispatch] = error.CancellationReasons?.map(reason => reason.Code) ?? [];
        if (claim === 'TransactionConflict' || dispatch === 'TransactionConflict') return 'debounced';
        if (claim !== 'ConditionalCheckFailed' || (dispatch !== 'None' && dispatch !== 'ConditionalCheckFailed')) throw error;
        const last = await lastClaim(day);
        return last !== null && last >= at - debounceMs ? 'debounced' : 'capped';
      }
    },
    lastClaim,
  };
}

export function dispatcherPorts({ dynamodb = new DynamoDBClient({}), s3 = new S3Client({}), lambda = new LambdaClient({}) } = {}) {
  const TableName = env('BOTCUBE_CHAT_TABLE');
  return {
    now: Date.now,
    async claimPark(/** @type {string} */ day, /** @type {number} */ at, /** @type {number} */ debounceMs) {
      try {
        await dynamodb.send(new UpdateItemCommand(claimUpdate(TableName, { kind: 'park', day, at }, debounceMs)));
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },
    async release(/** @type {Claim} */ { kind, day, at }) {
      await dynamodb.send(new UpdateItemCommand({
        TableName, Key: claimKey(kind, day),
        UpdateExpression: 'SET claims = claims - :one REMOVE lastAt', ConditionExpression: 'lastAt = :at',
        ExpressionAttributeValues: { ':one': { N: '1' }, ':at': { N: String(at) } },
      }));
    },
    state: async () => (await invokeTransition(lambda, { op: 'state' })).state,
    async mode(/** @type {string | undefined} */ mode) {
      if (!['parked', 'egress', 'credential', 'live'].includes(mode ?? '')) throw new Error('Invalid production mode');
      return invokeTransition(lambda, { mode, op: 'start' });
    },
    async originClaimed() {
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: env('SLOT_BUCKET'), Key: env('ORIGIN_SLOT_KEY') }));
        return ((await object.Body?.transformToString()) ?? '').trim() !== '';
      } catch (error) {
        if (error instanceof NoSuchKey) return false;
        throw error;
      }
    },
    async heartbeats() {
      const { Items = [] } = await dynamodb.send(new QueryCommand({
        TableName, ConsistentRead: true,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :activity)',
        ExpressionAttributeValues: { ':pk': { S: PARTITION }, ':activity': { S: ACTIVITY } },
      }));
      return Items.map((item) => ({
        instance: String(item.sk?.S).slice(ACTIVITY.length),
        at: Number(item.at?.N), lastUserRequestAt: Number(item.lastUserRequestAt?.N), runningTurns: Number(item.runningTurns?.N),
        runningTurnIds: (item.runningTurnIds?.L ?? []).map((id) => String(id.S)),
        // A Chat Service from before account erases counted reports none.
        accountErases: Number(item.accountErases?.N ?? 0),
      }));
    },
    async forget(/** @type {string[]} */ instances) {
      await Promise.all(instances.map((instance) => dynamodb.send(new DeleteItemCommand({ TableName, Key: { pk: { S: PARTITION }, sk: { S: `${ACTIVITY}${instance}` } } }))));
    },
    async forgetRequest(/** @type {number} */ at) {
      await dynamodb.send(new DeleteItemCommand({ TableName, Key: { pk: { S: PARTITION }, sk: { S: `${DISPATCH}${at}` } } }));
    },
    async dispatch(/** @type {'park' | 'unpark'} */ action) {
      return invokeTransition(lambda, { action, op: 'start' });
    },
  };
}
