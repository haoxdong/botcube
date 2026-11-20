import { lookup } from 'node:dns/promises';
import type { DeploymentConfig } from 'botcube-deployment-config';
import { ecsCleanupWorker } from './files-cleanup-worker.js';
import { filesPoolManifest, s3PoolAccessPoints } from './files-pool-manifest.js';
import { pooledAccessPoints } from './files-pool.js';
import { HttpError } from './http-error.js';
import { accountFilesEfs, efsAccessPoints, stsMountCredentials } from './files-efs.js';
import type { AccountFiles, FilesRecords } from './files-shared.js';

export type { AccountFiles, FileEntry, FilesMount, FilesRecords } from './files-shared.js';

const EFS_SETTINGS = ['BOTCUBE_FILES_EFS_ARN', 'BOTCUBE_FILES_SIGNING_KEY', 'BOTCUBE_FILES_MOUNT_ROLE_ARN', 'BOTCUBE_FILES_MOUNT_TARGET_IP'] as const;

/** The operator's file system and the access points Users lease from it (ADR 0091), as the Deployment Config supplies them. */
export type SuppliedFiles = NonNullable<NonNullable<DeploymentConfig['supplied']>['files']>;

function suppliedAccessPoints({ accessPoints }: SuppliedFiles, fileSystemArn: string, records: () => FilesRecords) {
  const [prefix, partition, service, region, account] = fileSystemArn.split(':');
  const slots = accessPoints.map(({ accessPointId, rootDirectory }) => ({
    arn: [prefix, partition, service, region, account, `access-point/${accessPointId}`].join(':'), directory: rootDirectory,
  }));
  return pooledAccessPoints(slots, records, { pool: 'supplied.files.accessPoints' });
}

/** The supplied file system's mount target in this subnet's Availability Zone, by the name Amazon-provided VPC DNS gives it. */
const mountTargetOf = ({ fileSystemId }: SuppliedFiles, fileSystemArn: string) => async () => {
  const [, , , region] = fileSystemArn.split(':');
  return (await lookup(`${fileSystemId}.efs.${region}.amazonaws.com`, { family: 4 })).address;
};

function efsFilesFromEnv(env: NodeJS.ProcessEnv, records: () => FilesRecords, root: string, supplied?: SuppliedFiles): AccountFiles {
  const required = supplied ? EFS_SETTINGS.filter((name) => name !== 'BOTCUBE_FILES_MOUNT_TARGET_IP') : EFS_SETTINGS;
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new HttpError(503, `Files on EFS are not configured: ${missing.join(', ')} required`);
  const setting = (name: (typeof EFS_SETTINGS)[number]) => env[name]?.trim() ?? '';
  const fileSystemArn = setting('BOTCUBE_FILES_EFS_ARN');
  return accountFilesEfs({
    root,
    mountTargetIp: supplied ? mountTargetOf(supplied, fileSystemArn) : () => Promise.resolve(setting('BOTCUBE_FILES_MOUNT_TARGET_IP')),
    fileSystemArn,
    accessPoints: supplied ? suppliedAccessPoints(supplied, fileSystemArn, records) : env.BOTCUBE_FILES_POOL_MANIFEST !== undefined
      ? s3PoolAccessPoints(filesPoolManifest.parse(JSON.parse(env.BOTCUBE_FILES_POOL_MANIFEST)), records)
      : efsAccessPoints(fileSystemArn),
    mountCredentials: stsMountCredentials(setting('BOTCUBE_FILES_MOUNT_ROLE_ARN'), fileSystemArn),
    records,
    cleanupWorker: ecsCleanupWorker(env.ECS_CONTAINER_METADATA_URI_V4),
    linkKey: setting('BOTCUBE_FILES_SIGNING_KEY'),
  });
}


export const filesConfigured = (env: NodeJS.ProcessEnv) => EFS_SETTINGS.some((name) => env[name]?.trim());

export function accountFilesFromEnv(env: NodeJS.ProcessEnv, records: () => FilesRecords, supplied?: SuppliedFiles, root = '/mnt/files-efs'): () => AccountFiles {
  let files: AccountFiles | undefined;
  return () => files ??= efsFilesFromEnv(env, records, root, supplied);
}
