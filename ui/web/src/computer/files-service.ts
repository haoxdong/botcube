import { failureDetail } from './failure-detail';
import { HttpStatusError, uploadTo, type UploadOptions } from './files-upload';
import { attachmentAccountEpoch, FILE_ACCOUNT_LOCK, invalidateAttachmentAccount } from '../plugin/file-account';
export type { UploadOptions } from './files-upload';

/** A file in the account's Files, by its path inside them. */
export interface FileEntry {
  name: string;
  size: number;
  lastModified: string;
}

interface ChatServiceOptions {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}

async function chatService(
  path: string,
  init: RequestInit,
  fallback: string,
  { chatServiceUrl, fetchImpl = fetch }: ChatServiceOptions,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(new URL(path, chatServiceUrl).toString(), { ...init, credentials: 'include' });
  if (!response.ok) throw new HttpStatusError(response.status, await failureDetail(response, fallback));
  if (response.status === 204) return {};
  return (await response.json()) as Record<string, unknown>;
}

/** A folder in the account's Files, by its path inside them with no trailing slash: an empty one has no file to show it. */
export interface FolderEntry {
  name: string;
  lastModified: string;
}

/** The account's Files, and their folders. */
export async function listFolders(options: ChatServiceOptions): Promise<{ files: FileEntry[]; folders: FolderEntry[] }> {
  const { files, folders } = await chatService('/files', { method: 'GET' }, 'Files request failed', options);
  return { files: files as FileEntry[], folders: (folders ?? []) as FolderEntry[] };
}

/** The account's Files. */
export async function listFiles(options: ChatServiceOptions): Promise<FileEntry[]> {
  return (await listFolders(options)).files;
}

/** A short-lived URL that downloads one file. */
export async function fileDownloadUrl(name: string, options: ChatServiceOptions & { reply?: boolean }): Promise<string> {
  const path = `/files/download-url?${new URLSearchParams(options.reply ? { name, reply: 'true' } : { name })}`;
  return (await chatService(path, { method: 'GET' }, 'Download failed', options)).url as string;
}

/** Delete a file from Files, every stored version of it. */
export async function deleteFile(name: string, options: ChatServiceOptions): Promise<void> {
  await chatService(`/files?${new URLSearchParams({ name })}`, { method: 'DELETE' }, 'Delete failed', options);
}

/** Give a file another path in Files; the Chat Service never overwrites one already there. */
export async function renameFile(from: string, to: string, options: ChatServiceOptions): Promise<void> {
  await chatService(
    '/files/rename',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, to }) },
    'Rename failed',
    options,
  );
}

const postJson = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Make a folder in Files; the Chat Service refuses a name Files already holds. */
export async function makeFolder(name: string, options: ChatServiceOptions): Promise<void> {
  await chatService('/files/folder', postJson({ name }), 'New folder failed', options);
}

/** Copy a file to another path in Files; the Chat Service never overwrites one already there. */
export async function copyFile(from: string, to: string, options: ChatServiceOptions): Promise<void> {
  await chatService('/files/copy', postJson({ from, to }), 'Copy failed', options);
}

/** A User's save of an Artifact edited in place: the edited files of the version they edited, by their path in the Source. */
export interface ArtifactSave {
  id: string;
  version: number;
  files: Record<string, string>;
}

/** Saves the User's edit as the Artifact's next version; the Chat Service refuses one over a newer version. */
export async function saveArtifact(save: ArtifactSave, options: ChatServiceOptions): Promise<Record<string, unknown>> {
  return chatService(
    '/files/artifact-save',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(save) },
    'Save failed',
    options,
  );
}

/** A presigned URL that uploads `name` as a new file; the Chat Service refuses a name Files already holds. */
async function newUploadUrl(name: string, signal: AbortSignal, service: ChatServiceOptions): Promise<string> {
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }), signal };
  return (await chatService('/files/upload-url', init, 'Upload failed', service)).url as string;
}

const pendingUploads = new Set<Promise<string>>();
let changingAccount = false;

export async function withUploadsSettled<T>(change: () => Promise<T>): Promise<T> {
  if (changingAccount) throw new Error('An account change is already in progress');
  changingAccount = true;
  try {
    await Promise.all([...pendingUploads]);
    return await navigator.locks.request(FILE_ACCOUNT_LOCK, async () => {
      invalidateAttachmentAccount();
      return await change();
    });
  } finally {
    changingAccount = false;
  }
}

/** The name of a file's copy, as a file manager gives it: `plan (2).txt`, within 255 bytes. */
export function uploadCopyName(name: string, copy: number): string {
  return suffixed(name, ` (${copy})`);
}

/** Windows' name for a copy pasted beside its file: `plan - Copy.txt`, then `plan - Copy (2).txt`, within 255 bytes. */
export function pastedCopyName(name: string, copy: number): string {
  return suffixed(name, copy === 1 ? ' - Copy' : ` - Copy (${copy})`);
}

