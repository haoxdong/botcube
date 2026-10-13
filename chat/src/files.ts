import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type _Object,
} from '@aws-sdk/client-s3';
import {
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  GetAccessPointCommand,
  ResourceNotFoundException,
  S3FilesClient,
} from '@aws-sdk/client-s3files';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { HttpError } from './cartridge.js';

/** Where every Agent Computer browser mounts its account's Files; Chrome's download directory (deploy/agent-computer). */
const FILES_MOUNT_PATH = '/mnt/files';
/** How long a Files upload or download URL stays valid. */
const URL_SECONDS = 300;
/** The POSIX identity every file operation through an account's access point runs as. */
const POSIX_ID = 1000;
/** How long the agent's Files credentials last: role chaining's ceiling, and the Runtime's longest microVM. */
const SYNC_SECONDS = 3600;
/** How often, and how many times, a new access point is looked at until it is available. */
const ACCESS_POINT_POLL = { intervalMs: 1000, attempts: 60 };

/** An S3 Files access point a browser Session mounts, as StartBrowserSession takes it. */
export interface FilesMount {
  accessPointArn: string;
  fileSystemArn: string;
  mountPath: string;
}

interface FileEntry {
  name: string;
  size: number;
  lastModified: string;
}

/**
 * What a Turn hands the agent's Harness so it can sync its workspace with the account's Files
 * (ADR 0077 decision 2): the account's prefix, and credentials that reach that prefix alone.
 */
