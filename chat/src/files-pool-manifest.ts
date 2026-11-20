import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { AccessPoints } from './files-efs.js';
import type { FilesRecords } from './files-shared.js';
import { filesPoolSlots, pooledAccessPoints } from './files-pool.js';

export const filesPoolManifest = z.object({ bucket: z.string().min(1), key: z.string().min(1) });

export function manifestAccessPoints(read: () => Promise<unknown>, records: () => FilesRecords, options: { pool?: string } = {}): AccessPoints {
  let loaded: ReturnType<typeof pooledAccessPoints> | undefined;
  let reading: Promise<ReturnType<typeof pooledAccessPoints>> | undefined;
  const load = (fresh = false) => {
    if (reading) return reading;
    if (loaded && !fresh) return Promise.resolve(loaded);
    reading = read().then(value => loaded = pooledAccessPoints(filesPoolSlots.parse(value), records, options)).finally(() => { reading = undefined; });
    return reading;
  };
  return {
    retainUntilCleanup: true,
    async directory(arn) {
      const pool = await load();
      try { return pool.directory(arn); }
      catch { return (await load(true)).directory(arn); }
    },
    async create(directory, token, userId) { return (await load(true)).create(directory, token, userId); },
    async delete(arn, userId) { return (await load(true)).delete(arn, userId); },
  };
}

export function s3PoolAccessPoints(location: z.infer<typeof filesPoolManifest>, records: () => FilesRecords): AccessPoints {
  const s3 = new S3Client({});
  return manifestAccessPoints(async () => {
    const response = await s3.send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key }));
    if (!response.Body) throw new Error('Files pool manifest body is missing');
    return JSON.parse(await response.Body.transformToString());
  }, records, { pool: `the deploy-time pool's manifest s3://${location.bucket}/${location.key}` });
}
