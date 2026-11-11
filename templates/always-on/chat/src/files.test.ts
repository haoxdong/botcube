import { Hono, type Context } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpError } from 'botcube-chat';
import { computerFilesRoutes } from 'botcube-chat/computer-files-routes';
import { accountRoutes } from 'botcube-chat/accounts';
import { memoryDocuments } from '../../../../chat/test/memory-documents.js';
import { templateAccountStore, templateCookies } from './account.js';
import { templateFiles, templateFileContent } from './files.js';

afterEach(() => vi.unstubAllEnvs());

function filesApp() {
  const store = templateAccountStore({}, memoryDocuments());
  const accounts = accountRoutes({ store: () => store, cookies: templateCookies, signIns: async () => [] });
  const requester = async (c: Context) => ({ owner: (await accounts.owner(c)).owner });
  const app = new Hono().onError((error, c) => {
    if (error instanceof HttpError) return c.json({ detail: error.detail }, error.status as 400);
    throw error;
  }).route('/', computerFilesRoutes({
    requester,
    history: { owns: async () => false },
    computers: {
      state: async () => ({ state: 'asleep', screenshot: null }),
      wake: async () => ({ state: 'asleep', screenshot: null }),
    },
    files: (c) => templateFiles(c.req.url),
  })).route('/', templateFileContent(requester)).route('/', accounts.routes);
  return app;
}

async function signedIn(app: Hono) {
  const cookie = (await app.request('http://fixture/account/session')).headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Files fixture did not establish its account');
  return { cookie, 'content-type': 'application/json' };
}

it('runs the shared Files routes through account-scoped offline uploads, downloads, rename and removal', async () => {
  const app = filesApp();
  expect((await app.request('http://fixture/files')).status).toBe(401);
  const headers = await signedIn(app);
  const first = await app.request('http://fixture/files', { headers });
  expect(await first.json()).toMatchObject({ files: [{ name: 'sample.txt' }] });
  const upload = await app.request('http://fixture/files/upload-url', { method: 'POST', headers, body: JSON.stringify({ name: 'report.txt' }) });
  expect(upload.status).toBe(200);
  const { url } = await upload.json() as { url: string };
  const invalid = new URL(url);
  invalid.searchParams.set('upload', 'invalid');
  expect((await app.request(invalid, { method: 'PUT', body: 'wrong owner' })).status).toBe(403);
  const put = await app.request(url, { method: 'PUT', headers: { 'if-none-match': '*' }, body: 'finished report' });
  expect(put.status).toBe(204);
  expect(put.headers.get('set-cookie')).toBeNull();
  expect((await app.request(url, { method: 'PUT', body: 'replacement' })).status).toBe(409);
  const download = await app.request('http://fixture/files/download-url?name=report.txt', { headers });
  expect(download.status).toBe(200);
  expect(await (await app.request((await download.json() as { url: string }).url, { headers })).text()).toBe('finished report');
  expect((await app.request('http://fixture/files/download-url?name=report.txt')).status).toBe(401);
  expect((await app.request('http://fixture/files/upload-url', { method: 'POST', headers, body: JSON.stringify({ name: 'report.txt' }) })).status).toBe(409);
  expect((await app.request('http://fixture/files/rename', { method: 'POST', headers, body: JSON.stringify({ from: 'report.txt', to: 'saved.txt' }) })).status).toBe(200);
  expect((await app.request('http://fixture/files?name=saved.txt', { method: 'DELETE', headers })).status).toBe(204);
  expect((await app.request('http://fixture/files/download-url?name=saved.txt', { headers })).status).toBe(404);
  expect((await app.request('http://fixture/files/upload-url', { method: 'POST', headers, body: JSON.stringify({ name: '../escape' }) })).status).toBe(400);
});

it('saves an edited Artifact only behind the Artifacts flag, and refuses a save that is not one', async () => {
  const edit = { id: '/decks/q3', version: 1, files: { 'project/slides/cover.html': '<section id="cover"></section>' } };
  const save = async (app: Hono, body: unknown) => app.request('http://fixture/files/artifact-save', { method: 'POST', headers: await signedIn(app), body: JSON.stringify(body) });
  expect((await save(filesApp(), edit)).status).toBe(404);

  vi.stubEnv('BOTCUBE_ARTIFACTS', '1');
  const app = filesApp();
  const refused = await Promise.all([{ ...edit, files: { 'project/slides/cover.html': 3 } }, { ...edit, version: 1.5 }, { files: edit.files }].map(async (body) => (await save(app, body)).status));
  expect(refused).toEqual([422, 422, 422]);
  const offline = await save(app, edit);
  expect([offline.status, await offline.json()]).toEqual([404, { detail: 'No Artifact /decks/q3 in Files' }]);
});
