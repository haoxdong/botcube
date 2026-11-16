import { createHash } from 'node:crypto';

export function backgroundPool({ handlers, manifests, send }) {
  return {
    async onEvent(event) {
      const poolId = event.PhysicalResourceId ?? `files-pool-${createHash('sha256').update(`${event.StackId}:${event.LogicalResourceId}`).digest('hex').slice(0, 32)}`;
      const request = { RequestType: event.RequestType, RequestId: event.RequestId, PhysicalResourceId: poolId, ResourceProperties: event.ResourceProperties, OldResourceProperties: event.OldResourceProperties };
      if (event.RequestType === 'Delete') await manifests.write(event.ResourceProperties.Bucket, `${event.ResourceProperties.ManifestKey}.delete`, { requestId: event.RequestId });
      await send({ start: true, event: request });
      return { PhysicalResourceId: poolId };
    },
    async isComplete(event) {
      const { Bucket: bucket, ManifestKey: key, Count: count } = event.ResourceProperties;
      if (event.RequestType === 'Delete') return { IsComplete: await manifests.read(bucket, `${key}.delete`) === null };
      const published = await manifests.read(bucket, key);
      const ready = (published?.length ?? 0) >= Math.min(50, Number(count));
      return ready ? { IsComplete: true, Data: { ReadyCount: published.length, TargetCount: Number(count) } } : { IsComplete: false };
    },
    async work(job) {
      if (job.start) await handlers.onEvent(job.event);
      const { Bucket: bucket, ManifestKey: key } = job.event.ResourceProperties;
      const state = await manifests.read(bucket, `${key}.work`);
      if (!state || state.requestId !== job.event.RequestId) return;
      const result = await handlers.isComplete(job.event);
      if (!result.IsComplete) await send({ start: false, event: job.event });
    },
  };
}
