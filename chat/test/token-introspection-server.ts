import { serve } from '@hono/node-server';
import { AccountStore } from '../src/account-store.js';
import { tokenIntrospectionRoutes } from '../src/token-introspection.js';
import { memoryDocuments } from './memory-documents.js';

class RegisteringStore extends AccountStore {
  register(accountId: string): Promise<void> {
    return this.mutation(async (lease) => {
      const account = await this.requireAccount(accountId);
      await this.commit(lease, [this.put(this.accountItem({ ...account, status: 'registered' }))]);
    });
  }
}

const store = new RegisteringStore('chat', { key: 'bot', product: 'Bot' }, memoryDocuments());
const { account } = await store.anonymousAccount(undefined);
await store.register(account.accountId);
const live = await store.createSession(account.accountId);
const signedOut = await store.createSession(account.accountId);
await store.deleteTrustedSession(signedOut);
const routes = tokenIntrospectionRoutes({ sessions: () => store, invocationSecret: process.env.INTROSPECTION_SECRET ?? '' });
serve({ fetch: routes.fetch, port: 0, hostname: '127.0.0.1' }, ({ port }) => {
  process.stdout.write(`${JSON.stringify({ port, accountId: account.accountId, live, signedOut })}\n`);
});
