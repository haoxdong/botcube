import type { ServerResponse } from 'node:http';
import { HttpFake, sendJson, type RecordedRequest } from '../fakes/http-fake.js';
import type { MotoS3 } from './moto-s3.js';

const FILE_SYSTEM_ID = 'fs-0123456789abcdef0';
export const FILE_SYSTEM_ARN = `arn:aws:s3files:us-east-1:123456789012:file-system/${FILE_SYSTEM_ID}`;

interface AccessPoint {
  accessPointId: string;
  accessPointArn: string;
  clientToken: string;
  rootDirectory: string;
}

/**
 * The S3 Files control plane for one file system over a bucket, and the file
 * system itself: a file written through an access point lands in the bucket
 * under the access point's root directory, as S3 Files syncs it.
 */
export class FakeS3Files extends HttpFake {
  private readonly accessPoints = new Map<string, AccessPoint>();

  constructor(
    private readonly s3: MotoS3,
    readonly bucket: string,
  ) {
    super((request, response) => this.handle(request, response));
  }

  /** The root directory an access point confines its clients to. */
  rootDirectory(accessPointArn: string): string | undefined {
    return [...this.accessPoints.values()].find((point) => point.accessPointArn === accessPointArn)?.rootDirectory;
  }

  /** Write a file at a path inside an access point, as a client that mounted it does. */
  async write(accessPointArn: string, path: string, body: string): Promise<void> {
    await this.s3.putObject(this.bucket, this.key(accessPointArn, path), body);
  }

  /** Read a file at a path inside an access point, as a client that mounted it does. */
  read(accessPointArn: string, path: string): Promise<string> {
    return this.s3.getObject(this.bucket, this.key(accessPointArn, path));
  }

  /** The files a client that mounted an access point sees, as paths inside it. */
  async list(accessPointArn: string): Promise<string[]> {
    const root = this.key(accessPointArn, '');
    return (await this.s3.keys(this.bucket, root)).map((key) => key.slice(root.length));
  }

  private key(accessPointArn: string, path: string): string {
    const root = this.rootDirectory(accessPointArn);
    if (root === undefined) throw new Error(`No access point ${accessPointArn}`);
    return `${root.replace(/^\//, '')}/${path}`;
  }

  private handle(request: RecordedRequest, response: ServerResponse): void {
    const { pathname } = new URL(request.path, 'http://fake');
    const get = /^\/access-points\/([^/]+)$/.exec(pathname);
    if (request.method === 'PUT' && pathname === '/access-points') {
      this.create(request, response);
    } else if (request.method === 'GET' && get) {
      const point = this.accessPoints.get(decodeURIComponent(get[1] ?? ''));
      if (point === undefined) sendJson(response, 404, { message: 'AccessPointNotFound' });
      else sendJson(response, 200, this.describe(point, 'available'));
    } else if (request.method === 'DELETE' && get) {
      // DeleteAccessPoint takes the access point's ID or its ARN.
      const named = decodeURIComponent(get[1] ?? '');
      const point = [...this.accessPoints.values()].find(({ accessPointId, accessPointArn }) => named === accessPointId || named === accessPointArn);
      if (point === undefined) sendJson(response, 404, { message: 'AccessPointNotFound' });
      else {
        this.accessPoints.delete(point.accessPointId);
        sendJson(response, 200, {});
      }
    } else {
      sendJson(response, 404, { message: `fake S3 Files has no route ${request.method} ${pathname}` });
    }
  }

  private create(request: RecordedRequest, response: ServerResponse): void {
    const body = JSON.parse(request.body) as {
      fileSystemId?: unknown;
      clientToken?: unknown;
      posixUser?: { uid?: unknown; gid?: unknown };
      rootDirectory?: { path?: unknown; creationPermissions?: { ownerUid?: unknown; ownerGid?: unknown; permissions?: unknown } };
    };
    const path = body.rootDirectory?.path;
    const permissions = body.rootDirectory?.creationPermissions;
    if (
      body.fileSystemId !== FILE_SYSTEM_ID ||
      typeof body.clientToken !== 'string' ||
      typeof body.posixUser?.uid !== 'number' ||
      typeof body.posixUser.gid !== 'number' ||
      typeof path !== 'string' ||
      !/^(\/[^/$#<>;`|&?{}^*\n.][^/$#<>;`|&?{}^*\n]*){1,4}$/.test(path) ||
      path.length > 100 ||
      // Without creation permissions S3 Files never creates the root, and every mount fails.
      typeof permissions?.ownerUid !== 'number' ||
      typeof permissions.ownerGid !== 'number' ||
      typeof permissions.permissions !== 'string'
    ) {
      sendJson(response, 400, { message: 'ValidationException' });
      return;
    }
    const retried = [...this.accessPoints.values()].find((point) => point.clientToken === body.clientToken);
    const accessPointId = retried?.accessPointId ?? `fsap-${String(this.accessPoints.size + 1).padStart(17, '0')}`;
    const point = retried ?? {
      accessPointId,
      accessPointArn: `${FILE_SYSTEM_ARN}/access-point/${accessPointId}`,
      clientToken: body.clientToken,
      rootDirectory: path,
    };
    this.accessPoints.set(accessPointId, point);
    sendJson(response, 200, this.describe(point, 'creating'));
  }

  private describe(point: AccessPoint, status: string) {
    return {
      accessPointId: point.accessPointId,
      accessPointArn: point.accessPointArn,
      fileSystemId: FILE_SYSTEM_ID,
      clientToken: point.clientToken,
      rootDirectory: { path: point.rootDirectory },
      status,
    };
  }
}
