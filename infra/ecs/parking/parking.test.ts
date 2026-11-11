import { describe, expect, it } from 'vitest';

// @ts-expect-error -- the parking Lambdas are plain JavaScript the ProductionParking stack packages as-is.
import { dispatch as dispatcher, handler as dispatcherHandler } from './dispatcher.mjs';
// @ts-expect-error -- see above.
import { dispatcherService, IDLE_MS, wakeService, WAKES_PER_DAY } from './parking.mjs';
// @ts-expect-error -- see above.
import { answer as wakeUrl, handler as wakeHandler } from './wake.mjs';

type Heartbeat = { instance: string; at: number; lastUserRequestAt: number; runningTurns: number; runningTurnIds: string[] };
type Claim = { kind: string; day: string; at: number };

function production({ state = 'live', paused = state === 'parked', heartbeats = [] as Heartbeat[], claimed = false, refuse = false } = {}) {
  const world = {
    now: Date.parse('2026-11-04T05:00:00Z'),
    state, paused, claimed, refuse, heartbeats,
    claims: new Map<string, { claims: number; lastAt?: number }>(),
    requests: [] as { action: string; claim: Claim }[],
    dispatched: [] as string[],
  };
  const wakePorts = {
    now: () => world.now,
    paused: async () => world.paused,
    claim: async ({ kind, day, at }: Claim, cap: number, debounceMs: number) => {
      const item = world.claims.get(`${kind}#${day}`) ?? { claims: 0 };
      if (item.lastAt !== undefined && item.lastAt >= at - debounceMs) return 'debounced';
      if (item.claims >= cap) return 'capped';
      world.claims.set(`${kind}#${day}`, { claims: item.claims + 1, lastAt: at });
      return 'claimed';
    },
    release: async ({ kind, day, at }: Claim) => {
      const item = world.claims.get(`${kind}#${day}`);
      if (item?.lastAt === at) world.claims.set(`${kind}#${day}`, { claims: item.claims - 1 });
    },
    lastClaim: async (kind: string, day: string) => world.claims.get(`${kind}#${day}`)?.lastAt ?? null,
    requestDispatch: async (action: string, claim: Claim) => { world.requests.push({ action, claim }); },
  };
  const dispatcherPorts = {
    ...wakePorts,
    state: async () => world.state,
    originClaimed: async () => world.claimed,
    heartbeats: async () => world.heartbeats,
    forget: async (instances: string[]) => { world.heartbeats = world.heartbeats.filter(({ instance }) => !instances.includes(instance)); },
    forgetRequest: async (at: number) => { world.requests = world.requests.filter(({ claim }) => claim.at !== at); },
    dispatch: async (action: string) => {
      if (world.refuse) throw new Error('CloudFormation refused the transition');
      world.dispatched.push(action);
    },
  };
  const stream = async () => dispatcher({ Records: world.requests.map(({ action, claim }) => ({
    eventName: 'INSERT',
    dynamodb: { NewImage: { pk: { S: 'PRODUCTION_PARKING' }, sk: { S: `DISPATCH#${claim.at}` }, action: { S: action }, kind: { S: claim.kind }, day: { S: claim.day }, at: { N: String(claim.at) } } },
  })) }, dispatcherPorts);
  return { world, wakePorts, dispatcherPorts, stream, wake: wakeService(wakePorts), dispatcher: dispatcherService(dispatcherPorts) };
}

const beat = (now: number, quietMs: number, runningTurns = 0, instance = 'task-1'): Heartbeat =>
  ({ instance, at: now - 30_000, lastUserRequestAt: now - quietMs, runningTurns, runningTurnIds: Array.from({ length: runningTurns }, (_, n) => `chat-${n}/run-${n}`) });

describe('the idle check', () => {
  it('parks Live production after 30 minutes with no user request and no Turn running', async () => {
    const { world, dispatcher: service } = production();
    world.heartbeats = [beat(world.now, IDLE_MS)];

    expect(await service.check()).toEqual({ action: 'park', reason: 'no user request for 30 min and no Turn running' });
    expect(world.dispatched).toEqual(['park']);
  });

  it.each([
    ['a user came 29 minutes ago', (now: number) => [beat(now, IDLE_MS - 60_000)], 'last user request 29 min ago'],
    ['a Turn is running', (now: number) => [beat(now, IDLE_MS, 1)], '1 Turn(s) running: chat-0/run-0 on task-1'],
    ['a draining task still streams a Turn', (now: number) => [beat(now, IDLE_MS), beat(now, IDLE_MS * 2, 1, 'draining')], '1 Turn(s) running: chat-0/run-0 on draining'],
    ['a Chat Service from before Turn ids counts one', (now: number) => [{ ...beat(now, IDLE_MS, 1), runningTurnIds: [] }], '1 Turn(s) running'],
    ['a user reached the newer task', (now: number) => [beat(now, IDLE_MS * 2), beat(now, 60_000, 0, 'new')], 'last user request 1 min ago'],
    ['no Chat Service reported in', () => [], 'no Chat Service heartbeat in the last 3 minutes'],
  ])('does not park while %s', async (_case, heartbeats, reason) => {
    const { world, dispatcher: service } = production();
    world.heartbeats = heartbeats(world.now);

    expect(await service.check()).toEqual({ action: 'none', reason });
    expect(world.dispatched).toEqual([]);
  });

  it('ignores a heartbeat older than 3 minutes and forgets one from an hour ago', async () => {
    const { world, dispatcher: service } = production();
    world.heartbeats = [{ instance: 'gone', at: world.now - IDLE_MS * 2 - 1, lastUserRequestAt: world.now, runningTurns: 3, runningTurnIds: [] }, { ...beat(world.now, IDLE_MS), at: world.now - 3 * 60_000 - 1 }];

    expect(await service.check()).toEqual({ action: 'none', reason: 'no Chat Service heartbeat in the last 3 minutes' });
    expect(world.heartbeats.map(({ instance }) => instance)).toEqual(['task-1']);
  });

  it('leaves Parked production and a claimed origin slot alone', async () => {
    const parked = production({ state: 'parked' });
    const claimed = production({ claimed: true });
    for (const { world } of [parked, claimed]) world.heartbeats = [beat(world.now, IDLE_MS)];

    expect(await parked.dispatcher.check()).toEqual({ action: 'none', reason: 'production is not Live' });
    expect(await claimed.dispatcher.check()).toEqual({ action: 'none', reason: 'a session holds the origin slot' });
    expect([...parked.world.dispatched, ...claimed.world.dispatched]).toEqual([]);
  });

  it('asks for one park while the first is still queued', async () => {
    const { world, dispatcher: service } = production();
    world.heartbeats = [beat(world.now, IDLE_MS)];
    await service.check();
    world.now += 5 * 60_000;
    world.heartbeats = [beat(world.now, IDLE_MS)];

    expect(await service.check()).toEqual({ action: 'none', reason: 'a park was asked for in the last 10 minutes' });
    world.now += 5 * 60_000 + 1;
    world.heartbeats = [beat(world.now, IDLE_MS)];
    expect((await service.check()).action).toBe('park');
    expect(world.dispatched).toEqual(['park', 'park']);
  });
});

