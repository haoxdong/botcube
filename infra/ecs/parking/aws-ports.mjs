import { ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { installationToken } from './github-app.mjs';
import { ACTIVITY, DISPATCH, PARTITION } from './parking.mjs';

const env = (/** @type {string} */ name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

/** @typedef {import('./parking.mjs').Claim} Claim */

export function wakePorts({ dynamodb = new DynamoDBClient({}), fetch = globalThis.fetch } = {}) {
  const TableName = env('CHAT_TABLE');
  const claimKey = (/** @type {string} */ kind, /** @type {string} */ day) => ({ pk: { S: PARTITION }, sk: { S: `${kind.toUpperCase()}#${day}` } });
  const lastClaim = async (/** @type {string} */ kind, /** @type {string} */ day) => {
    const { Item } = await dynamodb.send(new GetItemCommand({ TableName, Key: claimKey(kind, day), ConsistentRead: true }));
    return Item?.lastAt?.N === undefined ? null : Number(Item.lastAt.N);
  };
  return {
    now: () => Date.now(),
    async paused() {
      const answer = await fetch(env('HEALTH_URL'), { headers: { 'User-Agent': 'collective-automation parking' } });
      return answer.status === 503 && (await answer.text()) === '{"status":"parked"}';
    },
    async claim(/** @type {Claim} */ { kind, day, at }, /** @type {number} */ cap, /** @type {number} */ debounceMs) {
      const capped = Number.isFinite(cap);
      try {
        await dynamodb.send(new UpdateItemCommand({
          TableName, Key: claimKey(kind, day),
          UpdateExpression: 'SET claims = if_not_exists(claims, :zero) + :one, lastAt = :at',
          ConditionExpression: `(attribute_not_exists(lastAt) OR lastAt < :edge)${capped ? ' AND (attribute_not_exists(claims) OR claims < :cap)' : ''}`,
          ExpressionAttributeValues: {
            ':zero': { N: '0' }, ':one': { N: '1' }, ':at': { N: String(at) }, ':edge': { N: String(at - debounceMs) },
            ...(capped ? { ':cap': { N: String(cap) } } : {}),
          },
        }));
        return 'claimed';
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        const last = await lastClaim(kind, day);
        return last !== null && last >= at - debounceMs ? 'debounced' : 'capped';
      }
    },
    async release(/** @type {Claim} */ { kind, day, at }) {
      await dynamodb.send(new UpdateItemCommand({
        TableName, Key: claimKey(kind, day),
        UpdateExpression: 'SET claims = claims - :one REMOVE lastAt', ConditionExpression: 'lastAt = :at',
        ExpressionAttributeValues: { ':one': { N: '1' }, ':at': { N: String(at) } },
      }));
    },
    lastClaim,
    async requestDispatch(/** @type {'park' | 'unpark'} */ action, /** @type {Claim} */ { kind, day, at }) {
      await dynamodb.send(new PutItemCommand({ TableName, Item: {
        pk: { S: PARTITION }, sk: { S: `${DISPATCH}${at}` }, action: { S: action }, kind: { S: kind }, day: { S: day }, at: { N: String(at) },
      } }));
    },
  };
}

export function dispatcherPorts({ dynamodb = new DynamoDBClient({}), ssm = new SSMClient({}), s3 = new S3Client({}), secrets = new SecretsManagerClient({}), fetch = globalThis.fetch } = {}) {
  const TableName = env('CHAT_TABLE');
  return {
    ...wakePorts({ dynamodb, fetch }),
    async state() {
      const { Parameter } = await ssm.send(new GetParameterCommand({ Name: env('PARK_STATE_PARAMETER') }));
      if (Parameter?.Value !== 'live' && Parameter?.Value !== 'parked') throw new Error(`Park state is ${JSON.stringify(Parameter?.Value)}, not live or parked`);
      return Parameter.Value;
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
      }));
    },
    async forget(/** @type {string[]} */ instances) {
      await Promise.all(instances.map((instance) => dynamodb.send(new DeleteItemCommand({ TableName, Key: { pk: { S: PARTITION }, sk: { S: `${ACTIVITY}${instance}` } } }))));
    },
    async forgetRequest(/** @type {number} */ at) {
      await dynamodb.send(new DeleteItemCommand({ TableName, Key: { pk: { S: PARTITION }, sk: { S: `${DISPATCH}${at}` } } }));
    },
    async dispatch(/** @type {'park' | 'unpark'} */ action) {
      const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: env('GITHUB_APP_SECRET') }));
      // repository_dispatch needs contents:write; the App has no Actions permission for workflow_dispatch.
      const token = await installationToken(JSON.parse(SecretString ?? ''), env('REPOSITORY'), { contents: 'write' }, fetch);
      const response = await fetch(`https://api.github.com/repos/${env('REPOSITORY')}/dispatches`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ event_type: 'park-production', client_payload: { action } }),
      });
      if (response.status !== 204) throw new Error(`GitHub refused the ${action} dispatch with HTTP ${response.status}: ${await response.text()}`);
    },
  };
}
