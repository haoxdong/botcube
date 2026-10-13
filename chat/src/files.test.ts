import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpError } from './index.js';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDocuments } from '../test/memory-documents.js';
import { AccountResources } from './account-resources.js';
import { accountFiles, accountFilesFromEnv, filesConfigured } from './files.js';

const ACCOUNT = 'acct_0123456789';
/** `printf acct_0123456789 | shasum -a 256`, first 32 hex digits. */
const DIRECTORY = 'accounts/8300e9d12ce55ca979c3e7e01a8f7fac';
const FILE_SYSTEM_ARN = 'arn:aws:s3files:eu-west-1:123456789012:file-system/fs-0123';
const ACCESS_POINT_ARN = `${FILE_SYSTEM_ARN}/access-point/fsap-1`;

interface Recorded {
  method: string;
  url: string;
  body: string;
  headers: import('node:http').IncomingHttpHeaders;
}

/** One local endpoint for S3 and S3 Files, answering from `answer` and recording every request. */
async function aws(answer: (request: Recorded) => { status?: number; type?: string; headers?: Record<string, string>; body: string }) {
  const requests: Recorded[] = [];
  const server: Server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const request = { method: incoming.method ?? '', url: incoming.url ?? '', body: Buffer.concat(chunks).toString(), headers: incoming.headers };
    requests.push(request);
    const { status = 200, type = 'application/json', headers = {}, body } = answer(request);
    response.writeHead(status, { 'content-type': type, ...headers });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv('AWS_ENDPOINT_URL_S3', endpoint);
  vi.stubEnv('AWS_ENDPOINT_URL_S3FILES', endpoint);
  vi.stubEnv('AWS_ENDPOINT_URL_STS', endpoint);
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { requests, endpoint };
}
const closers: (() => Promise<void>)[] = [];

const memoryRecords = () => new AccountResources('chat', memoryDocuments());

const accessPoint = (status: string, extra: object = {}) =>
  JSON.stringify({ accessPointId: 'fsap-1', accessPointArn: ACCESS_POINT_ARN, status, ...extra });

const SYNC_ROLE_ARN = 'arn:aws:iam::123456789012:role/files-sync';

const files = (records = memoryRecords(), attempts = 3, syncRoleArn: string | null = SYNC_ROLE_ARN) =>
  accountFiles({
    bucket: 'files-bucket',
    fileSystemArn: FILE_SYSTEM_ARN,
    syncRoleArn: syncRoleArn ?? undefined,
    records: () => records,
    pathStyle: true,
    poll: { intervalMs: 1, attempts },
  });

beforeEach(() => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("an account's Files mount", () => {
  it("creates the account's access point, rooted in its own directory, and waits until it is available", async () => {
    let looks = 0;
    const { requests } = await aws(({ method }) => {
      if (method === 'PUT') return { body: accessPoint('creating') };
      looks += 1;
      return { body: accessPoint(looks < 2 ? 'creating' : 'available') };
    });
    const records = memoryRecords();

    expect(await files(records).mount(ACCOUNT)).toEqual({
      accessPointArn: ACCESS_POINT_ARN,
      fileSystemArn: FILE_SYSTEM_ARN,
      mountPath: '/mnt/files',
    });

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'PUT /access-points',
      'GET /access-points/fsap-1',
      'GET /access-points/fsap-1',
    ]);
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual({
      fileSystemId: 'fs-0123',
      clientToken: '60dca47aabb1ce55f93c49d5b7ef52bdc2e58bd0bc89636f3416c93bf348403a',
      posixUser: { uid: 1000, gid: 1000 },
      rootDirectory: {
        path: `/${DIRECTORY}`,
        creationPermissions: { ownerUid: 1000, ownerGid: 1000, permissions: '755' },
      },
    });
    expect(await records.filesAccessPoint(ACCOUNT)).toBe(ACCESS_POINT_ARN);
    expect(await records.filesAccessPoint('acct_other')).toBeNull();
  });

  it('mounts the access point it already has without creating another', async () => {
    const { requests } = await aws(() => ({ body: '{}' }));
    const records = memoryRecords();
    await records.saveFilesAccessPoint(ACCOUNT, ACCESS_POINT_ARN);

    expect((await files(records).mount(ACCOUNT)).accessPointArn).toBe(ACCESS_POINT_ARN);
    expect(requests).toEqual([]);
  });

  it('fails loud on an access point in error, and keeps no record of it', async () => {
    await aws(({ method }) => ({ body: accessPoint(method === 'PUT' ? 'creating' : 'error') }));
    const records = memoryRecords();

    await expect(files(records).mount(ACCOUNT)).rejects.toThrow('S3 Files access point fsap-1 is error');
    expect(await records.filesAccessPoint(ACCOUNT)).toBeNull();
  });

  it('fails loud on one that never becomes available, looking only its number of attempts', async () => {
    let looks = 0;
    // A look past the attempts finds the access point broken, so polling longer fails differently.
    await aws(({ method }) => ({ body: method === 'PUT' ? accessPoint('creating') : accessPoint((looks += 1) > 3 ? 'error' : 'creating') }));

    const records = memoryRecords();

    await expect(files(records, 3).mount(ACCOUNT)).rejects.toThrow('S3 Files access point fsap-1 is still creating');
    expect(looks).toBe(3);
    expect(await records.filesAccessPoint(ACCOUNT)).toBeNull();
  });

  it('fails loud when S3 Files answers no access point', async () => {
    await aws(() => ({ body: JSON.stringify({ accessPointId: 'fsap-1', status: 'creating' }) }));

    await expect(files().mount(ACCOUNT)).rejects.toThrow('S3 Files CreateAccessPoint answered no access point');
  });
});

