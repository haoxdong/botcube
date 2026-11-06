import { createHash, createHmac } from 'node:crypto';
import { link, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AccessPointNotFound, CreateAccessPointCommand, DeleteAccessPointCommand, DescribeAccessPointsCommand, EFSClient,
} from '@aws-sdk/client-efs';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { HttpError } from './cartridge.js';
import {
  FILES_MOUNT_PATH, HIDDEN, POSIX_ID, RETIREMENT_GRACE_MS, SYNC_SECONDS, URL_SECONDS,
  directoryOf, fileDestination, filePath, freeName,
  type AccountFiles, type FileEntry, type FilesMount, type FilesMountBinding, type FilesRecords,
} from './files-shared.js';

export type { FilesMountBinding } from './files-shared.js';

/** The EFS calls Files makes: one access point per account directory, as uid 1000. */
export interface AccessPoints {
  /** Create the account's access point (idempotent for the same token) and wait until it is available. */
  create(directory: string, token: string): Promise<string>;
  /** Delete an access point; false when it was already gone. */
  delete(accessPointArn: string): Promise<boolean>;
}

/** Credentials that may mount exactly one access point. */
export type MountCredentials = (accessPointArn: string, sessionName: string) => Promise<Omit<FilesMountBinding, 'fileSystemId' | 'accessPointId' | 'region'>>;

/** EFS access points for account directories, as uid 1000, polled until available. */
export function efsAccessPoints(fileSystemArn: string, poll = { intervalMs: 1000, attempts: 60 }): AccessPoints {
  const [, , , region = '', , resource = ''] = fileSystemArn.split(':');
  const fileSystemId = resource.split('/')[1] ?? '';
  const efs = new EFSClient({ region });
  return {
    async create(directory, token) {
      const { AccessPointArn: arn, AccessPointId: id } = await efs.send(new CreateAccessPointCommand({
        // The account's token: a retry, or a wake racing another, gets the same access point.
        ClientToken: token,
        FileSystemId: fileSystemId,
        PosixUser: { Uid: POSIX_ID, Gid: POSIX_ID },
        RootDirectory: { Path: directory, CreationInfo: { OwnerUid: POSIX_ID, OwnerGid: POSIX_ID, Permissions: '750' } },
      }));
      if (!arn || !id) throw new Error('EFS CreateAccessPoint answered no access point');
      for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- polling: each look waits on the last
        const [point] = (await efs.send(new DescribeAccessPointsCommand({ AccessPointId: id }))).AccessPoints ?? [];
        if (point?.LifeCycleState === 'available') return arn;
        if (point?.LifeCycleState !== 'creating') throw new Error(`EFS access point ${id} is ${point?.LifeCycleState}`);
        // eslint-disable-next-line no-await-in-loop -- polling
        await delay(poll.intervalMs);
      }
      throw new Error(`EFS access point ${id} is still creating`);
    },
    async delete(arn) {
      try {
        await efs.send(new DeleteAccessPointCommand({ AccessPointId: arn.split('/').pop() }));
        return true;
      } catch (error) {
        if (error instanceof AccessPointNotFound) return false;
        throw error;
      }
    },
  };
}

/**
 * Credentials from `roleArn` whose session policy names one access point: a Runtime session mounts
 * its own account's Files with them and no other's (measured: another access point, the
 * root and an anonymous mount are all refused).
 */
export function stsMountCredentials(roleArn: string, fileSystemArn: string): MountCredentials {
  const sts = new STSClient({ region: fileSystemArn.split(':')[3] ?? '' });
  return async (accessPointArn, sessionName) => {
    const { Credentials: credentials } = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      DurationSeconds: SYNC_SECONDS,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
          Resource: fileSystemArn,
          Condition: { StringEquals: { 'elasticfilesystem:AccessPointArn': accessPointArn } },
        }],
      }),
    }));
    const { AccessKeyId: accessKeyId, SecretAccessKey: secretAccessKey, SessionToken: sessionToken, Expiration: expiration } = credentials ?? {};
    if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) throw new Error('STS AssumeRole answered no credentials for Files');
    return { accessKeyId, secretAccessKey, sessionToken, expiration: expiration.toISOString() };
  };
}

