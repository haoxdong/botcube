import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { memoryDocuments } from '../test/memory-documents.js';
import { AccountResources } from './account-resources.js';
import { accountFilesFromEnv, filesConfigured } from './files.js';
import { directoryOf } from './files-shared.js';

it('serves persisted EFS files without a store selector or S3 configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'files-default-'));
  try {
    const account = 'acct_efs_cutover';
    const directory = path.join(root, path.basename(directoryOf(account)));
    await mkdir(directory);
    await writeFile(path.join(directory, 'reopened.txt'), 'persisted');
    const env = {
      BOTCUBE_FILES_EFS_ARN: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0abc',
      BOTCUBE_FILES_EFS_ROOT: root,
      BOTCUBE_FILES_LINKS_URL: 'https://files.example.test/',
      BOTCUBE_FILES_SIGNING_KEY: 'k'.repeat(64),
      BOTCUBE_FILES_MOUNT_ROLE_ARN: 'arn:aws:iam::123456789012:role/files-mount',
      BOTCUBE_FILES_MOUNT_TARGET_IP: '192.0.2.12',
    };
    expect(filesConfigured(env)).toBe(true);
    const files = accountFilesFromEnv(env, () => new AccountResources('chat', memoryDocuments()))();
    expect(await files.list(account)).toEqual([{ name: 'reopened.txt', size: 9, lastModified: expect.any(String) }]);
    const url = await files.downloadUrl(account, 'reopened.txt');
    expect(new URL(url).origin).toBe('https://files.example.test');
    await expect(files.downloadUrl('acct_other', 'reopened.txt')).rejects.toMatchObject({ status: 404 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
