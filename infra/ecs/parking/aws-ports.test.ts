import { DynamoDBClient, GetItemCommand, PutItemCommand, TransactWriteItemsCommand, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChatTable } from '../../../chat/test/fakes/stack.js';
import { motoAws, motoEndpoint } from '../../../chat/test/fakes/moto.js';

import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ProductionActivity } from '../../../chat/src/production-activity.js';
// @ts-expect-error -- the parking Lambdas are plain JavaScript the ProductionParking stack packages as-is.
import { dispatcherPorts, wakePorts } from './aws-ports.mjs';
// @ts-expect-error -- see above.
import { wakeService } from './parking.mjs';

const endpoint = motoEndpoint();
const aws = motoAws();
const table = `chat-${Math.random().toString(36).slice(2)}`;
const saved = { ...process.env };
const dynamodb = new DynamoDBClient(aws);

beforeAll(async () => {
  await createChatTable(endpoint, table);
  Object.assign(process.env, { BOTCUBE_CHAT_TABLE: table, TRANSITION_FUNCTION: 'transition' });
});
afterAll(() => { process.env = saved; });

const lambda = { async send() { return { Payload: Buffer.from('{"state":"parked"}') }; } };
const ports = (client = dynamodb) => ({
  ...dispatcherPorts({ lambda, dynamodb: client, s3: new S3Client({ ...aws, forcePathStyle: true }) }),
  ...wakePorts({ lambda, dynamodb: client }),
});

describe('the parking Lambda over DynamoDB', () => {
  it('claims at most the cap a day, and debounces a claim inside its window', async () => {
    const parking = ports();
    const day = `2026-11-${Math.random().toString(36).slice(2)}`;

    expect(await parking.claimWake(day, 1_000, 2, 100)).toBe('claimed');
    expect(await parking.claimWake(day, 1_000, 2, 100)).toBe('debounced');
    expect(await parking.claimWake(day, 1_050, 2, 100)).toBe('debounced');
    expect(await parking.lastClaim(day)).toBe(1_000);
    expect(await parking.claimWake(day, 1_101, 2, 100)).toBe('claimed');
    expect(await parking.claimWake(day, 1_300, 2, 100)).toBe('capped');
    expect(await parking.claimPark(day, 1_300, 100)).toBe(true);
  });

  it('gives a claim back so the next one goes ahead', async () => {
    const parking = ports();
    const day = `2026-11-${Math.random().toString(36).slice(2)}`;
    await parking.claimWake(day, 2_000, 1, 100);

    await parking.release({ kind: 'wake', day, at: 2_000 });

    expect(await parking.lastClaim(day)).toBeNull();
    expect(await parking.claimWake(day, 2_010, 1, 100)).toBe('claimed');
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
      { instance: 'a', at: 5, lastUserRequestAt: 4, runningTurns: 1, runningTurnIds: [], accountErases: 0 }, { instance: 'b', at: 5, lastUserRequestAt: 4, runningTurns: 1, runningTurnIds: [], accountErases: 0 },
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
        .toEqual({ instance: activity.instance, at: 7_000, lastUserRequestAt: 7_000, runningTurns: 1, runningTurnIds: ['chat/run-1'], accountErases: 0 });
    } finally {
      stop();
    }
  });

  it('records a dispatch request for the dispatcher and forgets it once dispatched', async () => {
    const parking = ports();
    expect(await parking.claimWake('2026-11-04', 4_242, 20, 100)).toBe('claimed');
    const key = { pk: { S: 'PRODUCTION_PARKING' }, sk: { S: 'DISPATCH#4242' } };

    expect((await dynamodb.send(new GetItemCommand({ TableName: table, Key: key }))).Item).toEqual({
      ...key, action: { S: 'unpark' }, kind: { S: 'wake' }, day: { S: '2026-11-04' }, at: { N: '4242' },
    });
    await parking.forgetRequest(4_242);
    expect((await dynamodb.send(new GetItemCommand({ TableName: table, Key: key }))).Item).toBeUndefined();
  });

  it('keeps production parked if a Wake dispatch cannot be recorded, allowing the next press', async () => {
    const parking = ports();
    const at = Date.parse('2026-11-05T12:00:00Z');
    const existing = { pk: { S: 'PRODUCTION_PARKING' }, sk: { S: `DISPATCH#${at}` } };
    await dynamodb.send(new PutItemCommand({ TableName: table, Item: existing }));
    const wake = wakeService({ ...parking, now: () => at });

    await expect(wake.wake()).rejects.toThrow();
    expect(await wake.status()).toEqual({ state: 'parked' });
    expect(await parking.lastClaim('2026-11-05')).toBeNull();
    expect((await dynamodb.send(new GetItemCommand({ TableName: table, Key: existing }))).Item).toEqual(existing);

    await parking.forgetRequest(at);
    expect(await wake.wake()).toEqual({ state: 'waking', since: '2026-11-05T12:00:00.000Z' });
    expect((await dynamodb.send(new GetItemCommand({ TableName: table, Key: existing }))).Item?.action).toEqual({ S: 'unpark' });
  });

  it('debounces a second Wake whose transaction conflicts with the first', async () => {
    const now = () => Date.parse('2026-11-06T12:00:00Z');
    const first = wakeService({ ...ports(), now });
    const competing = new DynamoDBClient(aws);
    competing.middlewareStack.add((next, context) => async (args) => {
      if (context.commandName === TransactWriteItemsCommand.name) {
        await first.wake();
        throw new TransactionCanceledException({
          $metadata: {}, message: 'Transaction cancelled',
          CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
        });
      }
      return next(args);
    }, { step: 'initialize' });

    const second = wakeService({ ...ports(competing), now });
    await expect(second.wake()).resolves.toEqual({ state: 'waking', since: '2026-11-06T12:00:00.000Z' });
  });
});
