import { localCleanupWorker, type CleanupWorker } from './files-cleanup-worker.js';
import { createHash, randomUUID } from 'node:crypto';
import { rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AccessPointNotFound, CreateAccessPointCommand, DeleteAccessPointCommand, DescribeAccessPointsCommand, EFSClient,
} from '@aws-sdk/client-efs';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { AccountTree, errorCode } from './account-tree.js';
import { restoreArtifact, saveArtifact } from './artifact-save.js';
import { walk } from './files-walk.js';
import { HttpError } from './http-error.js';
import { answerFilesLink, signFilesLink } from './files-link.js';
import {
  FILES_MOUNT_PATH, POSIX_ID, RETIREMENT_GRACE_MS, MOUNT_SECONDS, URL_SECONDS, WRITTEN_MEMORY,
  directoryOf, fileDestination, filePath, freeName,
  type AccountFiles, type FilesMount, type FilesMountBinding, type FilesRecords,
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

/**
 * Every account's Files on one EFS file system: the Chat Service mounts the `/accounts` access point
 * at `root`, each Browser and Runtime session mounts only its account's own access point, and the
 * Chat Service serves signed upload and download links from `root`. There are no versions: a delete or a move
 * is one file operation, and a Claim moves files within the file system.
 */
export function accountFilesEfs({
  root, fileSystemArn, mountTargetIp, accessPoints, mountCredentials, records, linkKey, cleanupWorker = localCleanupWorker,
}: {
  cleanupWorker?: CleanupWorker;
  root: string;
  fileSystemArn: string;
  mountTargetIp: string;
  accessPoints: AccessPoints;
  mountCredentials: MountCredentials;
  records: () => FilesRecords;
  linkKey: string;
}): AccountFiles {
  // arn:aws:elasticfilesystem:<region>:<account>:file-system/<id>
  const [, , , region = '', , resource = ''] = fileSystemArn.split(':');
  const fileSystemId = resource.split('/')[1] ?? '';
  const directory = async (userId: string, allocate = true) => {
    if (!accessPoints.directory) return path.join(root, directoryOf(userId));
    const saved = await records().filesAccessPoint(userId);
    if (saved === null && !allocate) throw new HttpError(404, 'User Files lease not found');
    if (saved === null && await records().filesRetirement(userId) !== null) return path.join(root, directoryOf(userId));
    return path.join(root, (await accessPoints.directory(saved ?? await accessPoint(userId))).slice('/accounts/'.length));
  };
  const fileOf = async (userId: string, name: string) => path.join(await directory(userId), filePath(name));


  async function exists(file: string): Promise<boolean> {
    try {
      await stat(file);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  /** Removes an account's Files. Its agent may still write until its credentials expire, so the tree is emptied by fd, never by path. */
  async function removeFiles(userId: string): Promise<void> {
    const folder = await directory(userId);
    await (await AccountTree.account(folder))?.removeTree();
    await rmdir(folder).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }

  /** A missing file, or a missing account folder, answers 404. */
  async function inFiles<T>(userId: string, name: string, body: (tree: AccountTree) => Promise<T>): Promise<T> {
    const notFound = (cause?: unknown) => Object.assign(new HttpError(404, `No file ${name} in Files`), { cause });
    const tree = await AccountTree.account(await directory(userId));
    if (tree === null) throw notFound();
    try {
      return await body(tree);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw notFound(error);
      throw error;
    }
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
    const created = await accessPoints.create(`/accounts/${directoryOf(userId)}`, token, userId);
    if (!accessPoints.retainUntilCleanup) await records().saveFilesAccessPoint(userId, created);
    return created;
  }

  /** Move every file of the source into the destination, a taken name getting the next free one, then drop the source. */
  async function transferFiles(sourceUserId: string, destinationUserId: string): Promise<void> {
    await retirementOperation(destinationUserId, async () => {
      await requireActive(destinationUserId);
      const taken = new Set((await walk(await directory(destinationUserId))).files.map(({ name }) => name));
      const destination = await AccountTree.account(await directory(destinationUserId), true);
      if (destination === null) throw new HttpError(503, 'The claiming account has no Files folder');
      const source = await AccountTree.account(await directory(sourceUserId));
      // The source walk never descends a link (a Dirent is not a directory); each move then goes through
      // folders opened in both trees, so a link either agent swaps in after the walk is refused.
      if (source !== null) {
        for (const { name } of (await walk(await directory(sourceUserId))).files) {
          let moved = freeName(name, taken);
          // A file written into the destination since it was listed takes the name first; try the next.
          // eslint-disable-next-line no-await-in-loop -- one file at a time: a retried claim moves what is left
          while (!await source.moveTo(destination, filePath(name), filePath(moved))) {
            taken.add(moved);
            moved = freeName(name, taken);
          }
          taken.add(moved);
        }
      }
      await removeFiles(sourceUserId);
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
    if (destination === null) await removeFiles(userId);
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

  const signedLink = (op: 'GET' | 'PUT', userId: string, name: string) =>
    signFilesLink(linkKey, { op, userId, name, expiresAtSeconds: Math.floor(Date.now() / 1000) + URL_SECONDS });

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
        await removeFiles(userId);
        await removeAccessPoint(userId);
      });
    },
    async list(userId) {
      const { files, folders } = await walk(await directory(userId));
      return { files: files.map(({ name, size, lastModified }) => ({ name, size, lastModified })), folders };
    },
    async makeFolder(userId, name) {
      // Checked as a folder: a name starting with a dot would hide it from the listing.
      const folder = filePath(fileDestination(`${name}/`).slice(0, -1));
      await requireActive(userId);
      const tree = await AccountTree.account(await directory(userId), true);
      if (tree === null) throw new HttpError(503, 'This account has no Files folder');
      if (!await tree.makeFolder(folder)) throw new HttpError(409, `A folder named ${name} is already in Files`);
    },
    async copy(userId, from, to) {
      const [source, destination] = [filePath(from), filePath(fileDestination(to))];
      await requireActive(userId);
      await inFiles(userId, from, (tree) => tree.copy(source, destination, false)).catch((error: unknown) => {
        if (errorCode(error) === 'EEXIST') throw new HttpError(409, `A file named ${to} is already in Files`);
        throw error;
      });
    },
    async uploadUrl(userId, name) {
      await requireActive(userId);
      const destination = fileDestination(name);
      if (await exists(await fileOf(userId, destination))) throw new HttpError(409, `A file named ${name} is already in Files`);
      return signedLink('PUT', userId, destination);
    },
    async downloadUrl(userId, name) {
      if (!await exists(await fileOf(userId, name))) throw new HttpError(404, `No file ${name} in Files`);
      return signedLink('GET', userId, name);
    },
    link: (request) => answerFilesLink({
      key: linkKey,
      directoryForUser: async (userId) => {
        await requireActive(userId);
        return directory(userId, false);
      },
    }, request),
    async remove(userId, name) {
      const file = filePath(name);
      await inFiles(userId, name, (tree) => tree.unlink(file));
    },
    async rename(userId, from, to) {
      // Names are checked before the account folder: a bad name is 400 even for an account with no Files.
      const [source, destination] = [filePath(from), filePath(fileDestination(to))];
      const moved = await inFiles(userId, from, async (tree) => {
        if (!await tree.isFolder(source)) return tree.moveNoClobber(source, destination);
        // A folder is checked as one, so it never hides behind a dot, and it can't go inside itself.
        fileDestination(`${destination}/`);
        if (destination.startsWith(`${source}/`)) throw new HttpError(400, `${from} can't move into itself`);
        return tree.moveFolderNoClobber(source, destination);
      });
      if (!moved) throw new HttpError(409, `A file named ${to} is already in Files`);
    },
    async saveArtifact(userId, save) {
      await requireActive(userId);
      return saveArtifact(await directory(userId), save);
    },
    async restoreArtifact(userId, restore) {
      await requireActive(userId);
      return restoreArtifact(await directory(userId), restore);
    },
    async writtenMemory(userId) {
      const tree = await AccountTree.account(await directory(userId));
      if (tree === null) return '';
      return tree.read(WRITTEN_MEMORY).then((content) => content.toString('utf8'), (error: unknown) => {
        if (errorCode(error) === 'ENOENT') return '';
        throw error;
      });
    },
    async saveWrittenMemory(userId, content) {
      await requireActive(userId);
      const tree = await AccountTree.account(await directory(userId), true);
      if (tree === null) throw new HttpError(503, 'This account has no Files folder');
      const saving = `${path.posix.dirname(WRITTEN_MEMORY)}/.${path.posix.basename(WRITTEN_MEMORY)}.saving-${randomUUID()}`;
      try {
        await tree.write(saving, content, 'new');
        await tree.rename(saving, WRITTEN_MEMORY);
      } catch (error) {
        await tree.unlink(saving).catch(() => undefined);
        throw error;
      }
    },
    async mountBinding(userId) {
      await requireActive(userId);
      const accessPointArn = await accessPoint(userId);
      await requireActive(userId, accessPointArn);
      const credentials = await mountCredentials(accessPointArn, `files-${directoryOf(userId)}`);
      await requireActive(userId, accessPointArn);
      return { fileSystemId, mountTargetIp, accessPointId: accessPointArn.split('/').pop() ?? '', region, ...credentials };
    },
  };
}

