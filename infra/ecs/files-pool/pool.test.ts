import { expect, it } from 'vitest';
import { backgroundPool } from './jobs.mjs';
import { poolHandlers } from './pool.mjs';

function setup(count = 1000) {
  const objects = new Map<string, unknown>();
  const live = new Map<string, { arn: string; status: string }>();
  let creating = false;
  let failWrite = false;
  let throttleAfter = -1;
  let throttleDelete = false;
  let deleteBudget = Infinity;
  let active = 0;
  const handlers = poolHandlers({
    points: {
      async create(_filesystem: string, _directory: string, token: string) {
        if (throttleAfter === 0) { throttleAfter = -1; throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }); }
        throttleAfter -= 1;
        active += 1;
        if (active > 5) throw new Error('control-plane concurrency exceeded');
        await Promise.resolve();
        active -= 1;
        const saved = live.get(token);
        if (saved) return saved.arn;
        const point = { arn: `arn:slot:${live.size}`, status: creating ? 'creating' : 'available' };
        live.set(token, point);
        return point.arn;
      },
      async states(_filesystem: string, arns: string[]) { return arns.map(arn => [...live.values()].find(point => point.arn === arn)?.status ?? 'missing'); },
      async owned(_filesystem: string, poolId: string) { return [...live].filter(([token]) => token.startsWith(`${poolId}-`)).map(([, point]) => ({ arn: point.arn })); },
      async remove(arn: string) {
        if (deleteBudget-- === 0) throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
        if (throttleDelete) { throttleDelete = false; throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }); }
        for (const [token, point] of live) if (point.arn === arn) live.delete(token); },
    },
    manifests: {
      async read(_bucket: string, key: string) { return structuredClone(objects.get(key) ?? null); },
      async write(_bucket: string, key: string, value: unknown) {
        if (failWrite) { failWrite = false; throw new Error('S3 write interrupted'); }
        objects.set(key, structuredClone(value));
      },
      async remove(_bucket: string, key: string) { objects.delete(key); },
      async clear() { objects.clear(); },
    },
  });
  const event = { RequestType: 'Create', RequestId: 'request', StackId: 'stack', LogicalResourceId: 'pool', ResourceProperties: { FileSystemId: 'fs-test', Bucket: 'manifest', ManifestKey: `slots-${count}.json`, Count: count } };
  return { handlers, event, objects, live, creating: () => { creating = true; }, interrupt: () => { failWrite = true; }, throttle: (after = 0) => { throttleAfter = after; }, throttleDelete: () => { throttleDelete = true; }, limitDeletes: (count: number) => { deleteBudget = count; } };
}

async function complete(handlers: ReturnType<typeof poolHandlers>, event: object) {
  for (let step = 0; step < 205; step += 1) {
    // eslint-disable-next-line no-await-in-loop -- each provider transition consumes the preceding persisted state
    const result = await handlers.isComplete(event);
    if (result.IsComplete) return result;
  }
  throw new Error('Provider did not converge');
}

it('provisions 1000 slots with bounded control-plane calls and a small response', async () => {
  const { handlers, event, objects, live } = setup();
  const response = await handlers.onEvent(event);
  const request = { ...event, ...response };
  const result = await complete(handlers, request);
  expect(live.size).toBe(1000);
  const slots = objects.get('slots-1000.json');
  expect(slots).toHaveLength(1000);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
  expect(await handlers.isComplete(request)).toEqual(result);
});

it('does not publish a partial manifest or advance while points are creating', async () => {
  const fixture = setup(60);
  fixture.creating();
  const response = await fixture.handlers.onEvent(fixture.event);
  const event = { ...fixture.event, ...response };
  await fixture.handlers.isComplete(event);
  expect(fixture.live.size).toBe(50);
  expect(fixture.objects.has('slots-60.json')).toBe(false);
  expect(await fixture.handlers.isComplete(event)).toEqual({ IsComplete: false });
  expect(fixture.live.size).toBe(50);
  fixture.live.forEach(point => { point.status = 'available'; });
  await fixture.handlers.isComplete(event);
  fixture.live.forEach(point => { point.status = 'available'; });
  await complete(fixture.handlers, event);
  expect(fixture.objects.get('slots-60.json')).toHaveLength(60);
});

it('appends slots and preserves the old manifest while refusing shrink', async () => {
  const fixture = setup(2);
  const response = await fixture.handlers.onEvent(fixture.event);
  await complete(fixture.handlers, { ...fixture.event, ...response });
  const old = structuredClone(fixture.objects.get('slots-2.json'));
  const update = { ...fixture.event, ...response, RequestType: 'Update', RequestId: 'update', OldResourceProperties: fixture.event.ResourceProperties,
    ResourceProperties: { ...fixture.event.ResourceProperties, Count: 3, ManifestKey: 'slots-3.json' } };
  await fixture.handlers.onEvent(update);
  await complete(fixture.handlers, update);
  expect(fixture.objects.get('slots-2.json')).toEqual(old);
  expect(fixture.objects.get('slots-3.json')).toHaveLength(3);
  const rollback = { ...update, RequestId: 'rollback', OldResourceProperties: update.ResourceProperties, ResourceProperties: fixture.event.ResourceProperties };
  await fixture.handlers.onEvent(rollback);
  await complete(fixture.handlers, rollback);
  expect(fixture.objects.get('slots-2.json')).toEqual(old);
  expect(fixture.live.size).toBe(3);
  expect(fixture.live.size).toBe(3);
  await expect(fixture.handlers.onEvent({ ...update, RequestId: 'shrink', OldResourceProperties: update.ResourceProperties, ResourceProperties: { ...update.ResourceProperties, Count: 1, ManifestKey: 'slots-1.json' } })).rejects.toThrow('Shrinking');
});