/** A ListObjectsV2 page; each object's ETag is its key, or what follows `#` in it. */
const listing = (keys: string[], next?: string) => ({
  type: 'application/xml',
  body: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>files-bucket</Name><IsTruncated>${next !== undefined}</IsTruncated>${keys
    .map((entry) => {
      const [key = entry, etag = entry] = entry.split('#');
      return `<Contents><Key>${key}</Key><ETag>"${etag}"</ETag><Size>${key.length}</Size><LastModified>2026-10-01T12:00:00.000Z</LastModified></Contents>`;
    })
    .join('')}${next === undefined ? '' : `<NextContinuationToken>${next}</NextContinuationToken>`}</ListBucketResult>`,
});

describe("an account's Files listing", () => {
  it("lists every page of the account's directory, as paths inside it, leaving out directories", async () => {
    const { requests } = await aws(({ url }) =>
      new URL(url, 'http://s3').searchParams.get('continuation-token') === 'page-2'
        ? listing([`${DIRECTORY}/notes/plan.txt`])
        : listing([`${DIRECTORY}/`, `${DIRECTORY}/report.csv`, `${DIRECTORY}/notes/`], 'page-2'),
    );

    expect(await files().list(ACCOUNT)).toEqual([
      { name: 'report.csv', size: `${DIRECTORY}/report.csv`.length, lastModified: '2026-10-01T12:00:00.000Z' },
      { name: 'notes/plan.txt', size: `${DIRECTORY}/notes/plan.txt`.length, lastModified: '2026-10-01T12:00:00.000Z' },
    ]);
    const queries = requests.map(({ url }) => new URL(url, 'http://s3'));
    expect(queries.map(({ pathname }) => pathname)).toEqual(['/files-bucket/', '/files-bucket/']);
    expect(queries.map(({ searchParams }) => searchParams.get('prefix'))).toEqual([`${DIRECTORY}/`, `${DIRECTORY}/`]);
    expect(queries.map(({ searchParams }) => searchParams.get('continuation-token'))).toEqual([null, 'page-2']);
  });

  it('fails loud on a listed file S3 answers without its last-modified time', async () => {
    await aws(() => ({
      type: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>files-bucket</Name><IsTruncated>false</IsTruncated><Contents><Key>${DIRECTORY}/report.csv</Key><Size>3</Size></Contents></ListBucketResult>`,
    }));

    await expect(files().list(ACCOUNT)).rejects.toThrow(`S3 listed ${DIRECTORY}/report.csv without its LastModified`);
  });
});

