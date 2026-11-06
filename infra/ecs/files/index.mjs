// The Files Lambda: an EFS access point at /mnt/files, behind a streaming Function URL.
/* global awslambda */
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { link, mkdir, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { answer } from './files.mjs';

const ROOT = '/mnt/files';
const KEY = process.env.FILES_SIGNING_KEY ?? '';
if (KEY.length < 32) throw new Error('FILES_SIGNING_KEY must hold the Files link signing key');

/** @type {import('./files.mjs').Disk} */
const disk = {
  async stat(file) {
    try {
      const found = await stat(file);
      return found.isFile() ? { size: found.size } : null;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
      throw error;
    }
  },
  async write(file, offset, body) {
    await mkdir(path.dirname(file), { recursive: true });
    // Chunk 0 starts the upload afresh; later chunks may arrive in any order, so they create without truncating.
    const handle = await open(file, offset === 0 ? 'w' : constants.O_WRONLY | constants.O_CREAT);
    try {
      await handle.write(body, 0, body.length, offset);
    } finally {
      await handle.close();
    }
  },
  async finish(part, file, size, sha256) {
    const found = await disk.stat(part);
    if (found?.size !== size) return 'incomplete';
    const hash = createHash('sha256');
    await pipeline(createReadStream(part, { highWaterMark: 1 << 20 }), hash);
    if (hash.digest('hex') !== sha256) return 'incomplete';
    await mkdir(path.dirname(file), { recursive: true });
    try {
      // link, unlike rename, refuses a name that is taken.
      await link(part, file);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') return 'exists';
      throw error;
    }
    await unlink(part);
    return 'created';
  },
};

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  const result = await answer({ key: KEY, root: ROOT, disk, now: Date.now() }, {
    method: event.requestContext.http.method,
    query: event.queryStringParameters ?? {},
    range: event.headers?.range,
    body: Buffer.from(event.body ?? '', event.isBase64Encoded ? 'base64' : 'utf8'),
  });
  const headers = { 'cache-control': 'no-store' };
  if (result.file === undefined) {
    const out = awslambda.HttpResponseStream.from(stream, { statusCode: result.status, headers: { ...headers, 'content-type': 'text/plain' } });
    // A streamed response sends its status with the first write; `end(text)` alone answers 502.
    out.write(result.text ?? result.status.toString());
    out.end();
    return;
  }
  const { start = 0, end = -1, size = 0 } = result;
  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode: result.status,
    headers: {
      ...headers,
      'content-type': result.name?.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream',
      'content-length': String(end - start + 1),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.name ?? 'file')}`,
      'accept-ranges': 'bytes',
      ...(result.status === 206 && { 'content-range': `bytes ${start}-${end}/${size}` }),
    },
  });
  if (size === 0) {
    out.write('');
    out.end();
    return;
  }
  await pipeline(createReadStream(result.file, { start, end, highWaterMark: 1 << 20 }), out);
});
