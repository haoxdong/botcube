import { localCleanupWorker, type CleanupWorker } from './files-cleanup-worker.js';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AccessPointNotFound, CreateAccessPointCommand, DeleteAccessPointCommand, DescribeAccessPointsCommand, EFSClient,
} from '@aws-sdk/client-efs';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { saveArtifact } from './artifact-save.js';
import { HttpError } from './cartridge.js';
import {
  FILES_MOUNT_PATH, HIDDEN, POSIX_ID, RETIREMENT_GRACE_MS, MOUNT_SECONDS, URL_SECONDS,
  directoryOf, fileDestination, filePath, freeName,
  type AccountFiles, type FileEntry, type FilesMount, type FilesMountBinding, type FilesRecords,
} from './files-shared.js';

export type { FilesMountBinding } from './files-shared.js';

/** The EFS calls Files makes: one access point per account directory, as uid 1000. */
export interface AccessPoints {
  directory?(accessPointArn: string): string | Promise<string>;
  retainUntilCleanup?: boolean;
  /** Create the account's access point (idempotent for the same token) and wait until it is available. */
  create(directory: string, token: string, userId?: string): Promise<string>;
  /** Delete an access point; false when it was already gone. */
  delete(accessPointArn: string, userId?: string): Promise<boolean>;
}