describe('waking from the paused page', () => {
  it('asks the dispatcher for one unpark however many people press, and says it is waking', async () => {
    const { world, wake, stream } = production({ state: 'parked' });

    const presses = await Promise.all([wake.wake(), wake.wake()]);
    await stream();
    world.now += 60_000;

    expect(presses).toEqual([{ state: 'waking', since: '2026-11-04T05:00:00.000Z' }, { state: 'waking', since: '2026-11-04T05:00:00.000Z' }]);
    expect(await wake.status()).toEqual({ state: 'waking', since: '2026-11-04T05:00:00.000Z' });
    expect(world.dispatched).toEqual(['unpark']);
    expect(world.requests).toEqual([]);
  });

  it('wakes production that is not serving even when its stored state already says live, as a re-run of unpark recovers it', async () => {
    const { world, wake, stream } = production({ state: 'live', paused: true });

    expect((await wake.wake()).state).toBe('waking');
    await stream();
    expect(world.dispatched).toEqual(['unpark']);
  });

  it('wakes at most 20 times a UTC day, then says so', async () => {
    const { world, wake } = production({ state: 'parked' });
    for (let n = 0; n < WAKES_PER_DAY; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- each wake follows the last one's debounce
      await wake.wake();
      world.now += 15 * 60_000 + 1;
    }

    expect(await wake.wake()).toEqual({ state: 'limit', limit: 20 });
    expect(world.requests).toHaveLength(20);
    world.now = Date.parse('2026-11-05T00:00:00Z');
    expect((await wake.wake()).state).toBe('waking');
  });

  it('gives the claim back when AWS refuses, so the page shows parked and the next press tries again', async () => {
    const { world, wake, stream } = production({ state: 'parked', refuse: true });
    await wake.wake();

    await expect(stream()).rejects.toThrow('CloudFormation refused the transition');
    expect(await wake.status()).toEqual({ state: 'parked' });
    world.refuse = false;
    world.requests = [];
    expect((await wake.wake()).state).toBe('waking');
    await stream();
    expect(world.dispatched).toEqual(['unpark']);
  });

  it('does nothing while production serves, however the public URL is reached', async () => {
    const { world, wake } = production({ state: 'live' });

    expect(await wake.wake()).toEqual({ state: 'live' });
    expect(await wake.status()).toEqual({ state: 'live' });
    expect(world.requests).toEqual([]);
  });
});

describe('the Lambda entries', () => {
  it('answers the paused page over the wake Function URL', async () => {
    const { wakePorts } = production({ state: 'parked' });
    const url = (method: string) => ({ requestContext: { http: { method } } });

    expect(await wakeUrl(url('GET'), wakePorts)).toMatchObject({ statusCode: 200, body: '{"state":"parked"}' });
    expect(JSON.parse((await wakeUrl(url('POST'), wakePorts)).body)).toEqual({ state: 'waking', since: '2026-11-04T05:00:00.000Z' });
    expect(await wakeUrl(url('DELETE'), wakePorts)).toMatchObject({ statusCode: 405 });
  });

  it('dispatches only park or unpark, and answers the park workflow\'s idle recheck', async () => {
    const { world, dispatcherPorts } = production();
    world.heartbeats = [beat(world.now, IDLE_MS)];
    const forged = { eventName: 'INSERT', dynamodb: { NewImage: { pk: { S: 'PRODUCTION_PARKING' }, sk: { S: 'DISPATCH#1' }, action: { S: 'deploy' }, kind: { S: 'wake' }, day: { S: '2026-11-04' }, at: { N: '1' } } } };

    await expect(dispatcher({ Records: [forged] }, dispatcherPorts)).rejects.toThrow('Refusing to dispatch "deploy"');
    expect(world.dispatched).toEqual([]);
    expect(await dispatcher({ op: 'idle' }, dispatcherPorts)).toEqual({ idle: true, reason: 'no user request for 30 min and no Turn running' });
    await expect(dispatcher({ op: 'other' }, dispatcherPorts)).rejects.toThrow('Unknown parking event {"op":"other"}');
  });

  it('exports handlers that Node.js 24 Lambdas accept: at most event and context, never a callback', () => {
    expect([wakeHandler.length, dispatcherHandler.length]).toEqual([1, 1]);
  });
});