describe("an account's Files transfers", () => {
  it.each(['abcdefghi-'.repeat(30) + '.svg', 'a'.repeat(256), 'é'.repeat(128), '😀'.repeat(64), `${'a'.repeat(256)}/report.svg`].flatMap((name) => (['upload', 'rename'] as const).map((operation) => [name, operation] as const)))('refuses an over-long Files destination %j on %s before writing', async (name, operation) => {
    const { requests } = await aws(() => ({ body: '{}' }));
    const account = files();
    const result = operation === 'upload' ? account.uploadUrl(ACCOUNT, name) : account.rename(ACCOUNT, 'report.svg', name);

    await expect(result).rejects.toBeInstanceOf(HttpError);
    await expect(result).rejects.toMatchObject({ status: 400, detail: 'Each file name in Files must be at most 255 UTF-8 bytes' });
    expect(requests).toEqual([]);
  });

  it.each(['a'.repeat(255), 'é'.repeat(127) + 'a', '😀'.repeat(63) + 'abc', `${'a'.repeat(255)}/${'b'.repeat(255)}`])('accepts bounded Files path components %j', async (name) => {
    await aws(({ method }) => method === 'HEAD'
      ? { status: 404, type: 'application/xml', body: '<Error><Code>NotFound</Code></Error>' }
      : method === 'GET' ? versionListing([`${DIRECTORY}/report.svg@v1*`], []) : { type: 'application/xml', body: '<CopyObjectResult></CopyObjectResult>' });
    const account = files();

    expect(decodeURIComponent(new URL(await account.uploadUrl(ACCOUNT, name)).pathname)).toBe(`/files-bucket/${DIRECTORY}/${name}`);
    await expect(account.rename(ACCOUNT, 'report.svg', name)).resolves.toBeUndefined();
  });

  it('lets an existing over-long file be renamed to recover Files', async () => {
    const name = 'abcdefghi-'.repeat(30) + '.svg';
    const { requests } = await aws(({ method }) => method === 'HEAD'
      ? { status: 404, type: 'application/xml', body: '<Error><Code>NotFound</Code></Error>' }
      : method === 'GET' ? versionListing([`${DIRECTORY}/${name}@v1*`], []) : { type: 'application/xml', body: '<CopyObjectResult></CopyObjectResult>' });

    await files().rename(ACCOUNT, name, 'recovered.svg');

    expect(requests.filter(({ method }) => method === 'PUT').map(({ url }) => new URL(url, 'http://s3').pathname)).toEqual([`/files-bucket/${DIRECTORY}/recovered.svg`]);
    expect(requests.filter(({ method }) => method === 'DELETE').map(({ url }) => new URL(url, 'http://s3').searchParams.get('versionId'))).toEqual(['v1']);
  });

  it('refuses an upload name already in Files with a classified conflict', async () => {
    await aws(() => ({ body: '{}' }));

    await expect(files().uploadUrl(ACCOUNT, 'notes/plan.txt')).rejects.toMatchObject({
      status: 409,
      message: 'A file named notes/plan.txt is already in Files',
    });
  });

  it('fails loud when storage refuses the upload existence check', async () => {
    await aws(() => ({ status: 403, body: '' }));

    await expect(files().uploadUrl(ACCOUNT, 'notes/plan.txt')).rejects.toMatchObject({
      name: 'Unknown',
      $metadata: { httpStatusCode: 403 },
    });
  });

  it('presigns an upload into the account directory, valid for five minutes', async () => {
    const { endpoint } = await aws(() => ({ status: 404, body: '' }));

    const url = new URL(await files().uploadUrl(ACCOUNT, 'notes/plan.txt'));

    expect(`${url.origin}${url.pathname}`).toBe(`${endpoint}/files-bucket/${DIRECTORY}/notes/plan.txt`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('x-id')).toBe('PutObject');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host;if-none-match');
    // A checksum of no body would refuse the browser's upload.
    expect([...url.searchParams.keys()].filter((name) => /checksum/i.test(name))).toEqual([]);
  });

  it('presigns a download of a file in the account directory, saved under its own name', async () => {
    const { endpoint } = await aws(() => ({ body: '{}' }));

    const url = new URL(await files().downloadUrl(ACCOUNT, 'notes/plan v2.txt'));

    expect(`${url.origin}${url.pathname}`).toBe(`${endpoint}/files-bucket/${DIRECTORY}/notes/plan%20v2.txt`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-disposition')).toBe("attachment; filename*=UTF-8''plan%20v2.txt");
  });

  it.each([{}, { 'x-amz-delete-marker': 'true' }])('rejects missing or deleted downloads with 404', async (headers) => {
    await aws(() => ({ status: 404, headers, body: '' }));

    await expect(files().downloadUrl(ACCOUNT, 'notes/missing.txt')).rejects.toMatchObject({
      status: 404, detail: 'No file notes/missing.txt in Files',
    });
  });

  it('propagates unexpected download storage errors', async () => {
    await aws(() => ({ status: 403, body: '' }));

    await expect(files().downloadUrl(ACCOUNT, 'notes/private.txt')).rejects.toMatchObject({
      $metadata: { httpStatusCode: 403 },
    });
  });

  //: S3 holds the agent's files as binary/octet-stream, which no browser draws as an SVG image.
  it('presigns an SVG download served as an SVG image, so a reply can show it', async () => {
    await aws(() => ({ body: '{}' }));

    const url = new URL(await files().downloadUrl(ACCOUNT, 'charts/spx closes.svg'));

    expect(url.searchParams.get('response-content-type')).toBe('image/svg+xml');
    expect(new URL(await files().downloadUrl(ACCOUNT, 'notes/plan.txt')).searchParams.get('response-content-type')).toBeNull();
  });

  it.each(['', '../x', 'a/../x', './x', '/x', 'x/', 'a//b'])('refuses %j, which is no path inside Files', async (name) => {
    await aws(() => ({ body: '{}' }));

    await expect(files().downloadUrl(ACCOUNT, name)).rejects.toThrow(new HttpError(400, 'name must be a path inside Files'));
    await expect(files().uploadUrl(ACCOUNT, name)).rejects.toThrow(new HttpError(400, 'name must be a path inside Files'));
  });
});

describe("an account's Files on Account Claim", () => {
  /** `printf acct_claimed | shasum -a 256`, first 32 hex digits. */
  const CLAIMED = 'accounts/f1590d7fa6da354f358131408df5eefc';
  /** Each write as `METHOD path`, with `@version` when it names one. */
  const writes = (requests: { method: string; url: string }[]) =>
    requests
      .filter(({ method }) => method !== 'GET')
      .map(({ method, url }) => {
        const parsed = new URL(url, 'http://s3');
        const version = parsed.searchParams.get('versionId');
        return `${method} ${decodeURIComponent(parsed.pathname)}${version === null ? '' : `@${version}`}`;
      });

  it('preserves a replacement uploaded after its original was copied during Account Claim', async () => {
    let copied = false;
    const stored = new Set(['original']);
    const { requests } = await aws(({ method, url }) => {
      if (method === 'PUT') {
        copied = true;
        stored.add('replacement');
        return { type: 'application/xml', body: '<CopyObjectResult></CopyObjectResult>' };
      }
      const query = new URL(url, 'http://s3').searchParams;
      if (method === 'DELETE') {
        stored.delete(query.get('versionId') ?? '');
        return { body: '{}' };
      }
      if (query.has('versions')) {
        return versionListing(copied
          ? [`${DIRECTORY}/report.csv@replacement*`, `${DIRECTORY}/report.csv@original`]
          : [`${DIRECTORY}/report.csv@original*`], []);
      }
      return query.get('prefix') === `${CLAIMED}/` ? listing([]) : listing([`${DIRECTORY}/report.csv`]);
    });

    await files().transfer(ACCOUNT, 'acct_claimed');

    expect(copied).toBe(true);
    expect([...stored]).toEqual(['replacement']);
    expect(writes(requests)).toContain(`DELETE /files-bucket/${DIRECTORY}/report.csv@original`);
    expect(writes(requests)).not.toContain(`DELETE /files-bucket/${DIRECTORY}/report.csv@replacement`);
  });

  it('keeps a destination upload made during the source-version snapshot', async () => {
    let uploaded = false;
    const { requests } = await aws(({ method, url }) => {
      if (method === 'HEAD') return { body: '', headers: { 'x-amz-version-id': 'v1', etag: '"source"' } };
      if (method !== 'GET') return { type: 'application/xml', body: '<CopyObjectResult></CopyObjectResult>' };
      const query = new URL(url, 'http://s3').searchParams;
      if (query.has('versions')) {
        uploaded = true;
        return versionListing([`${DIRECTORY}/report.csv@original*`], []);
      }
      return query.get('prefix') === `${CLAIMED}/`
        ? listing(uploaded ? [`${CLAIMED}/report.csv#destination-upload`] : [])
        : listing([`${DIRECTORY}/report.csv#source-original`]);
    });

    await files().transfer(ACCOUNT, 'acct_claimed');

    expect(uploaded).toBe(true);
    expect(writes(requests)).toContain(`PUT /files-bucket/${CLAIMED}/report (1).csv`);
    expect(writes(requests)).not.toContain(`PUT /files-bucket/${CLAIMED}/report.csv`);
    expect(writes(requests)).toContain(`DELETE /files-bucket/${DIRECTORY}/report.csv@original`);
  });

  it.each(['versions', 'copy'])('deletes nothing when the %s request fails during Account Claim', async (failed) => {
    const { requests } = await aws(({ method, url }) => {
      const query = new URL(url, 'http://s3').searchParams;
      if ((failed === 'versions' && query.has('versions')) || (failed === 'copy' && method === 'PUT')) {
        return { status: 400, type: 'application/xml', body: '<Error><Code>InvalidRequest</Code><Message>synthetic transfer failure</Message></Error>' };
      }
      if (query.has('versions')) return versionListing([`${DIRECTORY}/report.csv@original*`], []);
      return query.get('prefix') === `${CLAIMED}/` ? listing([]) : listing([`${DIRECTORY}/report.csv`]);
    });

    await expect(files().transfer(ACCOUNT, 'acct_claimed')).rejects.toThrow('synthetic transfer failure');

    expect(requests.some(({ method }) => method === 'DELETE')).toBe(false);
    if (failed === 'versions') expect(requests.some(({ method }) => method === 'PUT')).toBe(false);
  });

  it("moves every file into the claimed account's directory, then every version of it out of the anonymous one, and drops its access point", async () => {
    const { requests } = await aws(({ method, url }) => {
      if (method !== 'GET') return { type: 'application/xml', body: '<CopyObjectResult></CopyObjectResult>' };
      const query = new URL(url, 'http://s3').searchParams;
      if (query.has('versions')) {
        return versionListing(
          [`${DIRECTORY}/@d1*`, `${DIRECTORY}/report.csv@v2*`, `${DIRECTORY}/report.csv@v1`, `${DIRECTORY}/notes/plan v2.txt@v1*`, `${DIRECTORY}/late.txt@l1*`],
          [`${DIRECTORY}/old.txt@m1*`],
        );
      }
      return query.get('prefix') === `${CLAIMED}/`
        ? listing([])
        : listing([`${DIRECTORY}/`, `${DIRECTORY}/report.csv`, `${DIRECTORY}/notes/plan v2.txt`]);
    });
    const records = memoryRecords();
    await records.saveFilesAccessPoint(ACCOUNT, ACCESS_POINT_ARN);

    await files(records).transfer(ACCOUNT, 'acct_claimed');

    expect(writes(requests)).toEqual([
      `PUT /files-bucket/${CLAIMED}/report.csv`,
      `PUT /files-bucket/${CLAIMED}/notes/plan v2.txt`,
      // A file written after the listing was not moved, so it stays.
      `DELETE /files-bucket/${DIRECTORY}/report.csv@v1`,
      `DELETE /files-bucket/${DIRECTORY}/old.txt@m1`,
      `DELETE /files-bucket/${DIRECTORY}/@d1`,
      `DELETE /files-bucket/${DIRECTORY}/report.csv@v2`,
      `DELETE /files-bucket/${DIRECTORY}/notes/plan v2.txt@v1`,
      `DELETE /access-points/${ACCESS_POINT_ARN}`,
    ]);
    expect(await records.filesAccessPoint(ACCOUNT)).toBeNull();
  });

  it('moves the files of an account that never mounted them, deleting no access point', async () => {
    const { requests } = await aws(({ url }) =>
      new URL(url, 'http://s3').searchParams.has('versions') ? versionListing([], []) : listing([]),
    );

    await files().transfer(ACCOUNT, 'acct_claimed');

    expect(requests.map(({ method }) => method)).toEqual(['GET', 'GET', 'GET']);
  });

  it("keeps the claimed account's own files, moving a same-named one in beside them", async () => {
    const { requests } = await aws(({ method, url }) => {
      if (method === 'HEAD') return { body: '', headers: { 'x-amz-version-id': 'v1', etag: '"source"' } };
      if (method !== 'GET') return { type: 'application/xml', body: '<CopyObjectResult></CopyObjectResult>' };
      const query = new URL(url, 'http://s3').searchParams;
      if (query.has('versions')) return versionListing(['report.csv', 'report (2).csv', 'README', 'notes.v2/plan', '.env'].map((name) => `${DIRECTORY}/${name}@v1*`), []);
      return query.get('prefix') === `${CLAIMED}/`
        ? listing([`${CLAIMED}/report.csv`, `${CLAIMED}/report (1).csv`, `${CLAIMED}/README`, `${CLAIMED}/.env`])
        : listing([`${DIRECTORY}/report.csv`, `${DIRECTORY}/report (2).csv`, `${DIRECTORY}/README`, `${DIRECTORY}/notes.v2/plan`, `${DIRECTORY}/.env`]);
    });

    await files().transfer(ACCOUNT, 'acct_claimed');

    expect(
      requests.filter(({ method }) => method === 'PUT').map(({ url }) => decodeURIComponent(new URL(url, 'http://s3').pathname)),
    ).toEqual([
      `/files-bucket/${CLAIMED}/report (2).csv`,
      `/files-bucket/${CLAIMED}/report (2) (1).csv`,
      `/files-bucket/${CLAIMED}/README (1)`,
      `/files-bucket/${CLAIMED}/notes.v2/plan`,
      `/files-bucket/${CLAIMED}/.env (1)`,
    ]);
  });

  it.each(['source', 'destination'])('fails loud when collision %s metadata cannot be read, without deleting files', async (failed) => {
    const { requests } = await aws(({ method, url }) => {
      const parsed = new URL(url, 'http://s3');
      if (method === 'HEAD') {
        const source = parsed.pathname.includes(DIRECTORY);
        return source === (failed === 'source') ? { status: 403, body: '' } : { body: '', headers: { 'x-amz-version-id': 'v1', etag: '"source"' } };
      }
      if (parsed.searchParams.has('versions')) return versionListing([`${DIRECTORY}/report.csv@v1*`], []);
      return parsed.searchParams.get('prefix') === `${CLAIMED}/`
        ? listing([`${CLAIMED}/report.csv#different`]) : listing([`${DIRECTORY}/report.csv#source`]);
    });
    await expect(files().transfer(ACCOUNT, 'acct_claimed')).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    expect(requests.some(({ method }) => method === 'PUT' || method === 'DELETE')).toBe(false);
  });

  it.each(['retry', 'multipart retry', 'multipart replaced copy', 'multipart source read failure', 'multipart copy read failure', 'same-byte destination', 'changed source version', 'replaced copy', 'source replaced after snapshot'] as const)('keeps collision copies distinct and retries idempotently: %s', async (scenario) => {
    const claimed = 'accounts/f1590d7fa6da354f358131408df5eefc';
    const destination = new Map([['report.csv', 'other']]);
    const receipts = new Map<string, string>();
    const multipart = scenario.startsWith('multipart');
    const replaced = scenario.endsWith('replaced copy');
    const extraCopy = ['same-byte destination', 'changed source version', 'replaced copy', 'multipart replaced copy'].includes(scenario);
    const repeatedCopy = scenario === 'changed source version' || replaced;
    const refusedDirectory = new Map([
      ['multipart source read failure', DIRECTORY],
      ['multipart copy read failure', claimed],
    ]).get(scenario);
    if (scenario === 'same-byte destination') destination.set('report (1).csv', 'source');
    let version = 'v1';
    let failDeletion = true;
    const metadata = (name: string) => {
      return { body: '', headers: receipts.has(name) ? { 'x-amz-meta-account-claim-source': receipts.get(name) ?? '', 'x-amz-version-id': 'copy-v1', etag: destination.get(name) === 'replacement' ? '"replacement"' : '"source"' } : { 'x-amz-meta-purpose': 'research', 'content-type': 'text/csv', 'cache-control': 'private', etag: multipart ? '"source-2"' : '"source"', 'x-amz-version-id': scenario === 'source replaced after snapshot' ? 'v2' : version } };
    };
    const { requests } = await aws(({ method, url, headers }) => {
      const parsed = new URL(url, 'http://s3');
      if (method === 'PUT') {
        const name = decodeURIComponent(parsed.pathname).slice(`/files-bucket/${claimed}/`.length);
        destination.set(name, 'source');
        receipts.set(name, String(headers['x-amz-meta-account-claim-source']));
        return { type: 'application/xml', body: '<CopyObjectResult></CopyObjectResult>' };
      }
      if (method === 'HEAD') {
        const name = decodeURIComponent(parsed.pathname).split('/').pop() ?? '';
        return metadata(name);
      }
      if (method === 'DELETE' && failDeletion) {
        failDeletion = false;
        return { status: 400, type: 'application/xml', body: '<Error><Code>InvalidRequest</Code><Message>source deletion failed</Message></Error>' };
      }
      if (method === 'DELETE') return { body: '{}' };
      if (parsed.searchParams.has('versionId')) {
        if (parsed.pathname.startsWith(`/files-bucket/${refusedDirectory}/`)) {
          return { status: 403, type: 'application/xml', body: '<Error><Code>AccessDenied</Code><Message>copy verification refused</Message></Error>' };
        }
        const name = decodeURIComponent(parsed.pathname).split('/').pop() ?? '';
        return { body: parsed.pathname.startsWith(`/files-bucket/${DIRECTORY}/`) ? 'source' : destination.get(name) ?? '' };
      }
      if (parsed.searchParams.has('versions')) return versionListing([`${DIRECTORY}/report.csv@${version}*`], []);
      return parsed.searchParams.get('prefix') === `${claimed}/`
        ? listing([...destination].map(([name, etag]) => `${claimed}/${name}#${etag}`))
        : listing([`${DIRECTORY}/report.csv#source`]);
    });
    const heldFiles = files();
    await expect(heldFiles.transfer(ACCOUNT, 'acct_claimed')).rejects.toThrow('source deletion failed');
    if (scenario === 'changed source version') version = 'v2';
    if (replaced) destination.set('report (1).csv', 'replacement');
    if (scenario.endsWith('read failure')) {
      await expect(heldFiles.transfer(ACCOUNT, 'acct_claimed')).rejects.toThrow('copy verification refused');
      expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);
      expect(requests.filter(({ method }) => method === 'DELETE')).toHaveLength(1);
      return;
    }
    await heldFiles.transfer(ACCOUNT, 'acct_claimed');
    if (scenario === 'multipart retry') {
      const reads = requests.filter(({ method, url }) => method === 'GET' && new URL(url, 'http://s3').searchParams.has('versionId'));
      expect(reads.map(({ url }) => new URL(url, 'http://s3').searchParams.get('versionId'))).toEqual(['v1', 'copy-v1']);
      expect(reads.map(({ headers }) => headers['if-match'])).toEqual(['"source-2"', '"source"']);
    }
    const expected = [['report.csv', 'other'], ['report (1).csv', replaced ? 'replacement' : 'source']];
    if (extraCopy) expected.push(['report (2).csv', 'source']);
    expect([...destination]).toEqual(expected);
    const copies = requests.filter(({ method }) => method === 'PUT');
    expect(copies).toHaveLength(repeatedCopy ? 2 : 1);
    expect(copies[0]?.headers).toMatchObject({ 'x-amz-meta-purpose': 'research', 'content-type': 'text/csv', 'cache-control': 'private', 'x-amz-metadata-directive': 'REPLACE', 'x-amz-copy-source': `files-bucket/${DIRECTORY}/report.csv?versionId=${scenario === 'source replaced after snapshot' ? 'v2' : 'v1'}` });
    expect(copies[0]?.headers['x-amz-meta-account-claim-source']).toMatch(/^[a-f0-9]{64}$/);
    if (scenario === 'changed source version') expect(copies[1]?.headers['x-amz-meta-account-claim-source']).not.toEqual(copies[0]?.headers['x-amz-meta-account-claim-source']);
  });

  it('copies no file again that an earlier attempt of the claim already moved, deleting only the original', async () => {
    const { requests } = await aws(({ method, url }) => {
      if (method !== 'GET') return { body: '{}' };
      const query = new URL(url, 'http://s3').searchParams;
      if (query.has('versions')) return versionListing([`${DIRECTORY}/report.csv@v1*`], []);
      return query.get('prefix') === `${CLAIMED}/`
        ? listing([`${CLAIMED}/report.csv#same`])
        : listing([`${DIRECTORY}/report.csv#same`]);
    });

    await files().transfer(ACCOUNT, 'acct_claimed');

    expect(writes(requests)).toEqual([`DELETE /files-bucket/${DIRECTORY}/report.csv@v1`]);
  });
});

