import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDocuments } from '../test/memory-documents.js';
import { AccountResources } from './account-resources.js';
import { accountFilesEfs, signFilesLink, type AccessPoints } from './files-efs.js';

const ACCOUNT = 'acct_0123456789';
/** `printf acct_0123456789 | shasum -a 256`, first 32 hex digits. */
const HASH = '8300e9d12ce55ca979c3e7e01a8f7fac';
const FILE_SYSTEM_ARN = 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0abc';
const LINKS = { url: 'https://links.test/', key: 'k'.repeat(64) };
const NOW = Date.UTC(2026, 10, 6, 5);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'files-efs-'));
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function fakeAccessPoints() {
  const live = new Map<string, string>();
  const created: string[] = [];
  const points: AccessPoints = {
    async create(directory, token) {
      const arn = `${FILE_SYSTEM_ARN.replace('file-system/fs-0abc', 'access-point')}/fsap-${token.slice(0, 8)}`;
      live.set(arn, directory); created.push(directory); return arn;
    },
    async delete(arn) { return live.delete(arn); },
  };
  return { live, created, points };
}

function setup() {
  const records = new AccountResources('chat', memoryDocuments());
  const access = fakeAccessPoints();
  const minted: string[] = [];
  const files = accountFilesEfs({
    root, mountTargetIp: '192.0.2.12', fileSystemArn: FILE_SYSTEM_ARN, accessPoints: access.points, records: () => records, links: LINKS,
    mountCredentials: async (accessPointArn) => {
      minted.push(accessPointArn);
      return { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token', expiration: new Date(Date.now() + 3_600_000).toISOString() };
    },
  });
  return { files, records, access, minted };
}

const put = async (account: string, name: string, body = 'x') => {
  const file = path.join(root, account, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
};
const claims = (link: string) => {
  const [payload, signature] = new URL(link).searchParams.get('t')?.split('.') ?? [];
  expect(signature).toBe(createHmac('sha256', LINKS.key).update(payload ?? '').digest('base64url'));
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
};

describe('EFS account Files', () => {
  it('lists every file in the account, nested ones too, without hidden folders or another account', async () => {
    const { files } = setup();
    expect(await files.list(ACCOUNT)).toEqual([]);
    await put(HASH, 'report.csv', 'a,b');
    await put(HASH, 'charts/q3.png', 'png');
    await put(HASH, '.uploads/abc', 'partial');
    await put(HASH, 'botcube-harness/.state/x', 'mine');
    await put('ffffffffffffffffffffffffffffffff', 'theirs.txt');
    const listed = await files.list(ACCOUNT);
    expect(listed.map(({ name, size }) => [name, size]).sort()).toEqual([['charts/q3.png', 3], ['report.csv', 3]]);
    expect(listed[0]?.lastModified).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('signs upload and download links the Files Lambda accepts, for this account, for five minutes', async () => {
    const { files } = setup();
    const upload = await files.uploadUrl(ACCOUNT, 'new/notes.md');
    expect(upload.startsWith(LINKS.url)).toBe(true);
    expect(claims(upload)).toEqual({ op: 'put', account: HASH, name: 'new/notes.md', exp: NOW / 1000 + 300 });
    await expect(files.downloadUrl(ACCOUNT, 'new/notes.md')).rejects.toMatchObject({ status: 404 });
    await put(HASH, 'new/notes.md');
    expect(claims(await files.downloadUrl(ACCOUNT, 'new/notes.md'))).toMatchObject({ op: 'get', account: HASH, name: 'new/notes.md' });
    expect(signFilesLink('u', 'k', { op: 'get', account: 'a', name: 'n' }, 1)).toBe(`u?t=${Buffer.from('{"op":"get","account":"a","name":"n","exp":1}').toString('base64url')}.${createHmac('sha256', 'k').update(Buffer.from('{"op":"get","account":"a","name":"n","exp":1}').toString('base64url')).digest('base64url')}`);
  });

  it('refuses an upload over a taken name, into a hidden folder, or out of the account', async () => {
    const { files } = setup();
    await put(HASH, 'taken.txt');
    await expect(files.uploadUrl(ACCOUNT, 'taken.txt')).rejects.toMatchObject({ status: 409 });
    await expect(files.uploadUrl(ACCOUNT, '.secret/x')).rejects.toMatchObject({ status: 400 });
    await expect(files.uploadUrl(ACCOUNT, '../x')).rejects.toMatchObject({ status: 400 });
    await expect(files.downloadUrl(ACCOUNT, '../../etc/passwd')).rejects.toMatchObject({ status: 400 });
  });

  it('removes a file, and answers 404 for one that is not there', async () => {
    const { files } = setup();
    await put(HASH, 'old.txt');
    await files.remove(ACCOUNT, 'old.txt');
    expect(await files.list(ACCOUNT)).toEqual([]);
    await expect(files.remove(ACCOUNT, 'old.txt')).rejects.toMatchObject({ status: 404 });
  });

  it('renames into a new folder but never over another file', async () => {
    const { files } = setup();
    await put(HASH, 'a.txt', 'A');
    await put(HASH, 'b.txt', 'B');
    await expect(files.rename(ACCOUNT, 'a.txt', 'b.txt')).rejects.toMatchObject({ status: 409 });
    expect(await readFile(path.join(root, HASH, 'b.txt'), 'utf8')).toBe('B');
    await files.rename(ACCOUNT, 'a.txt', 'archive/a.txt');
    expect((await files.list(ACCOUNT)).map(({ name }) => name).sort()).toEqual(['archive/a.txt', 'b.txt']);
    await expect(files.rename(ACCOUNT, 'a.txt', 'c.txt')).rejects.toMatchObject({ status: 404 });
  });

  it('creates one access point per account, once, and mints mount credentials for exactly that one', async () => {
    const { files, access, minted } = setup();
    const mount = await files.mount(ACCOUNT);
    expect(mount).toEqual({ accessPointArn: expect.stringContaining('access-point/fsap-'), fileSystemArn: FILE_SYSTEM_ARN, mountPath: '/mnt/files' });
    await files.mount(ACCOUNT);
    expect(access.created).toEqual([`/accounts/${HASH}`]);
    const binding = await files.mountBinding(ACCOUNT);
    expect(minted).toEqual([mount.accessPointArn]);
    expect(binding).toMatchObject({ fileSystemId: 'fs-0abc', mountTargetIp: '192.0.2.12', region: 'us-east-1', accessPointId: mount.accessPointArn.split('/').pop(), accessKeyId: 'AKIA' });
  });

  it('ignores retired S3 records and keeps the existing EFS record namespace', async () => {
    const { files, records } = setup();
    await records.call('PutItem', new PutCommand({ TableName: 'chat', Item: {
      pk: `FILES#${ACCOUNT}`, sk: 'META', accessPointArn: 'arn:aws:s3files:us-east-1:123456789012:access-point/s3ap-retired',
    } }));
    const mounted = await files.mount(ACCOUNT);
    expect(mounted.accessPointArn).toContain(':elasticfilesystem:');
    expect(await records.filesAccessPoint(ACCOUNT)).toBe(mounted.accessPointArn);
    await files.delete(ACCOUNT);
    expect(await records.filesAccessPoint(ACCOUNT)).toBeNull();
  });

  it('a Claim moves every file into the claiming account, a taken name getting the next free one, and retires the source', async () => {
    const { files, records, access } = setup();
    await records.call('PutItem', new PutCommand({ TableName: 'chat', Item: { pk: 'ACCOUNT#acct_claimed', sk: 'META', record: { accountId: 'acct_claimed' } } }));
    await files.mount(ACCOUNT);
    await put(HASH, 'report.csv', 'anonymous');
    await put(HASH, 'sub/deep.txt', 'deep');
    const destination = (await files.mount('acct_claimed')).accessPointArn;
    const claimedHash = path.basename(access.live.get(destination) ?? '');
    await put(claimedHash, 'report.csv', 'claimed');
    await files.transfer(ACCOUNT, 'acct_claimed');
    expect((await files.list('acct_claimed')).map(({ name }) => name).sort()).toEqual(['report (1).csv', 'report.csv', 'sub/deep.txt']);
    expect(await readFile(path.join(root, claimedHash, 'report.csv'), 'utf8')).toBe('claimed');
    expect(await readFile(path.join(root, claimedHash, 'report (1).csv'), 'utf8')).toBe('anonymous');
    await expect(readdir(path.join(root, HASH))).rejects.toMatchObject({ code: 'ENOENT' });
    expect([...access.live.keys()]).toEqual([destination]);
    await expect(files.uploadUrl(ACCOUNT, 'x')).rejects.toMatchObject({ status: 409 });
    await expect(files.mount(ACCOUNT)).rejects.toMatchObject({ status: 409 });
    await expect(files.mountBinding(ACCOUNT)).rejects.toMatchObject({ status: 409 });
  });

  it('account deletion removes the directory and the access point; a late write is swept until a day past the last credential', async () => {
    const { files, records, access } = setup();
    await files.mount(ACCOUNT);
    await put(HASH, 'a.txt');
    await files.delete(ACCOUNT);
    expect(access.live.size).toBe(0);
    await expect(readdir(path.join(root, HASH))).rejects.toMatchObject({ code: 'ENOENT' });
    // A session mounted before deletion still writes until its credentials run out.
    await put(HASH, 'late.txt');
    vi.mocked(Date.now).mockReturnValue(NOW + 3_600_000);
    await files.recoverCleanup();
    await expect(readdir(path.join(root, HASH))).rejects.toMatchObject({ code: 'ENOENT' });
    // Still inside the grace day: the cleanup comes back an hour later.
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * 3_600_000);
    expect(await records.pendingFilesCleanup()).toContain(ACCOUNT);
    vi.mocked(Date.now).mockReturnValue(NOW + 3_600_000 + 24 * 3_600_000 + 1);
    await files.recoverCleanup();
    expect(await records.pendingFilesCleanup()).not.toContain(ACCOUNT);
  });
});
