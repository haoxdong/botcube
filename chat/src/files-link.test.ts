import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDocuments } from '../test/memory-documents.js';
import { AccountResources } from './account-resources.js';
import { AccountTree } from './account-tree.js';
import { HttpError } from './http-error.js';
import { computerFilesRoutes } from './computer-files-routes.js';
import { cors } from './cors.js';
import { accountFilesEfs } from './files-efs.js';
import { UPLOAD_CHUNK_BYTES } from './files-link.js';

const ORIGIN = 'https://api.example.test';
const UI_ORIGIN = 'https://ui.example.test';
const NOW = Date.UTC(2026, 10, 20, 5);
/** `printf acct_alice | shasum -a 256`, first 32 hex digits. */
const ALICE_DIRECTORY = 'dc44c294755b665b89960e445fe48d98';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'files-link-'));
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** The Chat Service's Files routes over one EFS root, the caller named by its `x-user` header. */
function chatService(workspace?: string) {
  const records = new AccountResources('chat', memoryDocuments());
  const files = accountFilesEfs({
    root, mountTargetIp: () => Promise.resolve('192.0.2.12'), fileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0abc',
    accessPoints: { create: async () => { throw new Error('unused'); }, delete: async () => false },
    mountCredentials: async () => { throw new Error('unused'); },
    records: () => records, linkKey: 'k'.repeat(64),
  });
  const app = new Hono();
  app.use(cors([UI_ORIGIN]));
  app.onError((error, c) => (error instanceof HttpError ? c.json({ detail: error.detail }, error.status as 400) : c.text('Internal Server Error', 500)));
  app.route('/', computerFilesRoutes({
    requester: async (c) => ({ owner: c.req.header('x-user') ?? '' }),
    history: { owns: async () => true },
    computers: { state: async () => { throw new Error('unused'); }, wake: async () => { throw new Error('unused'); } },
    files: () => files,
    workspace,
  }));
  return {
    linkFor: async (user: string, route: 'upload-url' | 'download-url', name: string, reply = false) => {
      const response = route === 'upload-url'
        ? await app.request(`${ORIGIN}/files/upload-url`, { method: 'POST', headers: { 'x-user': user, 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
        : await app.request(`${ORIGIN}/files/download-url?${new URLSearchParams(reply ? { name, reply: 'true' } : { name })}`, { headers: { 'x-user': user } });
      expect(response.status).toBe(200);
      return ((await response.json()) as { url: string }).url;
    },
    fetch: (url: string, init?: RequestInit) => app.request(url, init),
  };
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('a signed Files link the Chat Service serves', () => {
  it.each([
    ['/mnt/workspace', 'mnt/workspace'],
    ['/mnt/workspace/files', 'mnt/workspace/files'],
    ['/mnt/corporate/files', 'mnt/corporate/files'],
  ])('opens an answer link under the Harness workspace %s', async (workspace, prefix) => {
    const service = chatService(workspace);
    const dir = path.join(root, ALICE_DIRECTORY, 'charts');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'closing rates.svg'), 'chart bytes');

    const name = `${prefix}/charts/closing rates.svg`;
    const nested = path.join(root, ALICE_DIRECTORY, name);
    await mkdir(path.dirname(nested), { recursive: true });
    await writeFile(nested, 'nested file bytes');

    const download = await service.linkFor('acct_alice', 'download-url', name, true);
    const response = await service.fetch(download);
    expect([response.status, await response.text()]).toEqual([200, 'chart bytes']);
    const direct = await service.linkFor('acct_alice', 'download-url', name);
    expect(await (await service.fetch(direct)).text()).toBe('nested file bytes');
  });

  it('uploads in chunks as the web UI sends them, then downloads the file whole and by range', async () => {
    const service = chatService();
    const upload = await service.linkFor('acct_alice', 'upload-url', 'reports/q3.bin');
    expect(new URL(upload).origin).toBe(ORIGIN);
    expect(new URL(upload).pathname).toBe('/files/link');
    const content = Buffer.alloc(UPLOAD_CHUNK_BYTES + 10, 7);
    content.write('end', content.length - 3);
    const put = (query: string, body: Buffer) => service.fetch(`${upload}&${query}`, { method: 'PUT', body: new Uint8Array(body), headers: { 'content-type': 'application/octet-stream' } });

    expect((await put('offset=0', content.subarray(0, UPLOAD_CHUNK_BYTES))).status).toBe(200);
    const early = await put(`offset=${2 * UPLOAD_CHUNK_BYTES}&done=${content.length}&sha256=${sha256(content)}`, Buffer.alloc(0));
    expect([early.status, await early.text()]).toEqual([409, 'The upload is incomplete']);
    expect((await put(`offset=${UPLOAD_CHUNK_BYTES}`, content.subarray(UPLOAD_CHUNK_BYTES))).status).toBe(200);
    expect((await put(`offset=${2 * UPLOAD_CHUNK_BYTES}&done=${content.length}&sha256=${sha256(content)}`, Buffer.alloc(0))).status).toBe(201);
    expect((await readFile(path.join(root, ALICE_DIRECTORY, 'reports/q3.bin'))).equals(content)).toBe(true);

    const download = await service.linkFor('acct_alice', 'download-url', 'reports/q3.bin');
    const whole = await service.fetch(download);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''q3.bin");
    expect(Buffer.from(await whole.arrayBuffer()).equals(content)).toBe(true);
    const span = await service.fetch(download, { headers: { range: `bytes=${content.length - 3}-` } });
    expect([span.status, span.headers.get('content-range'), await span.text()]).toEqual([206, `bytes ${content.length - 3}-${content.length - 1}/${content.length}`, 'end']);
    expect((await service.fetch(download, { headers: { range: 'bytes=999999999-' } })).status).toBe(416);
  });

  it('lets the web UI on its own origin read the range and length of a download', async () => {
    const service = chatService();
    const upload = await service.linkFor('acct_alice', 'upload-url', 'a.txt');
    expect((await service.fetch(`${upload}&offset=0&done=5&sha256=${sha256(Buffer.from('hello'))}`, { method: 'PUT', body: 'hello' })).status).toBe(201);
    const span = await service.fetch(await service.linkFor('acct_alice', 'download-url', 'a.txt'), { headers: { origin: UI_ORIGIN, range: 'bytes=1-' } });
    expect([span.headers.get('access-control-allow-origin'), span.headers.get('access-control-expose-headers'), span.headers.get('content-length'), await span.text()])
      .toEqual([UI_ORIGIN, 'content-range, content-length', '4', 'ello']);
  });

  it('points at the origin the browser reached, https behind the load balancer', async () => {
    const service = chatService();
    const response = await service.fetch('http://api.example.test/files/upload-url', {
      method: 'POST', headers: { 'x-user': 'acct_alice', 'x-forwarded-proto': 'https', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a.txt' }),
    });
    expect(new URL(((await response.json()) as { url: string }).url).origin).toBe(ORIGIN);
  });

  it('is refused once it expires', async () => {
    const service = chatService();
    const upload = await service.linkFor('acct_alice', 'upload-url', 'a.txt');
    expect((await service.fetch(`${upload}&offset=0&done=1&sha256=${sha256(Buffer.from('a'))}`, { method: 'PUT', body: 'a' })).status).toBe(201);
    const download = await service.linkFor('acct_alice', 'download-url', 'a.txt');
    expect((await service.fetch(download)).status).toBe(200);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 301_000);
    const expired = await service.fetch(download);
    expect([expired.status, await expired.text()]).toEqual([403, 'This link is not valid or has expired']);
  });

  it("never reaches another User's file: not by asking, by forging the account, or by climbing out", async () => {
    const service = chatService();
    const upload = await service.linkFor('acct_alice', 'upload-url', 'secret.txt');
    expect((await service.fetch(`${upload}&offset=0&done=6&sha256=${sha256(Buffer.from('secret'))}`, { method: 'PUT', body: 'secret' })).status).toBe(201);
    const asked = await service.fetch(`${ORIGIN}/files/download-url?name=secret.txt`, { headers: { 'x-user': 'acct_bob' } });
    expect(asked.status).toBe(404);

    const bobs = new URL(await service.linkFor('acct_bob', 'upload-url', 'mine.txt'));
    const [payload = '', signature] = bobs.searchParams.get('t')?.split('.') ?? [];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), op: 'GET', accountDirectory: ALICE_DIRECTORY, name: 'secret.txt' })).toString('base64url');
    expect((await service.fetch(`${ORIGIN}/files/link?t=${forged}.${signature}`)).status).toBe(403);
    const climbing = Buffer.from(JSON.stringify({ op: 'GET', accountDirectory: ALICE_DIRECTORY, name: '../../x', expiresAtSeconds: NOW / 1000 + 300 })).toString('base64url');
    expect((await service.fetch(`${ORIGIN}/files/link?t=${climbing}.${signature}`)).status).toBe(403);
  });

  it('refuses a download link used to upload, an oversized chunk and a missing file', async () => {
    const service = chatService();
    const upload = await service.linkFor('acct_alice', 'upload-url', 'a.bin');
    expect((await service.fetch(`${upload}&offset=0`, { method: 'PUT', body: Buffer.alloc(UPLOAD_CHUNK_BYTES + 1) })).status).toBe(413);
    expect((await service.fetch(`${upload}&offset=0&done=1&sha256=${sha256(Buffer.from('a'))}`, { method: 'PUT', body: 'a' })).status).toBe(201);
    const download = await service.linkFor('acct_alice', 'download-url', 'a.bin');
    expect((await service.fetch(`${download}&offset=0`, { method: 'PUT', body: 'x' })).status).toBe(403);
    await rm(path.join(root, ALICE_DIRECTORY, 'a.bin'));
    expect((await service.fetch(download)).status).toBe(404);
  });
});

