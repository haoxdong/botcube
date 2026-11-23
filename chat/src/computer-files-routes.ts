import { posix } from 'node:path';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { browserOrigin } from './account-cookies.js';
import { ArtifactRestore, ArtifactSave } from './artifact-save.js';
import type { AccountHistory } from './account-history.js';
import { HttpError } from './http-error.js';
import type { Requester } from './requester.js';
import type { AccountFiles } from './files.js';
import { LINK_PATH, UPLOAD_CHUNK_BYTES } from './files-link.js';
import type { AgentComputerState } from './agent-computer.js';
import { jsonPayload } from './payload.js';

/** The reusable UI routes; account authentication and sandbox ownership are existing by the bot. */
export function computerFilesRoutes({ requester, history, computers, files, workspace }: {
  requester(c: Context): Promise<Requester>;
  history: Pick<AccountHistory, 'owns'>;
  computers: { state(owner: string, threadId: string): Promise<AgentComputerState>; wake(owner: string, threadId: string): Promise<AgentComputerState> };
  workspace?: string | undefined;
  files(c: Context): Pick<AccountFiles, 'list' | 'downloadUrl' | 'link' | 'remove' | 'rename' | 'uploadUrl' | 'saveArtifact' | 'restoreArtifact'>;
}): Hono {
  const routes = new Hono();
  const threadIdOf = (c: Context) => { const value = c.req.query('thread_id')?.trim(); if (!value) throw new HttpError(422, 'thread_id must not be blank'); return value; };
  routes.get('/agent-computer', async (c) => c.json(await computers.state((await requester(c)).owner, threadIdOf(c))));
  routes.post('/agent-computer/wake', async (c) => {
    const { owner } = await requester(c);
    const threadId = threadIdOf(c);
    // A browser per Session (ADR 0077): only a Session the account owns wakes one, so no caller can start browsers at will.
    // A chat becomes a Session with its first message, so a new chat's Wake says so.
    if (!(await history.owns(owner, threadId))) throw new HttpError(404, "This chat's computer starts with its first message");
    return c.json(await computers.wake(owner, threadId));
  });
  // The Files app (ADR 0077 decision 2): the account's files, moved through signed links this service serves.
  const fileName = (name: unknown) => {
    if (typeof name !== 'string') throw new HttpError(422, 'name is required');
    return name;
  };
  routes.get('/files', async (c) => c.json({ files: await files(c).list((await requester(c)).owner) }));
  const linkUrl = (c: Context, link: string) => new URL(link, browserOrigin(c)).toString();
  const workspacePrefix = workspace && `${posix.resolve(workspace).slice(1)}/`;
  routes.get('/files/download-url', async (c) => {
    const { owner } = await requester(c);
    const name = fileName(c.req.query('name'));
    const relative = workspacePrefix && c.req.query('reply') === 'true' && name.startsWith(workspacePrefix) ? name.slice(workspacePrefix.length) : name;
    return c.json({ url: linkUrl(c, await files(c).downloadUrl(owner, relative)) });
  });
  routes.delete('/files', async (c) => {
    await files(c).remove((await requester(c)).owner, fileName(c.req.query('name')));
    return c.body(null, 204);
  });
  routes.post('/files/rename', async (c) => {
    const { owner } = await requester(c);
    const { from, to } = (await jsonPayload(c)) ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') throw new HttpError(422, 'from and to are required');
    await files(c).rename(owner, from, to);
    return c.json({ name: to });
  });
  routes.post('/files/upload-url', async (c) => {
    const { owner } = await requester(c);
    return c.json({ url: linkUrl(c, await files(c).uploadUrl(owner, fileName((await jsonPayload(c))?.name))) });
  });
  routes.get(LINK_PATH, async (c) => files(c).link({ method: 'GET', query: c.req.query(), range: c.req.header('range') }));
  routes.put(LINK_PATH, bodyLimit({ maxSize: UPLOAD_CHUNK_BYTES, onError: (c) => c.text(`chunks are at most ${UPLOAD_CHUNK_BYTES} bytes`, 413) }), async (c) =>
    files(c).link({ method: 'PUT', query: c.req.query(), body: Buffer.from(await c.req.arrayBuffer()) }));
  routes.post('/files/artifact-save', async (c) => {
    const { owner } = await requester(c);
    const save = ArtifactSave.safeParse(await jsonPayload(c));
    if (!save.success) throw new HttpError(422, 'id, version and files (each a path to its text) are required');
    return c.json(await files(c).saveArtifact(owner, save.data));
  });
  routes.post('/files/artifact-restore', async (c) => {
    const { owner } = await requester(c);
    const restore = ArtifactRestore.safeParse(await jsonPayload(c));
    if (!restore.success) throw new HttpError(422, 'id, from and version are required');
    return c.json(await files(c).restoreArtifact(owner, restore.data));
  });
  return routes;
}

