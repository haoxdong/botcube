export class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface UploadOptions {
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}

/** Lambda's request cap is 6 MB with base64 included: a Files link takes uploads in chunks of this many bytes. */
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const PARALLEL_CHUNKS = 4;

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * PUTs `file` to a Files link served straight from EFS: chunk 0 first, the rest four at a time, then
 * one request naming the size and SHA-256, which the link checks before the file appears. A name taken
 * meanwhile makes the caller try the next copy name.
 */
export async function uploadTo(url: string, file: File, { onProgress, signal }: UploadOptions): Promise<void> {
  const sha256 = hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  let sent = 0;
  const send = async (offset: number, body: Blob, finish = '') => {
    const response = await fetch(`${url}&offset=${offset}${finish}`, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' }, signal });
    if (!response.ok) {
      const detail = await response.text();
      throw new HttpStatusError(response.status === 409 && detail.includes('already in Files') ? 412 : response.status, `Upload failed: ${response.status}`);
    }
    sent += body.size;
    onProgress(file.size === 0 ? 1 : sent / file.size);
  };
  const offsets = Array.from({ length: Math.ceil(file.size / UPLOAD_CHUNK_BYTES) }, (_, index) => index * UPLOAD_CHUNK_BYTES);
  const chunk = (offset: number) => file.slice(offset, offset + UPLOAD_CHUNK_BYTES);
  const [first, ...rest] = offsets;
  if (first !== undefined) await send(first, chunk(first));
  await Promise.all(Array.from({ length: PARALLEL_CHUNKS }, async () => {
    for (let offset = rest.shift(); offset !== undefined; offset = rest.shift()) {
      // eslint-disable-next-line no-await-in-loop -- each worker sends one chunk at a time
      await send(offset, chunk(offset));
    }
  }));
  await send(offsets.length * UPLOAD_CHUNK_BYTES, new Blob([]), `&done=${file.size}&sha256=${sha256}`);
}
