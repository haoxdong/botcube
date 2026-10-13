import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { HttpError } from 'botcube-chat';
import { computerFilesRoutes } from 'botcube-chat/computer-files-routes';
import { templateRequester } from './account.js';
import { templateFiles, templateFileContent } from './files.js';

it('runs the shared Files routes through account-scoped offline uploads, downloads, rename and removal', async () => {
  const app = new Hono().onError((error, c) => {
    if (error instanceof HttpError) return c.json({ detail: error.detail }, error.status as 400);
    throw error;
  }).route('/', computerFilesRoutes({
    requester: templateRequester,
    history: { owns: async () => false },
    computers: {
      state: async () => ({ state: 'asleep', screenshot: null }),
      wake: async () => ({ state: 'asleep', screenshot: null }),
    },
    files: (c) => templateFiles(c.req.url),
  })).route('/', templateFileContent);
  const first = await app.request('http://fixture/files');
  const cookie = first.headers.get('set-cookie')?.split(';')[0];
  expect(cookie).toBeTruthy();
  if (!cookie) throw new Error('Files fixture did not establish its account session');
  const headers = { cookie, 'content-type': 'application/json' };
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
  expect((await app.request('http://fixture/files/download-url?name=report.txt')).status).toBe(404);
  expect((await app.request('http://fixture/files/upload-url', { method: 'POST', headers, body: JSON.stringify({ name: 'report.txt' }) })).status).toBe(409);
  expect((await app.request('http://fixture/files/rename', { method: 'POST', headers, body: JSON.stringify({ from: 'report.txt', to: 'saved.txt' }) })).status).toBe(200);
  expect((await app.request('http://fixture/files?name=saved.txt', { method: 'DELETE', headers })).status).toBe(204);
  expect((await app.request('http://fixture/files/download-url?name=saved.txt', { headers })).status).toBe(404);
  expect((await app.request('http://fixture/files/upload-url', { method: 'POST', headers, body: JSON.stringify({ name: '../escape' }) })).status).toBe(400);
});