it('recovers idempotently after access points exist but progress was not saved', async () => {
  const fixture = setup(2);
  const response = await fixture.handlers.onEvent(fixture.event);
  const event = { ...fixture.event, ...response };
  fixture.interrupt();
  await expect(fixture.handlers.isComplete(event)).rejects.toThrow('S3 write interrupted');
  await complete(fixture.handlers, event);
  expect(fixture.live.size).toBe(2);
  expect(fixture.objects.get('slots-2.json')).toHaveLength(2);
});

it('deletes only the owned points and clears the manifest bucket', async () => {
  const fixture = setup(60);
  const response = await fixture.handlers.onEvent(fixture.event);
  await complete(fixture.handlers, { ...fixture.event, ...response });
  fixture.live.set('another-pool-0', { arn: 'arn:other', status: 'available' });
  const deletion = { ...fixture.event, ...response, RequestType: 'Delete', RequestId: 'delete' };
  await fixture.handlers.onEvent(deletion);
  fixture.throttleDelete();
  expect(await fixture.handlers.isComplete(deletion)).toEqual({ IsComplete: false });
  await complete(fixture.handlers, deletion);
  expect([...fixture.live.keys()]).toEqual(['another-pool-0']);
  expect(fixture.objects.size).toBe(0);
});

it('resumes after SDK retries exhaust EFS throttling without publishing partial slots', async () => {
  const fixture = setup(60);
  const response = await fixture.handlers.onEvent(fixture.event);
  const event = { ...fixture.event, ...response };
  await fixture.handlers.isComplete(event);
  fixture.throttle(3);
  expect(await fixture.handlers.isComplete(event)).toEqual({ IsComplete: false });
  expect(fixture.objects.get('slots-60.json')).toHaveLength(50);
  expect(fixture.live.size).toBe(54);
  await complete(fixture.handlers, event);
  expect(fixture.live.size).toBe(60);
  const deletion = { ...event, RequestType: 'Delete', RequestId: 'delete' };
  await fixture.handlers.onEvent(deletion);
  fixture.throttleDelete();
  expect(await fixture.handlers.isComplete(deletion)).toEqual({ IsComplete: false });
  await complete(fixture.handlers, deletion);
  expect(fixture.live.size).toBe(0);
});

it('finishes deletion under a per-invocation API budget after partial deletion', async () => {
  const fixture = setup(8);
  const response = await fixture.handlers.onEvent(fixture.event);
  await complete(fixture.handlers, { ...fixture.event, ...response });
  const deletion = { ...fixture.event, ...response, RequestType: 'Delete', RequestId: 'delete' };
  await fixture.handlers.onEvent(deletion);
  const results = [];
  for (let step = 0; step < 5; step += 1) {
    fixture.limitDeletes(3);
    // eslint-disable-next-line no-await-in-loop -- each throttled invocation gets a fresh service quota
    results.push(await fixture.handlers.isComplete(deletion));
  }
  expect(results.at(-1)).toEqual({ IsComplete: true });
  expect(fixture.live.size).toBe(0);
});

it('releases deployment at 50 ready slots and continues the FIFO job to 1000', async () => {
  const fixture = setup();
  const queue: { start: boolean; event: typeof fixture.event }[] = [];
  const manifests = { read: async (_bucket: string, key: string) => fixture.objects.get(key) ?? null, write: async (_bucket: string, key: string, value: unknown) => { fixture.objects.set(key, value); } };
  const jobs = backgroundPool({ handlers: fixture.handlers, manifests, send: async job => { queue.push(job); } });
  const response = await jobs.onEvent(fixture.event);
  const event = { ...fixture.event, ...response };
  expect(await jobs.isComplete(event)).toEqual({ IsComplete: false });
  await jobs.work(queue.shift());
  await jobs.work(queue.shift());
  expect((await jobs.isComplete(event)).IsComplete).toBe(true);
  expect(fixture.objects.get('slots-1000.json')).toHaveLength(50);
  expect(queue).not.toHaveLength(0);
  for (let step = 0; step < 50 && queue.length > 0; step += 1) {
    // eslint-disable-next-line no-await-in-loop -- FIFO worker serializes persisted progress
    await jobs.work(queue.shift());
  }
  expect(fixture.objects.get('slots-1000.json')).toHaveLength(1000);
  expect(queue).toHaveLength(0);
});

it('resumes persisted work when a deployment request is retried', async () => {
  const fixture = setup();
  const response = await fixture.handlers.onEvent(fixture.event);
  await fixture.handlers.isComplete({ ...fixture.event, ...response });
  const retried = { ...fixture.event, ...response, RequestId: 'retry' };
  await fixture.handlers.onEvent(retried);
  expect(fixture.live.size).toBe(50);
  await complete(fixture.handlers, retried);
  expect(fixture.live.size).toBe(1000);
});
