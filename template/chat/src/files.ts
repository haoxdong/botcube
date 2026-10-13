import { randomUUID } from 'node:crypto';
import { HttpError } from 'botcube-chat';
import { Hono } from 'hono';
import type { AccountFiles } from 'botcube-chat/files';
import { templateRequester } from './account.js';

const uploads = new Map<string, { owner: string; name: string; expires: number }>();
const accounts = new Map<string, Map<string, Uint8Array>>();
const records = (owner: string) => { let files = accounts.get(owner); if (!files) { files = new Map([['sample.txt', new TextEncoder().encode('Hello from BotCube.\n')]]); accounts.set(owner, files); } return files; };
const requireName = (name: string) => { if (!name || name.split('/').some((part) => !part || part === '.' || part === '..')) throw new HttpError(400, 'name must be a path inside Files'); return name; };

/** Offline storage behind the same Files routes the cloud implementation uses. */
export function templateFiles(requestUrl: string): Pick<AccountFiles, 'list' | 'downloadUrl' | 'remove' | 'rename' | 'uploadUrl'> {
  const url = (name: string) => { const endpoint = new URL('/files/content', requestUrl); endpoint.searchParams.set('name', requireName(name)); return endpoint.href; };
  const requireFile = (owner: string, name: string) => { const value = records(owner).get(requireName(name)); if (!value) throw new HttpError(404, 'File not found'); return value; };
  return {
    async list(owner) { return [...records(owner)].map(([name, data]) => ({ name, size: data.byteLength, lastModified: '2026-01-01T00:00:00.000Z' })); },
    async downloadUrl(owner, name) { requireFile(owner, name); return url(name); },
    async uploadUrl(owner, name) {
      if (records(owner).has(requireName(name))) throw new HttpError(409, 'File already exists');
      const now = Date.now();
      for (const [token, upload] of uploads) if (upload.expires <= now) uploads.delete(token);
      const token = randomUUID();
      uploads.set(token, { owner, name, expires: now + 300_000 });
      const endpoint = new URL(url(name));
      endpoint.searchParams.set('upload', token);
      return endpoint.href;
    },
    async remove(owner, name) { requireFile(owner, name); records(owner).delete(name); },
    async rename(owner, from, to) { const bytes = requireFile(owner, from); requireName(to); if (records(owner).has(to)) throw new HttpError(409, 'File already exists'); records(owner).set(to, bytes); records(owner).delete(from); },
  };
}

export const templateFileContent = new Hono()
  .get('/files/content', async (c) => { const { owner } = await templateRequester(c); const name = requireName(c.req.query('name') ?? ''); const data = records(owner).get(name); if (!data) throw new HttpError(404, 'File not found'); return c.body(new Uint8Array(data)); })
  .put('/files/content', async (c) => {
    const upload = uploads.get(c.req.query('upload') ?? '');
    if (!upload || upload.expires <= Date.now() || upload.name !== c.req.query('name')) throw new HttpError(403, 'Invalid upload URL');
    const { owner, name } = upload;
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (records(owner).has(name)) throw new HttpError(409, 'File already exists');
    records(owner).set(name, data);
    return c.body(null, 204);
  });
