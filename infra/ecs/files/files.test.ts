import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { answer, fileOf, rangeOf, sign, UPLOAD_CHUNK_BYTES, verify, type Disk } from './files.mjs';

const KEY = 'k'.repeat(32);
const NOW = Date.UTC(2026, 10, 6);
const ACCOUNT = 'ab12cd34';
const link = (op: 'get' | 'put', name: string, secondsLeft = 300) => sign(KEY, { op, account: ACCOUNT, name }, NOW / 1000 + secondsLeft);

function memoryDisk() {
  const files = new Map<string, Buffer>();
  const disk: Disk = {
    async stat(file) { const found = files.get(file); return found ? { size: found.length } : null; },
    async write(file, offset, body) {
      const before = offset === 0 ? Buffer.alloc(0) : files.get(file) ?? Buffer.alloc(0);
      const next = Buffer.alloc(Math.max(before.length, offset + body.length));
      before.copy(next); body.copy(next, offset); files.set(file, next);
    },
    async finish(part, file, size, sha256) {
      const found = files.get(part);
      if (found?.length !== size || digest(found) !== sha256) return 'incomplete';
      if (files.has(file)) return 'exists';
      files.set(file, found); files.delete(part); return 'created';
    },
  };
  return { files, disk };
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const request = (method: string, query: Record<string, string>, body = Buffer.alloc(0), range?: string) => ({ method, query, body, ...(range && { range }) });

describe('signed links', () => {
  it('accept their own signature until they expire', () => {
    expect(verify(KEY, link('get', 'a.txt'), NOW)).toMatchObject({ op: 'get', account: ACCOUNT, name: 'a.txt' });
    expect(verify(KEY, link('get', 'a.txt', -1), NOW)).toBeNull();
  });

  it('refuse another key, a tampered payload and junk', () => {
    expect(verify('x'.repeat(32), link('get', 'a.txt'), NOW)).toBeNull();
    const [, signature] = link('get', 'a.txt').split('.');
    const forged = Buffer.from(JSON.stringify({ op: 'get', account: 'ffffffff', name: 'a.txt', exp: NOW / 1000 + 300 })).toString('base64url');
    expect(verify(KEY, `${forged}.${signature}`, NOW)).toBeNull();
    for (const junk of [undefined, '', 'abc', 'a.b.c']) expect(verify(KEY, junk, NOW)).toBeNull();
  });
});

describe('a link names one file inside its account', () => {
  it('resolves nested names and refuses climbing out or a malformed account', () => {
    expect(fileOf('/mnt/files', { op: 'get', account: ACCOUNT, name: 'reports/q3.pdf', exp: 0 })).toEqual({
      file: `/mnt/files/${ACCOUNT}/reports/q3.pdf`,
      // A hidden folder, which the Files list skips, collects the upload under a fixed-length name.
      part: expect.stringMatching(new RegExp(`^/mnt/files/${ACCOUNT}/\\.uploads/[0-9a-f]{64}$`)),
    });
    for (const name of ['../other/secret', '/etc/passwd', '.', '']) expect(fileOf('/mnt/files', { op: 'get', account: ACCOUNT, name, exp: 0 })).toBeNull();
    expect(fileOf('/mnt/files', { op: 'get', account: '../x', name: 'a', exp: 0 })).toBeNull();
  });
});

describe('ranges', () => {
  it('read a whole file, a span, an open end, and clamp past the end', () => {
    expect(rangeOf(undefined, 10)).toBeNull();
    expect(rangeOf('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(rangeOf('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
    expect(rangeOf('bytes=4-99', 10)).toEqual({ start: 4, end: 9 });
    expect(rangeOf('bytes=10-', 10)).toBe('unsatisfiable');
    expect(rangeOf('bytes=-5', 10)).toBe('unsatisfiable');
  });
});

describe('answer', () => {
  it('uploads in chunks, out of order after the first, and serves the whole file and a range', async () => {
    const { files, disk } = memoryDisk();
    const deps = { key: KEY, root: '/mnt/files', disk, now: NOW };
    const content = Buffer.alloc(UPLOAD_CHUNK_BYTES * 2 + 10, 7);
    content.write('end', content.length - 3);
    const put = link('put', 'big.bin');
    const sha256 = digest(content);
    expect(await answer(deps, request('PUT', { t: put, offset: '0' }, content.subarray(0, UPLOAD_CHUNK_BYTES)))).toEqual({ status: 200, text: 'ok' });
    expect(await answer(deps, request('PUT', { t: put, offset: String(UPLOAD_CHUNK_BYTES * 2), done: String(content.length), sha256 }, content.subarray(UPLOAD_CHUNK_BYTES * 2)))).toEqual({ status: 409, text: 'The upload is incomplete' });
    expect(await answer(deps, request('PUT', { t: put, offset: String(UPLOAD_CHUNK_BYTES) }, content.subarray(UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2)))).toEqual({ status: 200, text: 'ok' });
    expect(await answer(deps, request('PUT', { t: put, offset: String(content.length), done: String(content.length), sha256 }))).toEqual({ status: 400, text: 'offset must be a multiple of the chunk size' });
    expect(await answer(deps, request('PUT', { t: put, offset: String(UPLOAD_CHUNK_BYTES * 2), done: String(content.length), sha256: digest(Buffer.alloc(1)) }))).toEqual({ status: 409, text: 'The upload is incomplete' });
    expect(await answer(deps, request('PUT', { t: put, offset: String(UPLOAD_CHUNK_BYTES * 2), done: String(content.length), sha256 }))).toEqual({ status: 201, text: 'created' });
    expect(files.get(`/mnt/files/${ACCOUNT}/big.bin`)?.equals(content)).toBe(true);
    const get = link('get', 'big.bin');
    expect(await answer(deps, request('GET', { t: get }))).toMatchObject({ status: 200, start: 0, end: content.length - 1, name: 'big.bin' });
    expect(await answer(deps, request('GET', { t: get }, undefined, 'bytes=5-9'))).toMatchObject({ status: 206, start: 5, end: 9, size: content.length });
    expect(await answer(deps, request('GET', { t: get }, undefined, 'bytes=999999999-'))).toMatchObject({ status: 416 });
  });

  it('stores an empty file', async () => {
    const { files, disk } = memoryDisk();
    expect(await answer({ key: KEY, root: '/r', disk, now: NOW }, request('PUT', { t: link('put', 'empty.txt'), offset: '0', done: '0', sha256: digest(Buffer.alloc(0)) }))).toEqual({ status: 201, text: 'created' });
    expect(files.get(`/r/${ACCOUNT}/empty.txt`)?.length).toBe(0);
  });

  it('never overwrites a file already in Files', async () => {
    const { files, disk } = memoryDisk();
    files.set(`/r/${ACCOUNT}/taken.txt`, Buffer.from('mine'));
    const body = Buffer.from('theirs');
    expect(await answer({ key: KEY, root: '/r', disk, now: NOW }, request('PUT', { t: link('put', 'taken.txt'), offset: '0', done: String(body.length), sha256: digest(body) }, body)))
      .toEqual({ status: 409, text: 'A file with this name is already in Files' });
    expect(files.get(`/r/${ACCOUNT}/taken.txt`)?.toString()).toBe('mine');
  });

  it('refuses a download link used to upload, an oversized chunk, a missing file and other methods', async () => {
    const { disk } = memoryDisk();
    const deps = { key: KEY, root: '/r', disk, now: NOW };
    expect(await answer(deps, request('PUT', { t: link('get', 'a'), offset: '0' }))).toMatchObject({ status: 403 });
    expect(await answer(deps, request('PUT', { t: link('put', 'a'), offset: '0' }, Buffer.alloc(UPLOAD_CHUNK_BYTES + 1)))).toMatchObject({ status: 413 });
    expect(await answer(deps, request('GET', { t: link('get', 'missing') }))).toEqual({ status: 404, text: 'No such file' });
    expect(await answer(deps, request('PUT', { t: link('put', 'a'), offset: '0', done: '0', sha256: 'nope' }))).toMatchObject({ status: 400 });
    expect(await answer(deps, request('DELETE', { t: link('get', 'a') }))).toMatchObject({ status: 405 });
    expect(await answer(deps, request('GET', { t: link('get', '../escape') }))).toMatchObject({ status: 403 });
  });
});
