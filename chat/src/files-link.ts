import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { AccountTree } from './account-tree.js';
import { HttpError } from './http-error.js';

export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const LINK_PATH = '/files/link';

const LinkClaims = z.object({
  op: z.enum(['GET', 'PUT']),
  userId: z.string().min(1),
  name: z.string(),
  expiresAtSeconds: z.number(),
});
export type LinkClaims = z.infer<typeof LinkClaims>;

export type LinkRequest =
  | { method: 'GET'; query: Record<string, string | undefined>; range: string | undefined }
  | { method: 'PUT'; query: Record<string, string | undefined>; body: Buffer };

/** The path and query of a signed link: `/files/link?t=<payload>.<hmac>`. */
export function signFilesLink(key: string, claims: LinkClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${LINK_PATH}?t=${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

/** A link reaches only its account's Files, along a path with no symbolic link, so a link the agent planted there leads nowhere. */
export async function answerFilesLink({ key, directoryForUser }: {
  key: string;
  directoryForUser(userId: string): Promise<string>;
}, request: LinkRequest): Promise<Response> {
  const claims = verify(key, request.query.t);
  if (claims?.op !== request.method) return refused();
  try {
    const tree = await treeOf(await directoryForUser(claims.userId), request.method === 'PUT');
    if (tree === null) return text(404, 'No such file');
    const part = `.uploads/${createHash('sha256').update(claims.name).digest('hex')}`;
    return request.method === 'PUT' ? await upload(tree, { name: claims.name, part }, request.query, request.body) : await download(tree, claims.name, request.range);
  } catch (error) {
    if (error instanceof HttpError) return refused();
    throw error;
  }
}

function verify(key: string, token: string | undefined): LinkClaims | null {
  const [payload, signature, extra] = (token ?? '').split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(createHmac('sha256', key).update(payload).digest('base64url'));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const claims = LinkClaims.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
  return claims.success && claims.data.expiresAtSeconds * 1000 > Date.now() ? claims.data : null;
}

/** The account's Files; an upload makes the folder, a download finds none (null) before the first file. */
async function treeOf(directory: string, create: boolean): Promise<AccountTree | null> {
  if (create) await mkdir(directory, { recursive: true });
  const status = await lstat(directory).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (status === null) return null;
  if (!status.isDirectory()) throw new HttpError(400, 'Files directory is not a folder');
  return AccountTree.at(directory);
}

const LINK_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-expose-headers': 'content-range, content-length' };

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { ...LINK_HEADERS, 'content-type': 'text/plain' } });
}

const refused = () => text(403, 'This link is not valid or has expired');

async function upload(tree: AccountTree, { name, part }: { name: string; part: string }, query: LinkRequest['query'], body: Buffer): Promise<Response> {
  const offset = Number(query.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % UPLOAD_CHUNK_BYTES !== 0) return text(400, 'offset must be a multiple of the chunk size');
  if (query.done === undefined) {
    await write(tree, part, offset, body);
    return text(200, 'ok');
  }
  const size = Number(query.done);
  if (!Number.isSafeInteger(size) || size < 0) return text(400, 'done must be the file size');
  const sha256 = query.sha256 ?? '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) return text(400, 'sha256 must be the hex digest of the whole file');
  if (body.length > 0 || size === 0) await write(tree, part, offset, body);
  if (!await holds(tree, part, size, sha256)) return text(409, 'The upload is incomplete');
  return await tree.moveNoClobber(part, name) ? text(201, 'created') : text(409, 'A file with this name is already in Files');
}

async function download(tree: AccountTree, name: string, header: string | undefined): Promise<Response> {
  const file = await openIfFound(tree, name, constants.O_RDONLY);
  if (file === null) return text(404, 'No such file');
  const { size } = await file.stat();
  const range = header === undefined ? { start: 0, end: size - 1 } : rangeOf(header, size);
  if (range === null) {
    await file.close();
    return text(416, 'Range not satisfiable');
  }
  const length = range.end + 1 - range.start;
  const basename = path.posix.basename(name);
  const headers = new Headers({
    ...LINK_HEADERS,
    'content-type': basename.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream',
    'content-security-policy': "sandbox; default-src 'none'",
    'content-length': String(length),
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename)}`,
    'accept-ranges': 'bytes',
  });
  // The handle opened above is what streams: a link swapped in since then is never read.
  const body = length === 0 ? (await file.close(), null) : Readable.toWeb(file.createReadStream({ start: range.start, end: range.end })) as ReadableStream<Uint8Array>;
  if (header === undefined) return new Response(body, { status: 200, headers });
  headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
  return new Response(body, { status: 206, headers });
}

function rangeOf(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end ? { start, end } : null;
}

async function openIfFound(tree: AccountTree, name: string, flags: number): Promise<FileHandle | null> {
  return tree.open(name, flags).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
}

/** Whether the part holds exactly `size` bytes with digest `sha256`. */
async function holds(tree: AccountTree, part: string, size: number, sha256: string): Promise<boolean> {
  const file = await openIfFound(tree, part, constants.O_RDONLY);
  if (file === null) return false;
  try {
    if ((await file.stat()).size !== size) return false;
    const hash = createHash('sha256');
    await pipeline(file.createReadStream({ autoClose: false, highWaterMark: 1 << 20 }), hash);
    return hash.digest('hex') === sha256;
  } finally {
    await file.close();
  }
}

async function write(tree: AccountTree, part: string, offset: number, body: Buffer): Promise<void> {
  await tree.folders(path.posix.dirname(part));
  const file = await tree.open(part, constants.O_WRONLY | constants.O_CREAT | (offset === 0 ? constants.O_TRUNC : 0), 0o640);
  try {
    await file.write(body, 0, body.length, offset);
  } finally {
    await file.close();
  }
}

export function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