interface FilesSyncBinding {
  bucket: string;
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** Where an account's Files access point is kept once created. */
export interface FilesRecords {
  filesAccessPoint(accountId: string): Promise<string | null>;
  saveFilesAccessPoint(accountId: string, accessPointArn: string): Promise<void>;
  deleteFilesAccessPoint(accountId: string): Promise<void>;
}

/** An account's Files: one directory of the S3 Files file system, reached through its own access point. */
export interface AccountFiles {
  /** The account's access point, created on first use, mounted at FILES_MOUNT_PATH. */
  mount(accountId: string): Promise<FilesMount>;
  list(accountId: string): Promise<FileEntry[]>;
  uploadUrl(accountId: string, name: string): Promise<string>;
  downloadUrl(accountId: string, name: string): Promise<string>;
  /** Delete a file and every earlier version of it, so none can come back; 404 when it is not there. */
  remove(accountId: string, name: string): Promise<void>;
  /** Give a file another name: its current version moves, and the old name keeps no version. */
  rename(accountId: string, from: string, to: string): Promise<void>;
  /** The agent's Turn binding to the account's Files, with credentials scoped to its directory. */
  syncBinding(accountId: string): Promise<FilesSyncBinding>;
  /** Move every file into another account's Files, as an Account Claim does (ADR 0077), leaving no version behind, then drop the source's access point. */
  transfer(sourceAccountId: string, destinationAccountId: string): Promise<void>;
  /** Account deletion: every object version and delete marker in the account's directory, then its access point. */
  delete(accountId: string): Promise<void>;
}

/** The account's directory: a hash, so no account ID can name another's or escape the file system's layout. */
const directoryOf = (accountId: string) =>
  `accounts/${createHash('sha256').update(accountId).digest('hex').slice(0, 32)}`;

/** A version or delete marker in the Files bucket. */
type Version = { Key?: string | undefined; VersionId?: string | undefined; IsLatest?: boolean | undefined; marker: boolean };

/** `name`, or the first of `report (1).csv`, `report (2).csv`, ... that is not taken. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const base = name.lastIndexOf('/') + 1;
  const dot = name.lastIndexOf('.');
  const stem = dot > base ? dot : name.length;
  let copy = 1;
  while (taken.has(`${name.slice(0, stem)} (${copy})${name.slice(stem)}`)) copy += 1;
  return `${name.slice(0, stem)} (${copy})${name.slice(stem)}`;
}

/** A path inside the account's directory; a segment that is empty, `.` or `..` would leave it. */
function filePath(name: string): string {
  const segments = name.split('/');
  if (!name || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new HttpError(400, 'name must be a path inside Files');
  }
  return name;
}

function fileDestination(name: string): string {
  if (name.split('/').some((segment) => Buffer.byteLength(segment, 'utf8') > 255)) {
    throw new HttpError(400, 'Each file name in Files must be at most 255 UTF-8 bytes');
  }
  return name;
}

const FILES_SETTINGS = ['BOTCUBE_FILES_BUCKET', 'BOTCUBE_FILES_FILE_SYSTEM_ARN', 'BOTCUBE_FILES_SYNC_ROLE_ARN'];

/** Whether this deploy has Files: once any setting is, a missing one fails loud. */
export const filesConfigured = (env: NodeJS.ProcessEnv) => FILES_SETTINGS.some((name) => env[name]?.trim());

/**
 * The account Files of BOTCUBE_FILES_FILE_SYSTEM_ARN over BOTCUBE_FILES_BUCKET, synced with the
 * agent through BOTCUBE_FILES_SYNC_ROLE_ARN; 503 until the bucket and file system are both set.
 */
export function accountFilesFromEnv(env: NodeJS.ProcessEnv, records: () => FilesRecords): () => AccountFiles {
  let files: AccountFiles | undefined;
  return () => {
    const bucket = env.BOTCUBE_FILES_BUCKET?.trim();
    const fileSystemArn = env.BOTCUBE_FILES_FILE_SYSTEM_ARN?.trim();
    if (!bucket || !fileSystemArn) {
      throw new HttpError(503, 'Files are not configured: BOTCUBE_FILES_BUCKET and BOTCUBE_FILES_FILE_SYSTEM_ARN are required');
    }
    files ??= accountFiles({
      bucket,
      fileSystemArn,
      syncRoleArn: env.BOTCUBE_FILES_SYNC_ROLE_ARN?.trim() || undefined,
      records,
      pathStyle: Boolean(env.AWS_ENDPOINT_URL_S3),
    });
    return files;
  };
}

export function accountFiles({
  bucket,
  fileSystemArn,
  syncRoleArn,
  records,
  pathStyle,
  poll = ACCESS_POINT_POLL,
}: {
  bucket: string;
  fileSystemArn: string;
  /** The role whose sessions, narrowed to one account's directory, sync the agent's workspace. */
  syncRoleArn?: string | undefined;
  records: () => FilesRecords;
  /** Path-style S3 URLs, for a local S3 at AWS_ENDPOINT_URL_S3. */
  pathStyle: boolean;
  poll?: { intervalMs: number; attempts: number };
}): AccountFiles {
  // arn:aws:s3files:<region>:<account>:file-system/<id>
  const [, , , region = '', , resource = ''] = fileSystemArn.split(':');
  const fileSystemId = resource.split('/')[1] ?? '';
  const s3 = new S3Client({ region, forcePathStyle: pathStyle, requestChecksumCalculation: 'WHEN_REQUIRED' });
  const s3files = new S3FilesClient({ region });
  const sts = new STSClient({ region });

  async function createAccessPoint(accountId: string): Promise<string> {
    const directory = directoryOf(accountId);
    const created = await s3files.send(
      new CreateAccessPointCommand({
        fileSystemId,
        // The account's token: a retry, or a wake racing another, gets the same access point.
        clientToken: createHash('sha256').update(`files:${accountId}`).digest('hex'),
        posixUser: { uid: POSIX_ID, gid: POSIX_ID },
        rootDirectory: {
          path: `/${directory}`,
          creationPermissions: { ownerUid: POSIX_ID, ownerGid: POSIX_ID, permissions: '755' },
        },
      }),
    );
    const { accessPointArn, accessPointId } = created;
    if (!accessPointArn || !accessPointId) throw new Error('S3 Files CreateAccessPoint answered no access point');
    for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- polling: each look waits on the last
      const { status } = await s3files.send(new GetAccessPointCommand({ accessPointId }));
      if (status === 'available') return accessPointArn;
      if (status !== 'creating') throw new Error(`S3 Files access point ${accessPointId} is ${status}`);
      // eslint-disable-next-line no-await-in-loop -- polling
      await delay(poll.intervalMs);
    }
    throw new Error(`S3 Files access point ${accessPointId} is still creating`);
  }

  const key = (accountId: string, name: string) => `${directoryOf(accountId)}/${filePath(name)}`;