/** A name with `suffix` before its extension, both cut to keep it within 255 bytes. */
function suffixed(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.');
  const extension = [...(dot > 0 ? name.slice(dot) : '')];
  const stem = [...(dot > 0 ? name.slice(0, dot) : name)];
  const encoder = new TextEncoder();
  while (extension.length > 0 && encoder.encode(`${stem[0] ?? ''}${suffix}${extension.join('')}`).length > 255) extension.pop();
  const end = `${suffix}${extension.join('')}`;
  while (stem.length > 1 && encoder.encode(`${stem.join('')}${end}`).length > 255) stem.pop();
  return `${stem.join('')}${end}`;
}

async function uploadAvailableFile(file: File, options: UploadOptions, service: ChatServiceOptions, copy = 1): Promise<string> {
  options.signal.throwIfAborted();
  const name = copy === 1 ? file.name : uploadCopyName(file.name, copy);
  let url: string;
  try {
    url = await newUploadUrl(name, options.signal, service);
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 409 && error.message === `A file named ${name} is already in Files`) {
      return uploadAvailableFile(file, options, service, copy + 1);
    }
    throw error;
  }
  options.signal.throwIfAborted();
  try {
    await uploadTo(url, file, options);
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 412) return uploadAvailableFile(file, options, service, copy + 1);
    throw error;
  }
  return `/${name}`;
}

export async function uploadFile(file: File, options: UploadOptions, service: ChatServiceOptions): Promise<string> {
  if (changingAccount) throw new Error('Uploads are paused while your account changes. Retry after sign-in.');
  const epoch = attachmentAccountEpoch();
  const pending = navigator.locks.request(FILE_ACCOUNT_LOCK, { mode: 'shared' }, async () => {
    if (epoch !== attachmentAccountEpoch()) throw new Error('Your account changed while this upload waited. Attach the file again.');
    return uploadAvailableFile(file, options, service);
  }).finally(() => pendingUploads.delete(pending));
  pendingUploads.add(pending);
  return pending;
}


/** How many names a move or copy into a folder tries before it gives up: the file's own, then its copies. */
const MOVE_TRIES = 100;

/**
 * Puts a file into a folder ('' for workspace) with `put`, under the first of its names (`nameAt(1)`, `nameAt(2)`, …)
 * the folder doesn't hold; resolves to the path it took.
 */
async function intoFolder(put: (to: string) => Promise<void>, folder: string, nameAt: (copy: number) => string, copy = 1): Promise<string> {
  const to = `${folder}${nameAt(copy)}`;
  try {
    await put(to);
    return to;
  } catch (error) {
    const taken = error instanceof HttpStatusError && error.status === 409 && error.message === `A file named ${to} is already in Files`;
    if (taken && copy < MOVE_TRIES) return intoFolder(put, folder, nameAt, copy + 1);
    throw error;
  }
}

/** A name, then its copy names (`plan (2).txt`). */
const orCopy = (name: string) => (copy: number) => (copy === 1 ? name : uploadCopyName(name, copy));

/**
 * Moves a file into a folder ('' for workspace) under `name`, its own name unless given, or the first copy name
 * (`plan (2).txt`) the folder doesn't hold; resolves to its new path.
 */
export async function moveIntoFolder(from: string, folder: string, service: ChatServiceOptions, name = from.slice(from.lastIndexOf('/') + 1)): Promise<string> {
  return intoFolder((to) => renameFile(from, to, service), folder, orCopy(name));
}

/**
 * Copies a file into a folder ('' for workspace) and resolves to the copy's path. Beside its file the copy takes
 * Windows' `plan - Copy.txt`; elsewhere its own name, or `plan (2).txt` where that is taken.
 */
export async function copyIntoFolder(from: string, folder: string, service: ChatServiceOptions): Promise<string> {
  const cut = from.lastIndexOf('/') + 1;
  const name = from.slice(cut);
  const nameAt = from.slice(0, cut) === folder ? (copy: number) => pastedCopyName(name, copy) : orCopy(name);
  return intoFolder((to) => copyFile(from, to, service), folder, nameAt);
}

/**
 * Uploads `file` into a folder of Files ('' for workspace) and resolves to its path there. The Chat Service takes
 * uploads at the top of workspace only, so the file is then moved down.
 */
export async function uploadInto(file: File, options: UploadOptions, folder: string, service: ChatServiceOptions): Promise<string> {
  const uploaded = (await uploadFile(file, options, service)).slice(1);
  if (folder === '') return uploaded;
  return moveIntoFolder(uploaded, folder, service, file.name).catch((error: unknown) => {
    throw new Error(`“${uploaded}” was uploaded to workspace: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  });
}
