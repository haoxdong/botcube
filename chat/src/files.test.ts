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
      BOTCUBE_FILES_SIGNING_KEY: 'k'.repeat(64),
      BOTCUBE_FILES_MOUNT_ROLE_ARN: 'arn:aws:iam::123456789012:role/files-mount',
      BOTCUBE_FILES_MOUNT_TARGET_IP: '192.0.2.12',
    };
    expect(filesConfigured(env)).toBe(true);
    const files = accountFilesFromEnv(env, () => new AccountResources('chat', memoryDocuments()), undefined, root)();
    expect(await files.list(account)).toEqual([{ name: 'reopened.txt', size: 9, lastModified: expect.any(String) }]);
    expect(await files.downloadUrl(account, 'reopened.txt')).toMatch(/^\/files\/link\?t=/);
    await expect(files.downloadUrl('acct_other', 'reopened.txt')).rejects.toMatchObject({ status: 404 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("leases a User's access point from the existing pool on first use, and names that pool when none is free", async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'files-existing-'));
  try {
    const documents = memoryDocuments();
    for (const user of ['acct_a', 'acct_b']) documents.items.set(`ACCOUNT#${user}\u0000META`, { pk: `ACCOUNT#${user}`, sk: 'META', record: { accountId: user } });
    const store = new AccountResources('chat', documents);
    const env = {
      BOTCUBE_FILES_EFS_ARN: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0abc',
      BOTCUBE_FILES_SIGNING_KEY: 'k'.repeat(64),
      BOTCUBE_FILES_MOUNT_ROLE_ARN: 'arn:aws:iam::123456789012:role/files-mount',
      BOTCUBE_FILES_MOUNT_TARGET_IP: '192.0.2.12',
    };
    const existing = {
      fileSystemId: 'fs-0abc', kmsKey: 'arn:aws:kms:us-east-1:123456789012:key/files', accountsAccessPointId: 'fsap-0acc',
      accessPoints: [{ accessPointId: 'fsap-0a1', rootDirectory: '/accounts/00000000000000000000000000000001' }],
    };
    const files = accountFilesFromEnv(env, () => store, existing, root)();

    await files.uploadUrl('acct_a', 'first.txt');
    expect(await store.filesAccessPoint('acct_a')).toBe('arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0a1');
    await expect(files.uploadUrl('acct_b', 'second.txt')).rejects.toMatchObject({ status: 503, message: expect.stringContaining('existing.files.accessPoints') });
    const { BOTCUBE_FILES_MOUNT_TARGET_IP: _, ...unaddressed } = env;
    expect(() => accountFilesFromEnv(unaddressed, () => store, existing, root)()).toThrow('BOTCUBE_FILES_MOUNT_TARGET_IP required');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
