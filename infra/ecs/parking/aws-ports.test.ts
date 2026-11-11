import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChatTable } from '../../../chat/test/fakes/stack.js';
import { motoAws, motoEndpoint } from '../../../chat/test/fakes/moto.js';

import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ProductionActivity } from '../../../chat/src/production-activity.js';
// @ts-expect-error -- the parking Lambdas are plain JavaScript the ProductionParking stack packages as-is.
import { dispatcherPorts } from './aws-ports.mjs';

const endpoint = motoEndpoint();
const aws = motoAws();
const table = `chat-${Math.random().toString(36).slice(2)}`;
const parameter = `/park-state-${Math.random().toString(36).slice(2)}`;
const saved = { ...process.env };
const dynamodb = new DynamoDBClient(aws);

beforeAll(async () => {
  await createChatTable(endpoint, table);
  Object.assign(process.env, { CHAT_TABLE: table, PARK_STATE_PARAMETER: parameter, TRANSITION_FUNCTION: 'transition' });
});
afterAll(() => { process.env = saved; });

const ports = () => dispatcherPorts({ lambda: { async send() { return { Payload: Buffer.from('{"state":"parked"}') }; } }, dynamodb, ssm: new SSMClient(aws), s3: new S3Client({ ...aws, forcePathStyle: true }) });

describe('the parking Lambda over DynamoDB and SSM', () => {
  it('claims at most the cap a day, and debounces a claim inside its window', async () => {
    const parking = ports();
    const day = `2026-11-${Math.random().toString(36).slice(2)}`;

    expect(await parking.claim({ kind: 'wake', day, at: 1_000 }, 2, 100)).toBe('claimed');
    expect(await parking.claim({ kind: 'wake', day, at: 1_050 }, 2, 100)).toBe('debounced');
    expect(await parking.lastClaim('wake', day)).toBe(1_000);
    expect(await parking.claim({ kind: 'wake', day, at: 1_101 }, 2, 100)).toBe('claimed');
    expect(await parking.claim({ kind: 'wake', day, at: 1_300 }, 2, 100)).toBe('capped');
    expect(await parking.claim({ kind: 'park', day, at: 1_300 }, Number.POSITIVE_INFINITY, 100)).toBe('claimed');
  });

  it('gives a claim back so the next one goes ahead', async () => {
    const parking = ports();
    const day = `2026-11-${Math.random().toString(36).slice(2)}`;
    await parking.claim({ kind: 'wake', day, at: 1_000 }, 1, 100);

    await parking.release({ kind: 'wake', day, at: 1_000 });

    expect(await parking.lastClaim('wake', day)).toBeNull();
    expect(await parking.claim({ kind: 'wake', day, at: 1_010 }, 1, 100)).toBe('claimed');
  });

  it('reads every Chat Service heartbeat and forgets the named ones', async () => {
    const parking = ports();
    for (const instance of ['a', 'b']) {
      // eslint-disable-next-line no-await-in-loop -- two rows
      await dynamodb.send(new PutItemCommand({ TableName: table, Item: {
        pk: { S: 'PRODUCTION_PARKING' }, sk: { S: `ACTIVITY#${instance}` }, at: { N: '5' }, lastUserRequestAt: { N: '4' }, runningTurns: { N: '1' },
      } }));
    }

    expect(await parking.heartbeats()).toEqual([
      { instance: 'a', at: 5, lastUserRequestAt: 4, runningTurns: 1, runningTurnIds: [] }, { instance: 'b', at: 5, lastUserRequestAt: 4, runningTurns: 1, runningTurnIds: [] },
    ]);
    await parking.forget(['a']);
    expect((await parking.heartbeats()).map(({ instance }: { instance: string }) => instance)).toEqual(['b']);
  });

  it('reads the heartbeat the Chat Service writes, keyed as the Lambda expects', async () => {
    const activity = new ProductionActivity(() => 7_000);
    activity.turnStarted('owner#chat', 'run-1');
    const stop = activity.report(table, DynamoDBDocumentClient.from(dynamodb));
    try {
      await expect.poll(async () => (await ports().heartbeats()).find(({ instance }: { instance: string }) => instance === activity.instance))
        .toEqual({ instance: activity.instance, at: 7_000, lastUserRequestAt: 7_000, runningTurns: 1, runningTurnIds: ['chat/run-1'] });
    } finally {
      stop();
    }
  });

  it('records a dispatch request for the dispatcher and forgets it once dispatched', async () => {
    const parking = ports();
    await parking.requestDispatch('unpark', { kind: 'wake', day: '2026-11-04', at: 4_242 });
    const key = { pk: { S: 'PRODUCTION_PARKING' }, sk: { S: 'DISPATCH#4242' } };

    expect((await dynamodb.send(new GetItemCommand({ TableName: table, Key: key }))).Item).toEqual({
      ...key, action: { S: 'unpark' }, kind: { S: 'wake' }, day: { S: '2026-11-04' }, at: { N: '4242' },
    });
    await parking.forgetRequest(4_242);
    expect((await dynamodb.send(new GetItemCommand({ TableName: table, Key: key }))).Item).toBeUndefined();
  });

  it('reads the stored park state, failing loud on anything but live or parked', async () => {
    const ssm = new SSMClient(aws);
    await ssm.send(new PutParameterCommand({ Name: parameter, Value: 'parked', Type: 'String', Overwrite: true }));
    expect(await ports().state()).toBe('parked');
    await ssm.send(new PutParameterCommand({ Name: parameter, Value: 'asleep', Type: 'String', Overwrite: true }));
    await expect(ports().state()).rejects.toThrow('Park state is "asleep", not live or parked');
  });
});
