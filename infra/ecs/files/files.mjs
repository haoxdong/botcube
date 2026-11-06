// Files over HTTPS straight from EFS: a signed link names one file of one account.
// No S3 and no Chat Service in the path, so links keep working while production is parked.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

/** Lambda's request cap is 6 MB, base64 included: the web UI uploads in chunks of at most this many bytes. */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * @typedef {{ op: 'get' | 'put', account: string, name: string, exp: number }} Claims
 * @typedef {{ size: number }} Stat
 * @typedef {{
 *   stat(file: string): Promise<Stat | null>,
 *   write(file: string, offset: number, body: Buffer): Promise<void>,
 *   finish(part: string, file: string, size: number, sha256: string): Promise<'created' | 'incomplete' | 'exists'>,
 * }} Disk
 */

/** @param {string} key @param {Omit<Claims, 'exp'>} claims @param {number} expiresAt epoch seconds */
export function sign(key, claims, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: expiresAt })).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

/** @param {string} key @param {string | undefined} token @param {number} now epoch ms @returns {Claims | null} */
export function verify(key, token, now) {
  const [payload, signature, extra] = (token ?? '').split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(createHmac('sha256', key).update(payload).digest('base64url'));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return claims.exp * 1000 > now ? claims : null;
}

/**
 * The file a link names, inside its account's directory, and where its upload collects: a hidden
 * folder the Files list skips, named by a digest so any file name fits. Null when the name climbs out.
 * @param {string} root @param {Claims} claims
 */
export function fileOf(root, claims) {
  if (!/^[0-9a-f]{8,128}$/.test(claims.account)) return null;
  const directory = path.join(root, claims.account);
  const file = path.resolve(directory, claims.name);
  if (!file.startsWith(`${directory}${path.sep}`)) return null;
  return { file, part: path.join(directory, '.uploads', createHash('sha256').update(claims.name).digest('hex')) };
}

/** @param {string | undefined} header @param {number} size @returns {{ start: number, end: number } | null | 'unsatisfiable'} */
export function rangeOf(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) return 'unsatisfiable';
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end ? { start, end } : 'unsatisfiable';
}

/** @typedef {{ status: number, text?: string, file?: string, start?: number, end?: number, size?: number, name?: string }} Answer */

const REFUSED = { status: 403, text: 'This link is not valid or has expired' };

/**
 * Decide what a request gets. A GET answers with the byte range to stream. A PUT writes one chunk at
 * `offset` into the upload's part file: chunk 0 first, which starts the file afresh, then the others in any order,
 * and the request with `done=<size>&sha256=<hex>` links it into place, never over an existing file, once its bytes hash to that
 * digest: a missing chunk leaves a hole of zeros that a size check alone would accept.
 * Every answer but a file carries text: a streamed Function URL response drops its status when the body is empty.
 * @param {{ key: string, root: string, disk: Disk, now: number }} deps
 * @param {{ method: string, query: Record<string, string | undefined>, range?: string, body: Buffer }} request
 * @returns {Promise<Answer>}
 */
export async function answer({ key, root, disk, now }, request) {
  const op = request.method === 'GET' ? 'get' : request.method === 'PUT' ? 'put' : null;
  if (op === null) return { status: 405, text: 'GET or PUT' };
  const claims = verify(key, request.query.t, now);
  const target = claims?.op === op ? fileOf(root, claims) : null;
  if (target === null) return REFUSED;
  return op === 'put' ? upload(disk, target, request) : download(disk, target.file, request.range);
}

/** @param {Disk} disk @param {{ file: string, part: string }} target @param {{ query: Record<string, string | undefined>, body: Buffer }} request @returns {Promise<Answer>} */
async function upload(disk, { file, part }, { query, body }) {
  const offset = Number(query.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % UPLOAD_CHUNK_BYTES !== 0) return { status: 400, text: 'offset must be a multiple of the chunk size' };
  if (body.length > UPLOAD_CHUNK_BYTES) return { status: 413, text: `chunks are at most ${UPLOAD_CHUNK_BYTES} bytes` };
  if (query.done === undefined) {
    await disk.write(part, offset, body);
    return { status: 200, text: 'ok' };
  }
  const size = Number(query.done);
  if (!Number.isSafeInteger(size) || size < 0) return { status: 400, text: 'done must be the file size' };
  const sha256 = query.sha256 ?? '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) return { status: 400, text: 'sha256 must be the hex digest of the whole file' };
  // An empty file has no chunk 0 of its own, so its finishing request starts it.
  if (body.length > 0 || size === 0) await disk.write(part, offset, body);
  // Files never overwrite: a name already taken stays as it is.
  return {
    created: { status: 201, text: 'created' },
    incomplete: { status: 409, text: 'The upload is incomplete' },
    exists: { status: 409, text: 'A file with this name is already in Files' },
  }[await disk.finish(part, file, size, sha256)];
}

/** @param {Disk} disk @param {string} file @param {string | undefined} header @returns {Promise<Answer>} */
async function download(disk, file, header) {
  const stat = await disk.stat(file);
  if (stat === null) return { status: 404, text: 'No such file' };
  const range = rangeOf(header, stat.size);
  if (range === 'unsatisfiable') return { status: 416, text: 'Range not satisfiable', size: stat.size };
  const { start, end } = range ?? { start: 0, end: stat.size - 1 };
  return { status: range ? 206 : 200, file, start, end, size: stat.size, name: path.basename(file) };
}
