import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { describe, expect, it } from 'vitest';
import { ssmParkHistory } from './park-history.js';
import { motoAws } from '../test/fakes/moto.js';

const ssm = new SSMClient(motoAws());

const later = () => new Promise((resolve) => setTimeout(resolve, 20));

async function store(name: string, value: string): Promise<Date> {
  await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: 'String', Overwrite: true }));
  await later();
  const after = new Date();
  await later();
  return after;
}

describe('the park history', () => {
  it('answers the park state each moment was in, so a backlog drained after unpark is known to be due while Parked', async () => {
    const name = `/park-state-${Math.random().toString(36).slice(2)}`;
    const live = await store(name, 'live');
    const parked = await store(name, 'parked');
    const unparked = await store(name, 'live');
    const history = ssmParkHistory(name, 'BotCube', ssm);

    expect(await Promise.all([live, parked, unparked].map((at) => history.parkedAt(at)))).toEqual([false, true, false]);
  });

  it('pages through more versions than one page holds', async () => {
    const name = `/park-state-${Math.random().toString(36).slice(2)}`;
    for (let n = 0; n < 51; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- versions are written in order
      await ssm.send(new PutParameterCommand({ Name: name, Value: n % 2 === 0 ? 'live' : 'parked', Type: 'String', Overwrite: true }));
    }
    const lastParked = await store(name, 'parked');

    expect(await ssmParkHistory(name, 'BotCube', ssm).parkedAt(lastParked)).toBe(true);
  });

  it('fails loud on a moment its history no longer holds, or a state that is neither live nor parked', async () => {
    const before = new Date();
    await later();
    const name = `/park-state-${Math.random().toString(36).slice(2)}`;
    const odd = await store(name, 'asleep');
    const history = ssmParkHistory(name, 'BotCube', ssm);

    await expect(history.parkedAt(before)).rejects.toThrow(`${name} keeps no park state from ${before.toISOString()}`);
    await expect(history.parkedAt(odd)).rejects.toThrow(`${name} held "asleep", not live or parked`);
  });
});
