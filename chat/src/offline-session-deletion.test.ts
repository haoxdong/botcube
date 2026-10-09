import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { startInProcess } from '../test/in-process.js';

it.each(['thread', 'account'])('reports offline %s deletion as unavailable while retaining durable cleanup', async (deletion) => {
  const events = ['old checkpoint', 'messages snapshot'];
  const routes = new Hono().delete('/account', async (c) => {
    await deleteAccount();
    return c.body(null, 204);
  });
  const stack = await startInProcess({
    config: { agentCore: null, localHarnessUrl: null },
    cartridge: { routes },
    invokeSessionApi: async (request) => {
      if (request.operation === 'purge') events.splice(0);
      return {};
    },
  });
  const deleteAccount = () => stack.history.delete('account-1');
  const server = serve({ fetch: stack.app.fetch, port: 0 });
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('HTTP server did not bind');
    const url = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await stack.sessionMetadata.recordTurn('account-1', 'previous-runtime', { filingUserId: 'filed-account-1', title: 'Earlier deployment' });
    const path = deletion === 'thread' ? '/threads/previous-runtime' : '/account';
    const response = await fetch(`${url}${path}`, { method: 'DELETE' });
    expect(response.status).toBe(503);
    expect((await fetch(`${url}${path}`, { method: 'DELETE' })).status).toBe(503);
    expect(await response.json()).toEqual({ detail: 'The Session Runtime is not configured' });
    expect(events).toEqual(['old checkpoint', 'messages snapshot']);
    expect(await stack.sessionMetadata.get('account-1', 'previous-runtime')).toBeNull();
    expect(await stack.sessionMetadata.pendingPurges()).toMatchObject([{ session_id: 'previous-runtime', filing_user_id: 'filed-account-1' }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await stack.stop();
  }
});
