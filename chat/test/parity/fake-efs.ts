import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { answer } from '../../../infra/ecs/files/files.mjs';
import { disk } from '../../../infra/ecs/files/disk.mjs';
import { filePath } from '../../src/files-shared.js';
import { HttpFake, sendJson, type RecordedRequest } from '../fakes/http-fake.js';

const FILE_SYSTEM_ID = 'fs-0123456789abcdef0';
const FILE_SYSTEM_ARN = `arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/${FILE_SYSTEM_ID}`;
const creation = z.object({
  FileSystemId: z.literal(FILE_SYSTEM_ID), ClientToken: z.string(),
  PosixUser: z.object({ Uid: z.literal(1000), Gid: z.literal(1000) }),
  RootDirectory: z.object({ Path: z.string().regex(/^\/accounts\/[a-f0-9]{32}$/), CreationInfo: z.object({ OwnerUid: z.literal(1000), OwnerGid: z.literal(1000), Permissions: z.literal('750') }) }),
});
type AccessPoint = z.infer<typeof creation> & { AccessPointArn: string; AccessPointId: string; LifeCycleState: 'available' };

export class FakeEfs extends HttpFake {
  readonly key = 'files-parity-signing-key-'.repeat(3);
  readonly fileSystemArn = FILE_SYSTEM_ARN;
  readonly fileSystemId = FILE_SYSTEM_ID;
  denyDeletes = false;
  private nextId = 0;
  private readonly points = new Map<string, AccessPoint>();
  private readonly mounted = new Map<string, string>();

  constructor(readonly root: string) {
    super((request, response) => this.handle(request, response));
  }

  get environment(): NodeJS.ProcessEnv {
    return {
      BOTCUBE_FILES_EFS_ARN: FILE_SYSTEM_ARN, BOTCUBE_FILES_EFS_ROOT: this.root,
      BOTCUBE_FILES_LINKS_URL: this.url, BOTCUBE_FILES_SIGNING_KEY: this.key,
      BOTCUBE_FILES_MOUNT_ROLE_ARN: 'arn:aws:iam::123456789012:role/files-mount',
      BOTCUBE_FILES_MOUNT_TARGET_IP: '192.0.2.12', AWS_ENDPOINT_URL_EFS: this.url,
    };
  }

  rootDirectory(arn: string): string | undefined {
    const id = arn.split('/').pop() ?? '';
    const directory = this.points.get(id)?.RootDirectory.Path ?? this.mounted.get(id);
    if (directory !== undefined) this.mounted.set(id, directory);
    return directory;
  }

  private directory(arn: string): string {
    const directory = this.rootDirectory(arn);
    if (directory === undefined) throw new Error(`No access point ${arn}`);
    return directory.slice('/accounts/'.length);
  }

  async write(arn: string, name: string, body: string): Promise<void> {
    await this.put(`accounts/${this.directory(arn)}/${filePath(name)}`, body);
  }

  async read(arn: string, name: string): Promise<string> {
    return readFile(path.join(this.root, this.directory(arn), filePath(name)), 'utf8');
  }

  async list(arn: string): Promise<string[]> {
    const prefix = `accounts/${this.directory(arn)}/`;
    return (await this.keys(prefix)).map((key) => key.slice(prefix.length));
  }

  async put(key: string, body: string): Promise<void> {
    if (!key.startsWith('accounts/')) throw new Error('Files must stay under accounts');
    const file = path.join(this.root, filePath(key.slice('accounts/'.length)));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async keys(prefix = 'accounts/'): Promise<string[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => `accounts/${path.relative(this.root, path.join(entry.parentPath, entry.name))}`).filter((key) => key.startsWith(prefix)).sort();
  }

  private async handle(request: RecordedRequest, response: ServerResponse): Promise<void> {
    const url = new URL(request.path, 'http://files.test');
    if (url.pathname.startsWith('/2015-02-01/access-points')) {
      this.accessPoint(request, response, url);
      return;
    }
    const result = await answer({ key: this.key, root: this.root, disk, now: Date.now() }, {
      method: request.method, query: Object.fromEntries(url.searchParams), ...(request.headers.range ? { range: request.headers.range } : {}), body: request.bodyBytes,
    });
    if (result.file === undefined) {
      response.writeHead(result.status, { 'content-type': 'text/plain' });
      response.end(result.text ?? String(result.status));
      return;
    }
    const data = await readFile(result.file);
    const start = result.start ?? 0;
    const end = result.end ?? -1;
    response.writeHead(result.status, {
      'content-length': String(end - start + 1), 'content-type': 'application/octet-stream',
      ...(result.status === 206 ? { 'content-range': `bytes ${start}-${end}/${result.size}` } : {}),
    });
    response.end(data.subarray(start, end + 1));
  }

  private accessPoint(request: RecordedRequest, response: ServerResponse, url: URL): void {
    if (request.method === 'POST') {
      const parsed = creation.safeParse(JSON.parse(request.body));
      if (!parsed.success) { sendJson(response, 400, { code: 'ValidationException' }); return; }
      const previous = [...this.points.values()].find((point) => point.ClientToken === parsed.data.ClientToken);
      const id = previous?.AccessPointId ?? `fsap-${(++this.nextId).toString(16).padStart(17, '0')}`;
      const point: AccessPoint = previous ?? { ...parsed.data, AccessPointId: id, AccessPointArn: `arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/${id}`, LifeCycleState: 'available' };
      this.points.set(id, point);
      sendJson(response, 200, point);
      return;
    }
    const id = request.method === 'DELETE' ? url.pathname.split('/').pop() ?? '' : url.searchParams.get('AccessPointId') ?? '';
    const point = this.points.get(id);
    if (point === undefined) { sendJson(response, 404, { code: 'AccessPointNotFound' }); return; }
    if (request.method === 'DELETE') {
      if (this.denyDeletes) { sendJson(response, 403, { code: 'AccessDeniedException' }); return; }
      this.points.delete(id);
      sendJson(response, 200, {});
      return;
    }
    sendJson(response, 200, { AccessPoints: [point] });
  }
}