describe('a signed Files link never follows a symbolic link out of the account', () => {
  const content = (body: string) => ({ query: `offset=0&done=${body.length}&sha256=${sha256(Buffer.from(body))}`, body });
  const snapshot = async (folder: string) => Object.fromEntries(await Promise.all(
    (await readdir(folder, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
      .map(async (entry) => [path.relative(folder, path.join(entry.parentPath, entry.name)), await readFile(path.join(entry.parentPath, entry.name), 'utf8')]),
  ));
  /** Bob's folder, holding `theirs.txt`, and an outside folder: what a link out of Alice's folder could reach. */
  async function targets(service: ReturnType<typeof chatService>) {
    const theirs = content('theirs');
    expect((await service.fetch(`${await service.linkFor('acct_bob', 'upload-url', 'theirs.txt')}&${theirs.query}`, { method: 'PUT', body: theirs.body })).status).toBe(201);
    const bob = path.join(root, (await readdir(root)).find((name) => name !== ALICE_DIRECTORY) ?? '');
    const outside = await mkdtemp(path.join(tmpdir(), 'files-link-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    await mkdir(path.join(root, ALICE_DIRECTORY), { recursive: true });
    return { bob, outside };
  }

  it.each([
    ['the Chat Service environment', () => '/proc/self/environ'],
    ["another User's file", ({ bob }: { bob: string }) => path.join(bob, 'theirs.txt')],
    ['a file outside Files', ({ outside }: { outside: string }) => path.join(outside, 'secret.txt')],
  ])('refuses a download link to a symbolic link to %s, sending none of it', async (_, target) => {
    const service = chatService();
    const reachable = await targets(service);
    await symlink(target(reachable), path.join(root, ALICE_DIRECTORY, 'notes.txt'));
    const download = await service.fetch(await service.linkFor('acct_alice', 'download-url', 'notes.txt'));
    expect([download.status, await download.text()]).toEqual([403, 'This link is not valid or has expired']);
  });

  it.each([
    ['the upload folder', '.uploads', ({ bob }: { bob: string }) => bob],
    ['the upload part', `.uploads/${sha256(Buffer.from('a.txt'))}`, ({ bob }: { bob: string }) => path.join(bob, 'theirs.txt')],
  ])('writes nothing outside the account when %s is a symbolic link', async (_, linked, target) => {
    const service = chatService();
    const reachable = await targets(service);
    await mkdir(path.join(root, ALICE_DIRECTORY, '.uploads'), { recursive: true });
    await rm(path.join(root, ALICE_DIRECTORY, linked), { recursive: true, force: true });
    await symlink(target(reachable), path.join(root, ALICE_DIRECTORY, linked));
    const before = await snapshot(reachable.bob);
    const upload = await service.linkFor('acct_alice', 'upload-url', 'a.txt');
    const sent = content('mine');
    expect((await service.fetch(`${upload}&offset=0`, { method: 'PUT', body: sent.body })).status).toBe(403);
    expect((await service.fetch(`${upload}&${sent.query}`, { method: 'PUT', body: sent.body })).status).toBe(403);
    expect(await snapshot(reachable.bob)).toEqual(before);
  });

  // A FIFO would block an open with no other end; the open must not wait, or a few links hold every fs worker.
  it('refuses a FIFO in place of a file at once, for a download and an upload part', async () => {
    const service = chatService();
    await mkdir(path.join(root, ALICE_DIRECTORY, '.uploads'), { recursive: true });
    execFileSync('mkfifo', [path.join(root, ALICE_DIRECTORY, 'pipe.txt')]);
    execFileSync('mkfifo', [path.join(root, ALICE_DIRECTORY, '.uploads', sha256(Buffer.from('a.txt')))]);
    const download = await service.fetch(await service.linkFor('acct_alice', 'download-url', 'pipe.txt'));
    expect([download.status, await download.text()]).toEqual([403, 'This link is not valid or has expired']);
    const upload = await service.linkFor('acct_alice', 'upload-url', 'a.txt');
    expect((await service.fetch(`${upload}&offset=0`, { method: 'PUT', body: 'mine' })).status).toBe(403);
  }, 2000);

  it('refuses a symbolic link to a folder on the way to the file, for a download and an upload', async () => {
    const service = chatService();
    const { outside } = await targets(service);
    await symlink(outside, path.join(root, ALICE_DIRECTORY, 'reports'));
    const download = await service.fetch(await service.linkFor('acct_alice', 'download-url', 'reports/secret.txt'));
    expect([download.status, await download.text()]).toEqual([403, 'This link is not valid or has expired']);
    const sent = content('mine');
    const upload = await service.linkFor('acct_alice', 'upload-url', 'reports/mine.txt');
    expect((await service.fetch(`${upload}&${sent.query}`, { method: 'PUT', body: sent.body })).status).toBe(403);
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });

  describe('when the agent swaps a folder for a link after the walk passed', () => {
    /** Right after the last walk of `walked`, Alice's `reports` becomes a link to Bob's folder. */
    const swapAfterWalk = (walked: string, bob: string) => {
      const walk = AccountTree.prototype.refuseLink;
      let swapped = false;
      vi.spyOn(AccountTree.prototype, 'refuseLink').mockImplementation(async function (this: AccountTree, name: string) {
        await walk.call(this, name);
        if (swapped || name !== walked) return;
        swapped = true;
        await rename(path.join(root, ALICE_DIRECTORY, 'reports'), path.join(root, ALICE_DIRECTORY, 'reports.real'));
        await symlink(bob, path.join(root, ALICE_DIRECTORY, 'reports'));
      });
    };

    it("sends none of Bob's file through a download", async () => {
      const service = chatService();
      const { bob } = await targets(service);
      await mkdir(path.join(root, ALICE_DIRECTORY, 'reports'));
      // Alice's own file of the same name: the link is hers, and only the swap points it at Bob's.
      await writeFile(path.join(root, ALICE_DIRECTORY, 'reports', 'theirs.txt'), 'alice');
      const link = await service.linkFor('acct_alice', 'download-url', 'reports/theirs.txt');
      swapAfterWalk('reports/theirs.txt', bob);
      const download = await service.fetch(link);
      expect([download.status, await download.text()]).toEqual([403, 'This link is not valid or has expired']);
    });

    it("moves no upload into Bob's folder", async () => {
      const service = chatService();
      const { bob } = await targets(service);
      await mkdir(path.join(root, ALICE_DIRECTORY, 'reports'));
      const before = await snapshot(bob);
      const upload = await service.linkFor('acct_alice', 'upload-url', 'reports/mine.txt');
      const sent = content('mine');
      swapAfterWalk('reports/mine.txt', bob);
      expect((await service.fetch(`${upload}&${sent.query}`, { method: 'PUT', body: sent.body })).status).toBe(403);
      expect(await snapshot(bob)).toEqual(before);
    });
  });
});
