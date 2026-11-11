import { failureDetail } from './failure-detail';
import { HttpStatusError, uploadTo, type UploadOptions } from './files-upload';
import { attachmentAccountEpoch, FILE_ACCOUNT_LOCK, invalidateAttachmentAccount } from '../cartridge/file-account';
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

/** The account's Files. */
export async function listFiles(options: ChatServiceOptions): Promise<FileEntry[]> {
  return (await chatService('/files', { method: 'GET' }, 'Files request failed', options)).files as FileEntry[];
}

/** A short-lived URL that downloads one file. */
export async function fileDownloadUrl(name: string, options: ChatServiceOptions): Promise<string> {
  const path = `/files/download-url?${new URLSearchParams({ name })}`;
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

function uploadCopyName(name: string, copy: number): string {
  const dot = name.lastIndexOf('.');
  const extension = [...(dot > 0 ? name.slice(dot) : '')];
  const stem = [...(dot > 0 ? name.slice(0, dot) : name)];
  const encoder = new TextEncoder();
  while (extension.length > 0 && encoder.encode(`${stem[0] ?? ''} (${copy})${extension.join('')}`).length > 255) extension.pop();
  const suffix = ` (${copy})${extension.join('')}`;
  while (stem.length > 1 && encoder.encode(`${stem.join('')}${suffix}`).length > 255) stem.pop();
  return `${stem.join('')}${suffix}`;
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

