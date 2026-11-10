// The Files Lambda: an EFS access point at /mnt/files, behind a streaming Function URL.
/* global awslambda */
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { answer } from './files.mjs';
import { disk } from './disk.mjs';

const ROOT = '/mnt/files';
const KEY = process.env.FILES_SIGNING_KEY ?? '';
if (KEY.length < 32) throw new Error('FILES_SIGNING_KEY must hold the Files link signing key');


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