/** A ListObjectVersions page: each version, then each delete marker, as `key@version`, with a trailing `*` when it is the latest. */
const versionListing = (versions: string[], markers: string[], next?: { key: string; version: string }) => {
  const entry = (tag: string) => (named: string) => {
    const [key, version = ''] = named.split('@');
    const latest = version.endsWith('*');
    return `<${tag}><Key>${key}</Key><VersionId>${version.replace('*', '')}</VersionId><IsLatest>${latest}</IsLatest><LastModified>2026-10-01T12:00:00.000Z</LastModified></${tag}>`;
  };
  return {
    type: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult><Name>files-bucket</Name><IsTruncated>${next !== undefined}</IsTruncated>${
      next === undefined ? '' : `<NextKeyMarker>${next.key}</NextKeyMarker><NextVersionIdMarker>${next.version}</NextVersionIdMarker>`
    }${versions.map(entry('Version')).join('')}${markers.map(entry('DeleteMarker')).join('')}</ListVersionsResult>`,
  };
};

describe("an account's Files on account deletion", () => {
  it.each(['delete', 'transfer'] as const)('retries %s after the access point was deleted but its record write failed', async (operation) => {
    let accessPointDeleted = false;
    const { requests } = await aws(({ method, url }) => {
      if (method === 'DELETE') {
        if (accessPointDeleted) {
          return { status: 404, body: JSON.stringify({ __type: 'ResourceNotFoundException', message: 'access point absent' }) };
        }
        accessPointDeleted = true;
        return { body: '{}' };
      }
      return new URL(url, 'http://s3').searchParams.has('versions') ? versionListing([], []) : listing([]);
    });
    const records = memoryRecords();
    await records.saveFilesAccessPoint(ACCOUNT, ACCESS_POINT_ARN);
    const removeRecord = vi.spyOn(records, 'deleteFilesAccessPoint').mockRejectedValueOnce(new Error('record write failed'));
    const accountFiles = files(records);
    const remove = () => operation === 'delete' ? accountFiles.delete(ACCOUNT) : accountFiles.transfer(ACCOUNT, 'acct_claimed');

    await expect(remove()).rejects.toThrow('record write failed');
    expect(await records.filesAccessPoint(ACCOUNT)).toBe(ACCESS_POINT_ARN);
    await expect(remove()).rejects.toMatchObject({ status: 404, cause: { name: 'ResourceNotFoundException' } });
    await expect(remove()).resolves.toBeUndefined();

    expect(requests.filter(({ method }) => method === 'DELETE')).toHaveLength(2);
    expect(removeRecord).toHaveBeenCalledTimes(2);
    expect(await records.filesAccessPoint(ACCOUNT)).toBeNull();
  });

  it('retains both failures when absent access-point cleanup cannot clear its record', async () => {
    await aws(({ method }) => method === 'DELETE'
      ? { status: 404, body: JSON.stringify({ __type: 'ResourceNotFoundException', message: 'access point absent' }) }
      : versionListing([], []));
    const records = memoryRecords();
    await records.saveFilesAccessPoint(ACCOUNT, ACCESS_POINT_ARN);
    const failure = new Error('record write failed');
    vi.spyOn(records, 'deleteFilesAccessPoint').mockRejectedValueOnce(failure);

    const error = await files(records).delete(ACCOUNT).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 503, detail: 'Files access-point record cleanup failed' });
    expect(error).toBeInstanceOf(HttpError);
    const cause = (error as Error).cause as AggregateError;
    expect(cause).toBeInstanceOf(AggregateError);
    expect(cause.errors).toEqual([expect.objectContaining({ name: 'ResourceNotFoundException' }), failure]);
    expect(await records.filesAccessPoint(ACCOUNT)).toBe(ACCESS_POINT_ARN);
  });

  it('preserves the access-point record when AWS refuses its deletion', async () => {
    await aws(({ method }) => method === 'DELETE'
      ? { status: 409, body: JSON.stringify({ __type: 'ConflictException', message: 'access point in use' }) }
      : versionListing([], []));
    const records = memoryRecords();
    await records.saveFilesAccessPoint(ACCOUNT, ACCESS_POINT_ARN);
    const removeRecord = vi.spyOn(records, 'deleteFilesAccessPoint');

    await expect(files(records).delete(ACCOUNT)).rejects.toThrow('access point in use');

    expect(removeRecord).not.toHaveBeenCalled();
    expect(await records.filesAccessPoint(ACCOUNT)).toBe(ACCESS_POINT_ARN);
  });

  it('deletes every version and delete marker in its directory, on every page, then its access point and its record', async () => {
    let versionPages = 0;
    const { requests } = await aws(({ method }) => {
      if (method !== 'GET') return { body: '{}' };
      return versionPages++ > 0
        ? versionListing([`${DIRECTORY}/report.csv@v1`], [])
        : versionListing([`${DIRECTORY}/@d1*`, `${DIRECTORY}/report.csv@v2*`], [`${DIRECTORY}/old.txt@m1*`], {
            key: `${DIRECTORY}/report.csv`,
            version: 'v2',
          });
    });
    const records = memoryRecords();
    await records.saveFilesAccessPoint(ACCOUNT, ACCESS_POINT_ARN);

    await files(records).delete(ACCOUNT);

    const deletes = requests.filter(({ method }) => method === 'DELETE').map(({ url }) => {
      const parsed = new URL(url, 'http://s3');
      return `${decodeURIComponent(parsed.pathname)}${parsed.searchParams.has('versionId') ? `@${parsed.searchParams.get('versionId')}` : ''}`;
    });
    // Earlier versions, then delete markers, then current files: a sweep cut short brings no earlier version back.
    expect(deletes).toEqual([
      `/files-bucket/${DIRECTORY}/report.csv@v1`,
      `/files-bucket/${DIRECTORY}/old.txt@m1`,
      `/files-bucket/${DIRECTORY}/@d1`,
      `/files-bucket/${DIRECTORY}/report.csv@v2`,
      `/access-points/${ACCESS_POINT_ARN}`,
    ]);
    expect(new URL(requests[0]?.url ?? '', 'http://s3').searchParams.get('prefix')).toBe(`${DIRECTORY}/`);
    expect(requests.filter(({ method }) => method === 'GET').map(({ url }) => {
      const query = new URL(url, 'http://s3').searchParams;
      return [query.get('key-marker'), query.get('version-id-marker')];
    })).toEqual([[null, null], [`${DIRECTORY}/report.csv`, 'v2']]);
    expect(await records.filesAccessPoint(ACCOUNT)).toBeNull();
  });
});

const assumedRole = {
  type: 'text/xml',
  body: `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>ASIASCOPED</AccessKeyId><SecretAccessKey>scoped-secret</SecretAccessKey><SessionToken>scoped-token</SessionToken><Expiration>2026-10-01T13:00:00Z</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::123456789012:assumed-role/files-sync/files</Arn><AssumedRoleId>AROA:files</AssumedRoleId></AssumedRoleUser></AssumeRoleResult></AssumeRoleResponse>`,
};

describe("an account's Files sync binding", () => {
  it("hands the agent's Turn credentials for the account's directory alone, for an hour", async () => {
    const { requests } = await aws(() => assumedRole);

    expect(await files().syncBinding(ACCOUNT)).toEqual({
      bucket: 'files-bucket',
      prefix: `${DIRECTORY}/`,
      region: 'eu-west-1',
      accessKeyId: 'ASIASCOPED',
      secretAccessKey: 'scoped-secret',
      sessionToken: 'scoped-token',
    });

    const [request] = requests;
    const form = Object.fromEntries(new URLSearchParams(request?.body ?? ''));
    expect({ ...form, Policy: JSON.parse(form.Policy ?? '') }).toEqual({
      Action: 'AssumeRole',
      Version: '2011-06-15',
      RoleArn: SYNC_ROLE_ARN,
      RoleSessionName: 'files-8300e9d12ce55ca979c3e7e01a8f7fac',
      DurationSeconds: '3600',
      Policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:PutObject'],
            Resource: `arn:aws:s3:::files-bucket/${DIRECTORY}/*`,
          },
          {
            Effect: 'Allow',
            Action: 's3:ListBucket',
            Resource: 'arn:aws:s3:::files-bucket',
            Condition: { StringLike: { 's3:prefix': `${DIRECTORY}/*` } },
          },
        ],
      },
    });
    expect(requests).toHaveLength(1);
  });

  it('answers 503 without a sync role', async () => {
    const { requests } = await aws(() => assumedRole);

    await expect(files(memoryRecords(), 3, null).syncBinding(ACCOUNT)).rejects.toThrow(
      new HttpError(503, 'Files sync is not configured: BOTCUBE_FILES_SYNC_ROLE_ARN is required'),
    );
    expect(requests).toEqual([]);
  });

  it('fails loud when STS answers no credentials', async () => {
    await aws(() => ({
      type: 'text/xml',
      body: '<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult></AssumeRoleResult></AssumeRoleResponse>',
    }));

    await expect(files().syncBinding(ACCOUNT)).rejects.toThrow('STS AssumeRole answered no credentials for Files');
  });
});

describe('Files from the environment', () => {
  it.each([
    [{ BOTCUBE_FILES_FILE_SYSTEM_ARN: FILE_SYSTEM_ARN }],
    [{ BOTCUBE_FILES_BUCKET: 'files-bucket', BOTCUBE_FILES_FILE_SYSTEM_ARN: ' ' }],
  ])('answers 503 until the bucket and file system are both set: %j', (env) => {
    expect(() => accountFilesFromEnv(env, memoryRecords)()).toThrow(
      new HttpError(503, 'Files are not configured: BOTCUBE_FILES_BUCKET and BOTCUBE_FILES_FILE_SYSTEM_ARN are required'),
    );
  });

  it.each([
    [{}, false],
    [{ BOTCUBE_FILES_BUCKET: ' ' }, false],
    [{ BOTCUBE_FILES_BUCKET: 'files-bucket' }, true],
    [{ BOTCUBE_FILES_FILE_SYSTEM_ARN: FILE_SYSTEM_ARN }, true],
    [{ BOTCUBE_FILES_SYNC_ROLE_ARN: SYNC_ROLE_ARN }, true],
  ])('takes Files as configured once any of its settings is: %j', (env, configured) => {
    expect(filesConfigured(env)).toBe(configured);
  });

  it('takes the sync role from BOTCUBE_FILES_SYNC_ROLE_ARN', async () => {
    const { requests } = await aws(() => assumedRole);
    const fromEnv = accountFilesFromEnv(
      { BOTCUBE_FILES_BUCKET: 'files-bucket', BOTCUBE_FILES_FILE_SYSTEM_ARN: FILE_SYSTEM_ARN, BOTCUBE_FILES_SYNC_ROLE_ARN: ` ${SYNC_ROLE_ARN} ` },
      memoryRecords,
    );

    await fromEnv().syncBinding(ACCOUNT);

    expect(new URLSearchParams(requests[0]?.body).get('RoleArn')).toBe(SYNC_ROLE_ARN);
  });

  it("uses the file system's Region, virtual-hosted S3 without AWS_ENDPOINT_URL_S3, and one client throughout", async () => {
    const storage = setupServer(http.head(`https://files-bucket.s3.eu-west-1.amazonaws.com/${DIRECTORY}/report.csv`, () => new HttpResponse()));
    storage.listen({ onUnhandledRequest: 'error' });
    closers.push(async () => storage.close());
    const fromEnv = accountFilesFromEnv(
      { BOTCUBE_FILES_BUCKET: ' files-bucket ', BOTCUBE_FILES_FILE_SYSTEM_ARN: ` ${FILE_SYSTEM_ARN} ` },
      memoryRecords,
    );

    expect(fromEnv()).toBe(fromEnv());
    const url = new URL(await fromEnv().downloadUrl(ACCOUNT, 'report.csv'));
    expect(`${url.origin}${url.pathname}`).toBe(`https://files-bucket.s3.eu-west-1.amazonaws.com/${DIRECTORY}/report.csv`);
  });

  it('addresses S3 path-style at AWS_ENDPOINT_URL_S3', async () => {
    const storage = setupServer(http.head(`http://s3.test/files-bucket/${DIRECTORY}/report.csv`, () => new HttpResponse()));
    storage.listen({ onUnhandledRequest: 'error' });
    closers.push(async () => storage.close());
    const fromEnv = accountFilesFromEnv(
      { BOTCUBE_FILES_BUCKET: 'files-bucket', BOTCUBE_FILES_FILE_SYSTEM_ARN: FILE_SYSTEM_ARN, AWS_ENDPOINT_URL_S3: 'http://s3.test' },
      memoryRecords,
    );
    vi.stubEnv('AWS_ENDPOINT_URL_S3', 'http://s3.test');

    const url = new URL(await fromEnv().downloadUrl(ACCOUNT, 'report.csv'));

    expect(`${url.origin}${url.pathname}`).toBe(`http://s3.test/files-bucket/${DIRECTORY}/report.csv`);
  });
});