/** A Files link the Files Lambda serves: the same claims and HMAC as botcube/infra/ecs/files/files.mjs. */
export function signFilesLink(baseUrl: string, key: string, claims: { op: 'get' | 'put'; account: string; name: string }, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: expiresAt })).toString('base64url');
  return `${baseUrl}?t=${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

/** The hash part of an account's directory, as a link names it. */
const accountOf = (accountId: string) => directoryOf(accountId).slice('accounts/'.length);

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Every account's Files on one EFS file system: the Chat Service mounts the `/accounts` access point
 * at `root`, each Browser and Runtime session mounts only its account's own access point, and the
 * Files Lambda serves signed upload and download links. There are no versions: a delete or a move
 * is one file operation, and a Claim moves files within the file system.
 */
export function accountFilesEfs({
  root, fileSystemArn, accessPoints, mountCredentials, records, links,
}: {
  root: string;
  fileSystemArn: string;
  accessPoints: AccessPoints;
  mountCredentials: MountCredentials;
  records: () => FilesRecords;
  links: { url: string; key: string };
}): AccountFiles<FilesMountBinding> {
  // arn:aws:elasticfilesystem:<region>:<account>:file-system/<id>
  const [, , , region = '', , resource = ''] = fileSystemArn.split(':');
  const fileSystemId = resource.split('/')[1] ?? '';
  const directory = (accountId: string) => path.join(root, accountOf(accountId));
  const fileOf = (accountId: string, name: string) => path.join(directory(accountId), filePath(name));

  /** Every visible file under a directory, by its name relative to it. */
  async function walk(base: string, prefix = ''): Promise<Array<FileEntry & { file: string }>> {
    let entries;
    try {
      entries = await readdir(path.join(base, prefix), { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const found: Array<FileEntry & { file: string }> = [];
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Hidden folders (the Harness's own, an upload's parts) are not the user's Files.
        // eslint-disable-next-line no-await-in-loop -- one folder at a time keeps NFS round trips bounded
        if (!HIDDEN.test(`${name}/`)) found.push(...await walk(base, name));
      } else if (entry.isFile()) {
        const file = path.join(base, name);
        // eslint-disable-next-line no-await-in-loop -- one stat at a time, as the walk reads
        const { size, mtime } = await stat(file);
        found.push({ name, size, lastModified: mtime.toISOString(), file });
      }
    }
    return found;
  }

  async function exists(file: string): Promise<boolean> {
    try {
      await stat(file);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  /** Give `from` the name `to` without ever replacing a file there: link refuses a taken name. */
  async function moveNoClobber(from: string, to: string): Promise<boolean> {
    await mkdir(path.dirname(to), { recursive: true });
    try {
      await link(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    await unlink(from);
    return true;
  }

  async function requireActive(accountId: string): Promise<void> {
    if (await records().filesRetirement(accountId) !== null) throw new HttpError(409, 'Account Files are retired');
  }

  async function removeAccessPoint(accountId: string): Promise<void> {
    const accessPointArn = await records().filesAccessPoint(accountId);
    if (accessPointArn === null) return;
    const deleted = await accessPoints.delete(accessPointArn);
    await records().deleteFilesAccessPoint(accountId);
    if (!deleted) throw new HttpError(404, 'Files access point not found');
  }

  async function accessPoint(accountId: string): Promise<string> {
    const saved = await records().filesAccessPoint(accountId);
    if (saved !== null) return saved;
    const token = createHash('sha256').update(`files:${accountId}`).digest('hex').slice(0, 64);
    const created = await accessPoints.create(`/${directoryOf(accountId)}`, token);
    await records().saveFilesAccessPoint(accountId, created);
    return created;
  }

  /** Move every file of the source into the destination, a taken name getting the next free one, then drop the source. */
  async function transferFiles(sourceAccountId: string, destinationAccountId: string): Promise<void> {
    const taken = new Set((await walk(directory(destinationAccountId))).map(({ name }) => name));
    for (const { name, file } of await walk(directory(sourceAccountId))) {
      let moved = freeName(name, taken);
      // A file written into the destination since it was listed takes the name first; try the next.
      // eslint-disable-next-line no-await-in-loop -- one file at a time: a retried claim moves what is left
      while (!await moveNoClobber(file, path.join(directory(destinationAccountId), moved))) {
        taken.add(moved);
        moved = freeName(name, taken);
      }
      taken.add(moved);
    }
    await rm(directory(sourceAccountId), { recursive: true, force: true });
    await removeAccessPoint(sourceAccountId);
  }

  async function cleanupDestination(destination: string | null): Promise<string | null> {
    while (destination !== null) {
      // eslint-disable-next-line no-await-in-loop -- each Claim follows the previous account's retirement
      const retirement = await records().filesRetirement(destination);
      if (retirement === null) break;
      destination = retirement.destinationAccountId;
    }
    if (destination === null) return null;
    return await records().filesAccountActive(destination) ? destination : null;
  }

  async function cleanupRetirement(accountId: string): Promise<void> {
    const retirement = await records().filesRetirement(accountId);
    if (retirement === null) return;
    const destination = await cleanupDestination(retirement.destinationAccountId);
    if (destination === null) await rm(directory(accountId), { recursive: true, force: true });
    else await transferFiles(accountId, destination);
    await removeAccessPoint(accountId);
    // A session mounted before retirement may write until its credentials expire, and a day past that.
    if (Date.now() >= retirement.lastCredentialExpiresAt + RETIREMENT_GRACE_MS && !await exists(directory(accountId))) {
      await records().completeFilesCleanup(accountId, retirement.lastCredentialExpiresAt);
      return;
    }
    await records().scheduleFilesCleanup(accountId, Date.now() + SYNC_SECONDS * 1000, retirement.lastCredentialExpiresAt);
  }

  const link_ = (op: 'get' | 'put', accountId: string, name: string) =>
    signFilesLink(links.url, links.key, { op, account: accountOf(accountId), name }, Math.floor(Date.now() / 1000) + URL_SECONDS);

  return {
    async recoverCleanup() {
      const failures: HttpError[] = [];
      for (const accountId of await records().pendingFilesCleanup()) {
        try {
          // eslint-disable-next-line no-await-in-loop -- failures are reported together after unrelated accounts progress
          await cleanupRetirement(accountId);
        } catch (cause) {
          failures.push(Object.assign(new HttpError(503, 'Retired-account Files cleanup failed'), { accountId, cause }));
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Retired-account Files cleanup remains pending');
    },
    async mount(accountId): Promise<FilesMount> {
      await requireActive(accountId);
      const accessPointArn = await accessPoint(accountId);
      await requireActive(accountId);
      return { accessPointArn, fileSystemArn, mountPath: FILES_MOUNT_PATH };
    },
    async transfer(sourceAccountId, destinationAccountId) {
      await records().retireFiles(sourceAccountId, destinationAccountId, Date.now() + SYNC_SECONDS * 1000);
      await transferFiles(sourceAccountId, destinationAccountId);
    },
    async delete(accountId) {
      await records().retireFiles(accountId, null, Date.now() + SYNC_SECONDS * 1000);
      await rm(directory(accountId), { recursive: true, force: true });
      await removeAccessPoint(accountId);
    },
    async list(accountId) {
      return (await walk(directory(accountId))).map(({ name, size, lastModified }) => ({ name, size, lastModified }));
    },
    async uploadUrl(accountId, name) {
      await requireActive(accountId);
      const destination = fileDestination(name);
      if (await exists(fileOf(accountId, destination))) throw new HttpError(409, `A file named ${name} is already in Files`);
      return link_('put', accountId, destination);
    },
    async downloadUrl(accountId, name) {
      if (!await exists(fileOf(accountId, name))) throw new HttpError(404, `No file ${name} in Files`);
      return link_('get', accountId, name);
    },
    async remove(accountId, name) {
      try {
        await unlink(fileOf(accountId, name));
      } catch (error) {
        if (missing(error)) throw Object.assign(new HttpError(404, `No file ${name} in Files`), { cause: error });
        throw error;
      }
    },
    async rename(accountId, from, to) {
      const [source, target] = [fileOf(accountId, from), fileOf(accountId, fileDestination(to))];
      if (!await exists(source)) throw new HttpError(404, `No file ${from} in Files`);
      if (!await moveNoClobber(source, target)) throw new HttpError(409, `A file named ${to} is already in Files`);
    },
    async syncBinding(accountId) {
      await requireActive(accountId);
      const accessPointArn = await accessPoint(accountId);
      const credentials = await mountCredentials(accessPointArn, `files-${accountOf(accountId)}`);
      await requireActive(accountId);
      return { fileSystemId, accessPointId: accessPointArn.split('/').pop() ?? '', region, ...credentials };
    },
  };
}

