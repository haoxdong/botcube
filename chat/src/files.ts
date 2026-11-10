import { HttpError } from './cartridge.js';
import { accountFilesEfs, efsAccessPoints, stsMountCredentials } from './files-efs.js';
import type { AccountFiles, FilesRecords } from './files-shared.js';

export type { AccountFiles, FileEntry, FilesMount, FilesRecords } from './files-shared.js';

const EFS_SETTINGS = ['BOTCUBE_FILES_EFS_ARN', 'BOTCUBE_FILES_EFS_ROOT', 'BOTCUBE_FILES_LINKS_URL', 'BOTCUBE_FILES_SIGNING_KEY', 'BOTCUBE_FILES_MOUNT_ROLE_ARN', 'BOTCUBE_FILES_MOUNT_TARGET_IP'] as const;


function efsFilesFromEnv(env: NodeJS.ProcessEnv, records: () => FilesRecords): AccountFiles {
  const missing = EFS_SETTINGS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new HttpError(503, `Files on EFS are not configured: ${missing.join(', ')} required`);
  const setting = (name: (typeof EFS_SETTINGS)[number]) => env[name]?.trim() ?? '';
  const fileSystemArn = setting('BOTCUBE_FILES_EFS_ARN');
  return accountFilesEfs({
    root: setting('BOTCUBE_FILES_EFS_ROOT'),
    mountTargetIp: setting('BOTCUBE_FILES_MOUNT_TARGET_IP'),
    fileSystemArn,
    accessPoints: efsAccessPoints(fileSystemArn),
    mountCredentials: stsMountCredentials(setting('BOTCUBE_FILES_MOUNT_ROLE_ARN'), fileSystemArn),
    records,
    links: { url: setting('BOTCUBE_FILES_LINKS_URL'), key: setting('BOTCUBE_FILES_SIGNING_KEY') },
  });
}


export const filesConfigured = (env: NodeJS.ProcessEnv) => EFS_SETTINGS.some((name) => env[name]?.trim());

export function accountFilesFromEnv(env: NodeJS.ProcessEnv, records: () => FilesRecords): () => AccountFiles {
  let files: AccountFiles | undefined;
  return () => files ??= efsFilesFromEnv(env, records);
}
