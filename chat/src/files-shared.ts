import type { FilesCleanupClaim } from './files-cleanup-worker.js';
import { createHash } from 'node:crypto';
import type { ArtifactRestore, ArtifactSave, SavedArtifact } from './artifact-save.js';
import { HttpError } from './http-error.js';
import type { LinkRequest } from './files-link.js';

/** Where every Agent Computer browser mounts its account's Files; Chrome's download directory (deploy/agent-computer). */
export const FILES_MOUNT_PATH = '/mnt/files';
/** Where the Chat Service's task mounts every account's Files directory; the CDK mounts its volume here. */
export const FILES_EFS_ROOT = '/mnt/files-efs';
/** How long a Files upload or download URL stays valid. */
export const URL_SECONDS = 300;
/** The POSIX identity every file operation through an account's access point runs as. */
export const POSIX_ID = 1000;
/** How long the agent's Files credentials last: role chaining's ceiling, and the Runtime's longest microVM. */
export const MOUNT_SECONDS = 3600;
/** The User's Written Memory in their Files, which the agent loads when a Session starts (ADR 0095). */
export const WRITTEN_MEMORY = 'memories/AGENTS.md';
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

/** A folder in Files, by its path from the account's root; an empty one shows too. */
export interface FolderEntry {
  name: string;
  lastModified: string;
}

export interface FileListing {
  files: FileEntry[];
  folders: FolderEntry[];
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
  claimFilesPoolSlot(userId: string, accessPointArn: string, directory: string): Promise<boolean>;
  releaseFilesPoolSlot(userId: string, accessPointArn: string, directory: string): Promise<void>;
  filesPoolUsage(): Promise<number>;
  filesCleanupClaim(userId: string): Promise<FilesCleanupClaim | null>;
  claimFilesCleanup(userId: string, claim?: FilesCleanupClaim, previousToken?: string): Promise<boolean>;
  releaseFilesCleanup(userId: string, token?: string): Promise<void>;
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
  list(accountId: string): Promise<FileListing>;
  /** Make a folder, and its parents; 409 when anything is already at `name`. */
  makeFolder(accountId: string, name: string): Promise<void>;
  /** Copy a file without replacing anything at `to`. */
  copy(accountId: string, from: string, to: string): Promise<void>;
  /** A signed link's path and query on the Chat Service, which uploads `name` as a new file. */
  uploadUrl(accountId: string, name: string): Promise<string>;
  /** A signed link's path and query on the Chat Service, which downloads `name`. */
  downloadUrl(accountId: string, name: string): Promise<string>;
  /** Serve a request to a signed link: the link alone authorizes it. */
  link(request: LinkRequest): Promise<Response>;
  /** Delete a file; 404 when it is not there. */
  remove(accountId: string, name: string): Promise<void>;
  /** Rename a file or a folder without replacing anything at `to`. */
  rename(accountId: string, from: string, to: string): Promise<void>;
  /** A User's save of an Artifact edited in place: its Source and its next Artifact Version, authored by the User. */
  saveArtifact(accountId: string, save: ArtifactSave): Promise<SavedArtifact>;
  restoreArtifact(accountId: string, restore: ArtifactRestore): Promise<SavedArtifact>;
  /** The text of the account's Written Memory; empty before it has one. */
  writtenMemory(accountId: string): Promise<string>;
  /** Replaces the account's Written Memory with `content`, creating it if need be: the last save wins. */
  saveWrittenMemory(accountId: string, content: string): Promise<void>;
  mountBinding(accountId: string): Promise<FilesMountBinding>;
  /** Move every file into another account's Files for Account Claim, then retire the source access point. */
  transfer(sourceAccountId: string, destinationAccountId: string): Promise<void>;
  /** Delete the account's directory and retire its access point. */
  delete(accountId: string): Promise<void>;
}

/** The account's directory: a hash, so no account ID can name another's or escape the file system's layout. */
export const directoryOf = (accountId: string) =>
  createHash('sha256').update(accountId).digest('hex').slice(0, 32);

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
