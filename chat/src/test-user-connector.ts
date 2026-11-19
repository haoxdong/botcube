import { Hono } from 'hono';
import type { Account } from './account-record.js';
import type { AccountStore } from './account-store.js';
import { HttpError } from './cartridge.js';
import { verifyCredentialServiceInvocation } from './credential-service-token.js';

interface TestUserConnectorOptions<A extends Account> {
  store: () => AccountStore<A>;
  /** The Credential Service invocation secret an operator token is signed with; null while the Credential Service is unbound. */
  invocationSecret: string | null;
  /** The one account whose Connector a Test User may copy. */
  ownerAccountId: string | undefined;
  /** Have the Credential Service copy the owner's Connector to the Test User, under the operator's session. */
  copy: (testUserId: string, sessionId: string) => Promise<void>;
}

/**
 * `POST /operator/test-user/connector`: the operator copies the owner's Connector to a live Test User. The operator token is a
 * `test_user_copy` Credential Service invocation for the owner; the copy runs under the Test User's deletion lock.
 */
export function testUserConnectorRoutes<A extends Account>({ store, invocationSecret, ownerAccountId, copy }: TestUserConnectorOptions<A>): Hono {
  const operator = (token: string) => {
    const invocation = invocationSecret === null ? null : verifyCredentialServiceInvocation(invocationSecret, token);
    if (invocation?.scope !== 'test_user_copy') throw new HttpError(401, 'Test User copying needs an operator token');
    if (ownerAccountId === undefined) throw new HttpError(503, 'Test User credential owner is not configured');
    if (invocation.accountId !== ownerAccountId) throw new HttpError(403, 'Test Users copy only the configured owner Connector');
    return invocation;
  };
  return new Hono().post('/operator/test-user/connector', async (c) => {
    const authorization = c.req.header('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const bearer = c.req.header('x-botcube-test-user') ?? '';
    operator(token);
    const account = await store().operatorTestUser(bearer);
    if (account === null) throw new HttpError(401, 'Invalid operator Test User token');
    await store().accountDeletionLock(account.accountId, async () => {
      const current = await store().operatorTestUser(bearer);
      if (current === null) throw new HttpError(401, 'Invalid operator Test User token');
      const invocation = operator(token);
      await copy(current.accountId, invocation.sessionId);
      await store().recordTestConnector(current.accountId, invocation.accountId);
    });
    return c.json({ status: 'stored' }, 201);
  });
}