  /** Every object under the account's directory, directories S3 Files syncs (keys ending in `/`) included. */
  async function objects(accountId: string): Promise<_Object[]> {
    const found: _Object[] = [];
    let token: string | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- pagination: each page needs the last one's token
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: `${directoryOf(accountId)}/`, ContinuationToken: token }),
      );
      found.push(...(page.Contents ?? []));
      token = page.NextContinuationToken;
    } while (token);
    return found;
  }

  /** Every version and delete marker under a prefix: the bucket is versioned, as S3 Files needs. */
  async function versions(prefix: string): Promise<Version[]> {
    const found: Version[] = [];
    let marker: { KeyMarker?: string | undefined; VersionIdMarker?: string | undefined } = {};
    let truncated: boolean | undefined;
    do {
      // eslint-disable-next-line no-await-in-loop -- pagination: each page needs the last one's markers
      const page = await s3.send(
        new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, ...marker }),
      );
      found.push(
        ...(page.Versions ?? []).map((version) => ({ ...version, marker: false })),
        ...(page.DeleteMarkers ?? []).map((marker) => ({ ...marker, marker: true })),
      );
      marker = { KeyMarker: page.NextKeyMarker, VersionIdMarker: page.NextVersionIdMarker };
      truncated = page.IsTruncated;
    } while (truncated);
    return found;
  }

  /**
   * Delete the versions and delete markers in the account's directory: deleting a key alone leaves its
   * earlier versions. Earlier versions go before delete markers, and current files last, so a sweep cut
   * short never brings back an earlier version as current. With `moved`, a current file that is not
   * among those keys stays (it was written after a claim listed what to move); directories S3 Files keeps go.
   * The caller snapshots versions before copying, so replacements uploaded during the move are never swept.
   */
  async function sweep(found: Version[], moved?: ReadonlySet<string>): Promise<void> {
    const earlier = found.filter(({ marker, IsLatest }) => !marker && !IsLatest);
    const markers = found.filter(({ marker }) => marker);
    const swept = (key = '') => !moved || moved.has(key) || key.endsWith('/');
    const current = found.filter(({ marker, IsLatest, Key }) => !marker && IsLatest && swept(Key));
    for (const { Key, VersionId } of [...earlier, ...markers, ...current]) {
      // eslint-disable-next-line no-await-in-loop -- one version at a time, in order: a retry removes what is left
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key, VersionId }));
    }
  }

  /** Delete the account's access point, if it has one, and then its record. */
  async function removeAccessPoint(accountId: string): Promise<void> {
    const accessPointArn = await records().filesAccessPoint(accountId);
    if (accessPointArn === null) return;
    try {
      await s3files.send(new DeleteAccessPointCommand({ accessPointId: accessPointArn }));
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
      // Repair the retained record, while still reporting the observed deletion failure (ADR 0030).
      try {
        await records().deleteFilesAccessPoint(accountId);
      } catch (cleanupError) {
        throw Object.assign(new HttpError(503, 'Files access-point record cleanup failed'), {
          cause: new AggregateError([error, cleanupError], 'Files deletion and record cleanup failed'),
        });
      }
      throw Object.assign(new HttpError(404, 'Files access point not found'), { cause: error });
    }
    await records().deleteFilesAccessPoint(accountId);
  }

  /** Every version and delete marker of one file, with its current version; 404 when it has none. */
  async function fileVersions(accountId: string, name: string): Promise<{ found: Version[]; current: string }> {
    const fileKey = key(accountId, name);
    // The prefix also lists keys that merely start with this one, such as `report.csv.old`.
    const found = (await versions(fileKey)).filter(({ Key }) => Key === fileKey);
    const current = found.find(({ marker, IsLatest }) => !marker && IsLatest)?.VersionId;
    if (current === undefined) throw new HttpError(404, `No file ${name} in Files`);
    return { found, current };
  }

  /** Whether a key has a current version. */
  async function exists(objectKey: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
      return true;
    } catch (error) {
      if (error instanceof S3ServiceException && error.name === 'NotFound') return false;
      throw error;
    }
  }

  /** Compare bytes when a multipart source and its single-part copy have different ETags. */
  async function contentDigest(objectKey: string, version: string, etag: string): Promise<string> {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey, VersionId: version, IfMatch: etag }));
    if (Body === undefined) throw new Error(`S3 answered ${objectKey} without its body`);
    const reader = Body.transformToWebStream().getReader();
    const digest = createHash('sha256');
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- consume each chunk before reading the next, without buffering the file
      const chunk = await reader.read();
      if (chunk.done) return digest.digest('hex');
      digest.update(chunk.value);
    }
  }

  /** Recognize a collision copy by its exact source version and bytes, preserving independently named equal files. */
  async function collisionCopy(sourceKey: string, destination: string, held: Map<string, string | undefined>) {
    const original = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: sourceKey }));
    if (!original.VersionId || !original.ETag) throw new Error(`S3 answered ${sourceKey} without its version or ETag`);
    const receipt = createHash('sha256').update(JSON.stringify([sourceKey, original.VersionId])).digest('hex');
    let originalDigest: string | undefined;
    for (const name of held.keys()) {
      // eslint-disable-next-line no-await-in-loop -- verify one candidate copy's provenance and bytes at a time
      const copied = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: `${destination}/${name}` }));
      if (copied.Metadata?.['account-claim-source'] !== receipt) continue;
      if (copied.ETag === original.ETag) return null;
      if (!copied.VersionId || !copied.ETag) throw new Error(`S3 answered ${destination}/${name} without its version or ETag`);
      // eslint-disable-next-line no-await-in-loop -- pin and hash the source only once for its matching receipt candidates
      originalDigest ??= await contentDigest(sourceKey, original.VersionId, original.ETag);
      // eslint-disable-next-line no-await-in-loop -- verify a matching receipt's actual copied bytes before reusing it
      if (await contentDigest(`${destination}/${name}`, copied.VersionId, copied.ETag) === originalDigest) return null;
    }
    return { CopySource: `${bucket}/${sourceKey}`.split('/').map(encodeURIComponent).join('/') + `?versionId=${encodeURIComponent(original.VersionId)}`,
      MetadataDirective: 'REPLACE' as const, Metadata: { ...original.Metadata, 'account-claim-source': receipt },
      ContentType: original.ContentType, ContentDisposition: original.ContentDisposition, ContentEncoding: original.ContentEncoding,
      ContentLanguage: original.ContentLanguage, CacheControl: original.CacheControl, Expires: original.Expires, WebsiteRedirectLocation: original.WebsiteRedirectLocation };
  }

  return {
    async mount(accountId) {
      let accessPointArn = await records().filesAccessPoint(accountId);
      if (accessPointArn === null) {
        accessPointArn = await createAccessPoint(accountId);
        await records().saveFilesAccessPoint(accountId, accessPointArn);
      }
      return { accessPointArn, fileSystemArn, mountPath: FILES_MOUNT_PATH };
    },
    async transfer(sourceAccountId, destinationAccountId) {
      const [source, destination] = [directoryOf(sourceAccountId), directoryOf(destinationAccountId)];
      const named = (objects: _Object[], directory: string) =>
        new Map(objects.flatMap(({ Key, ETag }) => (Key && !Key.endsWith('/') ? [[Key.slice(directory.length + 1), ETag]] : [])));
      const found = await versions(`${source}/`);
      const held = named(await objects(destinationAccountId), destination);
      const taken = new Set(held.keys());
      const moving = named(await objects(sourceAccountId), source);
      for (const [name, etag] of moving) {
        // The same file already there was copied by an earlier attempt of this claim: only the original is left to go.
        if (!held.has(name) || held.get(name) !== etag) {
          // A different file the claimed account already has stays; the moved one takes a free name beside it.
          const sourceKey = `${source}/${name}`;
          let copied;
          if (held.has(name)) {
            // eslint-disable-next-line no-await-in-loop -- resolve the collision copy before allocating its name
            copied = await collisionCopy(sourceKey, destination, held);
            if (copied === null) continue;
          }
          const moved = freeName(name, taken);
          taken.add(moved);
          // eslint-disable-next-line no-await-in-loop -- one file at a time: a retried claim moves what is left
          await s3.send(
            new CopyObjectCommand({
              Bucket: bucket,
              Key: `${destination}/${moved}`,
              CopySource: `${bucket}/${source}/${name}`.split('/').map(encodeURIComponent).join('/'),
              ...copied,
            }),
          );
        }
      }
      // Every file has landed, so the originals go, earlier versions and all.
      await sweep(found, new Set([...moving.keys()].map((name) => `${source}/${name}`)));
      // The claimed account's Files are reached through the destination's access point from now on.
      await removeAccessPoint(sourceAccountId);
    },
    async delete(accountId) {
      await sweep(await versions(`${directoryOf(accountId)}/`));
      await removeAccessPoint(accountId);
    },
    async list(accountId) {
      const prefix = `${directoryOf(accountId)}/`;
      const entries: FileEntry[] = [];
      for (const { Key, Size, LastModified } of await objects(accountId)) {
        // A directory S3 Files syncs shows as a key ending in `/`; Files lists files.
        if (Key && !Key.endsWith('/')) {
          if (LastModified === undefined) throw new Error(`S3 listed ${Key} without its LastModified`);
          entries.push({ name: Key.slice(prefix.length), size: Size ?? 0, lastModified: LastModified.toISOString() });
        }
      }
      return entries;
    },
    async uploadUrl(accountId, name) {
      const fileKey = key(accountId, fileDestination(name));
      if (await exists(fileKey)) throw new HttpError(409, `A file named ${name} is already in Files`);
      return getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: fileKey, IfNoneMatch: '*' }), { expiresIn: URL_SECONDS });
    },
    async downloadUrl(accountId, name) {
      const fileKey = key(accountId, name);
      if (!(await exists(fileKey))) throw new HttpError(404, `No file ${name} in Files`);
      return getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: fileKey,
          ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(name.split('/').pop() ?? name)}`,
          // S3 holds the agent's files as binary/octet-stream, which no browser draws as an SVG image.
          ...(/\.svg$/i.test(name) && { ResponseContentType: 'image/svg+xml' }),
        }),
        { expiresIn: URL_SECONDS },
      );
    },
    async remove(accountId, name) {
      await sweep((await fileVersions(accountId, name)).found);
    },
    async rename(accountId, from, to) {
      const [fromKey, toKey] = [key(accountId, from), key(accountId, fileDestination(to))];
      const { found, current } = await fileVersions(accountId, from);
      const clash = new HttpError(409, `A file named ${to} is already in Files`);
      // The local S3 ignores a copy's If-None-Match, so the name is looked at first as well.
      if (await exists(toKey)) throw clash;
      try {
        await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: toKey,
            CopySource: `${bucket}/${fromKey}`.split('/').map(encodeURIComponent).join('/') + `?versionId=${encodeURIComponent(current)}`,
            // Never overwrite: S3 refuses the copy when `to` was written since it was looked at.
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        if (!(error instanceof S3ServiceException && error.name === 'PreconditionFailed')) throw error;
        throw Object.assign(clash, { cause: error });
      }
      // The versions listed before the copy: a version of `from` written since stays.
      await sweep(found);
    },
    async syncBinding(accountId) {
      if (syncRoleArn === undefined) {
        throw new HttpError(503, 'Files sync is not configured: BOTCUBE_FILES_SYNC_ROLE_ARN is required');
      }
      const directory = directoryOf(accountId);
      // The session policy narrows the sync role to this account's directory: the agent can reach no other account's Files.
      const policy = {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: `arn:aws:s3:::${bucket}/${directory}/*` },
          {
            Effect: 'Allow',
            Action: 's3:ListBucket',
            Resource: `arn:aws:s3:::${bucket}`,
            Condition: { StringLike: { 's3:prefix': `${directory}/*` } },
          },
        ],
      };
      const { Credentials: credentials } = await sts.send(
        new AssumeRoleCommand({
          RoleArn: syncRoleArn,
          RoleSessionName: `files-${directory.slice('accounts/'.length)}`,
          DurationSeconds: SYNC_SECONDS,
          Policy: JSON.stringify(policy),
        }),
      );
      const { AccessKeyId: accessKeyId, SecretAccessKey: secretAccessKey, SessionToken: sessionToken } = credentials ?? {};
      if (!accessKeyId || !secretAccessKey || !sessionToken) throw new Error('STS AssumeRole answered no credentials for Files');
      return { bucket, prefix: `${directory}/`, region, accessKeyId, secretAccessKey, sessionToken };
    },
  };
}
