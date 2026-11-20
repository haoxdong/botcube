import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { FilesRecords } from './files-shared.js';
import type { AccessPoints } from './files-efs.js';
import { HttpError } from './http-error.js';

export const filesPoolSlots = z.array(z.object({
  arn: z.string().regex(/^arn:[a-z-]+:elasticfilesystem:[a-z0-9-]+:[0-9]{12}:access-point\/fsap-[a-z0-9]+$/),
  directory: z.string().regex(/^\/accounts\/[0-9a-f]{32}$/),
})).min(1);
export type FilesPoolSlot = z.infer<typeof filesPoolSlots>[number];

export function pooledAccessPoints(slots: readonly FilesPoolSlot[], records: () => FilesRecords, {
  startingSlot = randomInt, pool = 'the deploy-time pool',
}: { startingSlot?: (capacity: number) => number; pool?: string } = {}) {
  if (slots.length === 0 || new Set(slots.map(slot => slot.arn)).size !== slots.length || new Set(slots.map(slot => slot.directory)).size !== slots.length) {
    throw new Error('Files access point pool requires distinct access points and directories');
  }
  const directory = (arn: string) => {
    const slot = slots.find(slot => slot.arn === arn);
    if (!slot) throw new HttpError(503, 'Files access point is outside the configured pool. Restore its pool configuration or migrate the User before changing Files mode.');
    return slot.directory;
  };
  return {
    directory,
    retainUntilCleanup: true,
    async create(_directory, _token, userId) {
      if (!userId) throw new Error('Files pool requires a User');
      const first = startingSlot(slots.length);
      const used = await records().filesPoolUsage();
      console.info(JSON.stringify({ filesPoolUsed: used, filesPoolCapacity: slots.length }));
      const candidates = used < slots.length ? [...slots.slice(first), ...slots.slice(0, first)] : [];
      for (const slot of candidates) {
        // eslint-disable-next-line no-await-in-loop -- each conditional claim needs the previous result
        const saved = await records().filesAccessPoint(userId);
        if (saved !== null) {
          directory(saved);
          return saved;
        }
        // eslint-disable-next-line no-await-in-loop -- the next candidate is tried only after contention
        if (await records().claimFilesPoolSlot(userId, slot.arn, slot.directory)) {
          // eslint-disable-next-line no-await-in-loop -- report occupancy after the winning claim
          console.info(JSON.stringify({ filesPoolUsed: await records().filesPoolUsage(), filesPoolCapacity: slots.length }));
          return slot.arn;
        }
      }
      const saved = await records().filesAccessPoint(userId);
      if (saved !== null) {
        directory(saved);
        return saved;
      }
      throw new HttpError(503, `Files access point pool is full: every access point in ${pool} is leased. Ask the deployer to add access points to it.`);
    },
    async delete(arn, userId) {
      if (!userId) throw new Error('Files pool release requires a User');
      await records().releaseFilesPoolSlot(userId, arn, directory(arn));
      console.info(JSON.stringify({ filesPoolUsed: await records().filesPoolUsage(), filesPoolCapacity: slots.length }));
      return true;
    },
  } satisfies AccessPoints;
}
