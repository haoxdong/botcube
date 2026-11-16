import { createHash } from 'node:crypto';

const BATCH_SIZE = 50;
const CONCURRENCY = 5;

async function bounded(items, operation) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += CONCURRENCY) {
    // eslint-disable-next-line no-await-in-loop -- bound EFS control-plane concurrency
    const batch = await Promise.allSettled(items.slice(offset, offset + CONCURRENCY).map(operation));
    const failure = batch.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    results.push(...batch.map(result => result.value));
  }
  return results;
}

async function removePool(state, points, manifests, bucket, key) {
  const pending = await points.states(state.fileSystemId, state.pending);
  if (pending.some(status => status !== 'missing')) return { IsComplete: false };
  const batch = state.slots.slice(0, BATCH_SIZE);
  const statuses = await points.states(state.fileSystemId, batch.map(slot => slot.arn));
  if (statuses.includes('creating')) return { IsComplete: false };
  if (batch.length > 0) {
    await bounded(batch.filter((_slot, index) => statuses[index] !== 'missing' && statuses[index] !== 'deleting'), slot => points.remove(slot.arn));
    state.slots = state.slots.slice(batch.length);
    state.pending = batch.map(slot => slot.arn);
    await manifests.write(bucket, `${key}.work`, state);
    return { IsComplete: false };
  }
  await manifests.clear(bucket);
  return { IsComplete: true };
}

export function poolHandlers({ points, manifests }) {
  return {
    async onEvent(event) {
      const { FileSystemId: fileSystemId, Bucket: bucket, ManifestKey: key, Count: count } = event.ResourceProperties;
      const poolId = event.PhysicalResourceId ?? `files-pool-${createHash('sha256').update(`${event.StackId}:${event.LogicalResourceId}`).digest('hex').slice(0, 32)}`;
      if (event.RequestType !== 'Delete' && (!Number.isSafeInteger(Number(count)) || Number(count) < 1 || Number(count) > 9999)) throw new Error('Files pool size must be from 1 to 9999, leaving one access point for the shared mount');
      if (event.RequestType === 'Update' && event.OldResourceProperties.FileSystemId !== fileSystemId) throw new Error('Changing the Files filesystem requires User migration');
      const previousKey = event.RequestType === 'Update' ? event.OldResourceProperties.ManifestKey : key;
      const target = await manifests.read(bucket, key);
      const published = target ?? await manifests.read(bucket, previousKey);
      if (event.RequestType !== 'Delete' && published && published.length > Number(count)) throw new Error('Shrinking the Files pool requires User migration');
      const progress = await manifests.read(bucket, `${key}.work`);
      const resumable = progress?.poolId === poolId && progress.fileSystemId === fileSystemId && !progress.deleting ? progress : null;
      const slots = event.RequestType === 'Delete'
        ? await points.owned(fileSystemId, poolId)
        : resumable?.slots ?? (published ?? []).map((slot, index) => ({ ...slot, index: slot.index ?? index }));
      await manifests.write(bucket, `${key}.work`, {
        requestId: event.RequestId, poolId, fileSystemId, count: Number(count), slots, pending: event.RequestType === 'Delete' ? [] : resumable?.pending ?? [], deleting: event.RequestType === 'Delete',
      });
      return { PhysicalResourceId: poolId };
    },
    async isComplete(event) {
      try { return await advance(event); }
      catch (error) {
        if (error?.name !== 'ThrottlingException') throw error;
        console.info(JSON.stringify({ event: 'files_pool_throttled' }));
        return { IsComplete: false };
      }
    },
  };

  async function advance(event) {
    const { Bucket: bucket, ManifestKey: key } = event.ResourceProperties;
    const state = await manifests.read(bucket, `${key}.work`);
    if (!state) {
      if (event.RequestType === 'Delete') return { IsComplete: true };
      const published = await manifests.read(bucket, key);
      if (published?.length === Number(event.ResourceProperties.Count)) return { IsComplete: true, Data: { Count: published.length } };
      throw new Error('Files pool deployment progress is missing');
    }
    if (state.requestId !== event.RequestId) throw new Error('Files pool deployment was superseded');
    if (state.deleting) return removePool(state, points, manifests, bucket, key);
    const statuses = await points.states(state.fileSystemId, state.pending);
    if (statuses.some(status => status !== 'available' && status !== 'creating')) throw new Error('A deploy-time Files access point failed to become available');
    if (statuses.includes('creating')) return { IsComplete: false };
    state.pending = [];
    if (state.slots.length === state.count) {
      await manifests.write(bucket, key, [...state.slots].sort((a, b) => a.index - b.index));
      await manifests.remove(bucket, `${key}.work`);
      return { IsComplete: true, Data: { Count: state.count } };
    }
    if (state.slots.length >= Math.min(50, state.count)) await manifests.write(bucket, key, [...state.slots].sort((a, b) => a.index - b.index));
    const occupied = new Set(state.slots.map(slot => slot.index));
    const indices = Array.from({ length: state.count }, (_, index) => index).filter(index => !occupied.has(index)).slice(0, BATCH_SIZE);
    const created = [];
    try {
      await bounded(indices, async index => {
        const token = `${state.poolId}-${index}`;
        const directory = `/accounts/${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
        created.push({ index, arn: await points.create(state.fileSystemId, directory, token), directory });
      });
    } finally {
      state.slots.push(...created);
      state.pending = created.map(slot => slot.arn);
      await manifests.write(bucket, `${key}.work`, state);
    }
    return { IsComplete: false };
  }
}