/** Credentials that may mount exactly one access point. */
export type MountCredentials = (accessPointArn: string, sessionName: string) => Promise<Omit<FilesMountBinding, 'fileSystemId' | 'accessPointId' | 'mountTargetIp' | 'region'>>;

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
      DurationSeconds: MOUNT_SECONDS,
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
  root, fileSystemArn, mountTargetIp, accessPoints, mountCredentials, records, links, cleanupWorker = localCleanupWorker,
}: {
  cleanupWorker?: CleanupWorker;
  root: string;
  fileSystemArn: string;
  mountTargetIp: string;
  accessPoints: AccessPoints;
  mountCredentials: MountCredentials;
  records: () => FilesRecords;
  links: { url: string; key: string };
}): AccountFiles {
  // arn:aws:elasticfilesystem:<region>:<account>:file-system/<id>
  const [, , , region = '', , resource = ''] = fileSystemArn.split(':');
  const fileSystemId = resource.split('/')[1] ?? '';
  const directory = async (userId: string) => {
    if (!accessPoints.directory) return path.join(root, accountOf(userId));
    const saved = await records().filesAccessPoint(userId);
    if (saved === null && await records().filesRetirement(userId) !== null) return path.join(root, accountOf(userId));
    return path.join(root, (await accessPoints.directory(saved ?? await accessPoint(userId))).slice('/accounts/'.length));
  };
  const fileOf = async (userId: string, name: string) => path.join(await directory(userId), filePath(name));

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

  async function requireActive(userId: string, expectedAccessPoint?: string): Promise<void> {
    if (accessPoints.retainUntilCleanup && (!await records().filesAccountActive(userId) ||
      (expectedAccessPoint !== undefined && await records().filesAccessPoint(userId) !== expectedAccessPoint))) {
      throw new HttpError(409, 'User Files lease is no longer active');
    }
    if (await records().filesRetirement(userId) !== null) throw new HttpError(409, 'User Files are retired');
  }

  async function removeAccessPoint(userId: string, final = false): Promise<void> {
    if (accessPoints.retainUntilCleanup && !final) return;
    const accessPointArn = await records().filesAccessPoint(userId);
    if (accessPointArn === null) return;
    const deleted = await accessPoints.delete(accessPointArn, userId);
    await records().deleteFilesAccessPoint(userId);
    if (!deleted) throw new HttpError(404, 'Files access point not found');
  }

  async function accessPoint(userId: string): Promise<string> {
    const saved = await records().filesAccessPoint(userId);
    if (saved !== null) {
      await accessPoints.directory?.(saved);
      return saved;
    }
    const token = createHash('sha256').update(`files:${userId}`).digest('hex').slice(0, 64);
    const created = await accessPoints.create(`/${directoryOf(userId)}`, token, userId);
    if (!accessPoints.retainUntilCleanup) await records().saveFilesAccessPoint(userId, created);
    return created;
  }

  /** Move every file of the source into the destination, a taken name getting the next free one, then drop the source. */
  async function transferFiles(sourceUserId: string, destinationUserId: string): Promise<void> {
    await retirementOperation(destinationUserId, async () => {
      await requireActive(destinationUserId);
      const taken = new Set((await walk(await directory(destinationUserId))).map(({ name }) => name));
      for (const { name, file } of await walk(await directory(sourceUserId))) {
        let moved = freeName(name, taken);
        // A file written into the destination since it was listed takes the name first; try the next.
        // eslint-disable-next-line no-await-in-loop -- one file at a time: a retried claim moves what is left
        while (!await moveNoClobber(file, path.join(await directory(destinationUserId), moved))) {
          taken.add(moved);
          moved = freeName(name, taken);
        }
        taken.add(moved);
      }
      await rm(await directory(sourceUserId), { recursive: true, force: true });
      await removeAccessPoint(sourceUserId);
    });
  }

  async function cleanupDestination(destination: string | null): Promise<string | null> {
    while (destination !== null) {
      // eslint-disable-next-line no-await-in-loop -- each Claim follows the previous user's retirement
      const retirement = await records().filesRetirement(destination);
      if (retirement === null) break;
      destination = retirement.destinationAccountId;
    }
    if (destination === null) return null;
    return await records().filesAccountActive(destination) ? destination : null;
  }

  async function retirementOperation(userId: string, body: () => Promise<void>): Promise<void> {
    if (!accessPoints.retainUntilCleanup) return body();
    const previous = await records().filesCleanupClaim(userId);
    if (previous && !await cleanupWorker.stopped(previous)) throw new HttpError(503, 'Files cleanup is already running in a live worker.');
    const claim = { ...await cleanupWorker.identity(), token: randomUUID(), createdAt: Date.now() };
    if (!await records().claimFilesCleanup(userId, claim, previous?.token)) throw new HttpError(503, 'Files cleanup ownership changed; retry cleanup.');
    try { await body(); }
    finally { await records().releaseFilesCleanup(userId, claim.token); }
  }

  async function cleanupRetirement(userId: string): Promise<void> {
    const retirement = await records().filesRetirement(userId);
    if (retirement === null) return;
    const destination = await cleanupDestination(retirement.destinationAccountId);
    if (destination === null) await rm(await directory(userId), { recursive: true, force: true });
    else await transferFiles(userId, destination);
    await removeAccessPoint(userId);
    // A session mounted before retirement may write until its credentials expire, and a day past that.
    if (Date.now() >= retirement.lastCredentialExpiresAt + RETIREMENT_GRACE_MS && !await exists(await directory(userId))) {
      await removeAccessPoint(userId, true);
      await records().completeFilesCleanup(userId, retirement.lastCredentialExpiresAt);
      return;
    }
    await records().scheduleFilesCleanup(userId, Date.now() + MOUNT_SECONDS * 1000, retirement.lastCredentialExpiresAt);
  }

  const link_ = async (op: 'get' | 'put', userId: string, name: string) =>
    signFilesLink(links.url, links.key, { op, account: path.basename(await directory(userId)), name }, Math.floor(Date.now() / 1000) + URL_SECONDS);

  return {
    async recoverCleanup() {
      const failures: HttpError[] = [];
      for (const userId of await records().pendingFilesCleanup()) {
        try {
          // eslint-disable-next-line no-await-in-loop -- failures are reported together after unrelated users progress
          await retirementOperation(userId, () => cleanupRetirement(userId));
        } catch (cause) {
          failures.push(Object.assign(new HttpError(503, 'Retired-user Files cleanup failed'), { userId, cause }));
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Retired-user Files cleanup remains pending');
    },
    async mount(userId): Promise<FilesMount> {
      await requireActive(userId);
      const accessPointArn = await accessPoint(userId);
      await requireActive(userId, accessPointArn);
      return { accessPointArn, fileSystemArn, mountPath: FILES_MOUNT_PATH };
    },
    async transfer(sourceUserId, destinationUserId) {
      await retirementOperation(sourceUserId, async () => {
        await records().retireFiles(sourceUserId, destinationUserId, Date.now() + MOUNT_SECONDS * 1000);
        await transferFiles(sourceUserId, destinationUserId);
      });
    },
    async delete(userId) {
      await retirementOperation(userId, async () => {
        await records().retireFiles(userId, null, Date.now() + MOUNT_SECONDS * 1000);
        await rm(await directory(userId), { recursive: true, force: true });
        await removeAccessPoint(userId);
      });
    },
    async list(userId) {
      return (await walk(await directory(userId))).map(({ name, size, lastModified }) => ({ name, size, lastModified }));
    },
    async uploadUrl(userId, name) {
      await requireActive(userId);
      const destination = fileDestination(name);
      if (await exists(await fileOf(userId, destination))) throw new HttpError(409, `A file named ${name} is already in Files`);
      return link_('put', userId, destination);
    },
    async downloadUrl(userId, name) {
      if (!await exists(await fileOf(userId, name))) throw new HttpError(404, `No file ${name} in Files`);
      return link_('get', userId, name);
    },
    async remove(userId, name) {
      try {
        await unlink(await fileOf(userId, name));
      } catch (error) {
        if (missing(error)) throw Object.assign(new HttpError(404, `No file ${name} in Files`), { cause: error });
        throw error;
      }
    },
    async rename(userId, from, to) {
      const [source, target] = [await fileOf(userId, from), await fileOf(userId, fileDestination(to))];
      if (!await exists(source)) throw new HttpError(404, `No file ${from} in Files`);
      if (!await moveNoClobber(source, target)) throw new HttpError(409, `A file named ${to} is already in Files`);
    },
    async saveArtifact(userId, save) {
      await requireActive(userId);
      return saveArtifact(await directory(userId), save);
    },
    async mountBinding(userId) {
      await requireActive(userId);
      const accessPointArn = await accessPoint(userId);
      await requireActive(userId, accessPointArn);
      const credentials = await mountCredentials(accessPointArn, `files-${accountOf(userId)}`);
      await requireActive(userId, accessPointArn);
      return { fileSystemId, mountTargetIp, accessPointId: accessPointArn.split('/').pop() ?? '', region, ...credentials };
    },
  };
}

