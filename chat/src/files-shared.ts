import { createHash } from 'node:crypto';
import { HttpError } from './cartridge.js';

/** Where every Agent Computer browser mounts its account's Files; Chrome's download directory (deploy/agent-computer). */
export const FILES_MOUNT_PATH = '/mnt/files';
/** How long a Files upload or download URL stays valid. */
export const URL_SECONDS = 300;
/** The POSIX identity every file operation through an account's access point runs as. */
export const POSIX_ID = 1000;
/** How long the agent's Files credentials last: role chaining's ceiling, and the Runtime's longest microVM. */
export const MOUNT_SECONDS = 3600;
export const RETIREMENT_GRACE_MS = 24 * 60 * 60 * 1000;
/** An EFS access point a browser Session mounts, as StartBrowserSession takes it. */
export interface FilesMount {
  accessPointArn: string;
  fileSystemArn: string;
  mountPath: string;
}

export interface FileEntry {
  name: string;
  size: number;
  lastModified: string;
}

/** What a Runtime session needs to mount its account's access point itself, and nothing more. */
export interface FilesMountBinding {
  fileSystemId: string;
  mountTargetIp: string;
  accessPointId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

/** Where an account's Files access point is kept once created. */
export interface FilesRecords {
  filesRetirement(accountId: string): Promise<{ destinationAccountId: string | null; lastCredentialExpiresAt: number } | null>;
  retireFiles(accountId: string, destinationAccountId: string | null, notBefore: number): Promise<void>;
  scheduleFilesCleanup(accountId: string, notBefore: number, lastCredentialExpiresAt: number): Promise<void>;
  completeFilesCleanup(accountId: string, lastCredentialExpiresAt: number): Promise<void>;
  filesAccountActive(accountId: string): Promise<boolean>;
  pendingFilesCleanup(): Promise<string[]>;
  filesAccessPoint(accountId: string): Promise<string | null>;
  saveFilesAccessPoint(accountId: string, accessPointArn: string): Promise<void>;
  deleteFilesAccessPoint(accountId: string): Promise<void>;
}

/** An account's Files: one directory of the EFS file system, reached through its own access point. */
export interface AccountFiles {
  /** Periodically clean retired directories, including uploads admitted before credentials expired. */
  recoverCleanup(): Promise<void>;
  /** The account's access point, created on first use, mounted at FILES_MOUNT_PATH. */
  mount(accountId: string): Promise<FilesMount>;
  list(accountId: string): Promise<FileEntry[]>;
  uploadUrl(accountId: string, name: string): Promise<string>;
  downloadUrl(accountId: string, name: string): Promise<string>;
  /** Delete a file; 404 when it is not there. */
  remove(accountId: string, name: string): Promise<void>;
  /** Rename a file without replacing another file. */
  rename(accountId: string, from: string, to: string): Promise<void>;
  mountBinding(accountId: string): Promise<FilesMountBinding>;
  /** Move every file into another account's Files for Account Claim, then retire the source access point. */
  transfer(sourceAccountId: string, destinationAccountId: string): Promise<void>;
  /** Delete the account's directory and retire its access point. */
  delete(accountId: string): Promise<void>;
}

/** The account's directory: a hash, so no account ID can name another's or escape the file system's layout. */
export const directoryOf = (accountId: string) =>
  `accounts/${createHash('sha256').update(accountId).digest('hex').slice(0, 32)}`;

/** `name`, or the first of `report (1).csv`, `report (2).csv`, ... that is not taken. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const base = name.lastIndexOf('/') + 1;
  const dot = name.lastIndexOf('.');
  const stem = dot > base ? dot : name.length;
  let copy = 1;
  while (taken.has(`${name.slice(0, stem)} (${copy})${name.slice(stem)}`)) copy += 1;
  return `${name.slice(0, stem)} (${copy})${name.slice(stem)}`;
}

/** A path inside the account's directory; a segment that is empty, `.` or `..` would leave it. */
export function filePath(name: string): string {
  const segments = name.split('/');
  if (!name || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new HttpError(400, 'name must be a path inside Files');
  }
  return name;
}

export const HIDDEN = /(^|\/)\.(?!\.?\/)[^/]*\//;

export function fileDestination(name: string): string {
  if (name.split('/').some((segment) => Buffer.byteLength(segment, 'utf8') > 255)) {
    throw new HttpError(400, 'Each file name in Files must be at most 255 UTF-8 bytes');
  }
  if (HIDDEN.test(name)) throw new HttpError(400, 'A folder in Files cannot start with a dot');
  return name;
}
