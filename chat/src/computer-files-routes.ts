import { Hono, type Context } from 'hono';
import { HttpError, type AccountHistory, type Requester } from './cartridge.js';
import type { AccountFiles } from './files.js';
import type { AgentComputerState } from './agent-computer.js';
import { jsonPayload } from './payload.js';

/** The reusable UI routes; account authentication and sandbox ownership are supplied by the Cartridge. */
export function computerFilesRoutes({ requester, history, computers, files }: {
  requester(c: Context): Promise<Requester>;
  history: Pick<AccountHistory, 'owns'>;
  computers: { state(owner: string, threadId: string): Promise<AgentComputerState>; wake(owner: string, threadId: string): Promise<AgentComputerState> };
  files(c: Context): Pick<AccountFiles, 'list' | 'downloadUrl' | 'remove' | 'rename' | 'uploadUrl'>;
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
  // The Files app (ADR 0077 decision 2): the account's files, moved through presigned URLs.
  const fileName = (name: unknown) => {
    if (typeof name !== 'string') throw new HttpError(422, 'name is required');
    return name;
  };
  routes.get('/files', async (c) => c.json({ files: await files(c).list((await requester(c)).owner) }));
  routes.get('/files/download-url', async (c) =>
    c.json({ url: await files(c).downloadUrl((await requester(c)).owner, fileName(c.req.query('name'))) }),
  );
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
    return c.json({ url: await files(c).uploadUrl(owner, fileName((await jsonPayload(c))?.name)) });
  });
  return routes;
}
