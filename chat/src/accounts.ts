import { Hono, type Context } from 'hono';
import type { AccountCookies } from './account-cookies.js';
import { clearCookie } from './account-cookies.js';
import { accountProfileRoutes } from './account-profile.js';
import type { Account } from './account-record.js';
import type { AccountStore } from './account-store.js';
import type { AccountHistory } from './account-history.js';
import { HttpError } from './http-error.js';
import { jsonPayload } from './payload.js';
import type { AccountFiles } from './files.js';

/** A site the agent is signed in to, as `GET /account/sign-ins` lists it. */
export interface SignIn {
  site: string;
  name: string;
  status: string;
  username?: string | null;
}

export interface AccountRoutesOptions<A extends Account> {
  store: () => AccountStore<A>;
  cookies: AccountCookies;
  /** The bot's own fields of `GET /account/session`. */
  session?: (account: A) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** The Agent Profile's Sign-ins tab: the sites the account's agent is signed in to. */
  signIns: (account: A) => Promise<SignIn[]>;
  connectors?: readonly { name: string; defaultOn?: boolean }[] | undefined;
  /** What else signing out clears, once the session is gone. */
  signedOut?: () => void;
  /** Where a signed-out browser goes next, so the OIDC provider ends its own session too. */
  logoutUrl?: string | undefined;
  deleteTestUser?: (accountId: string) => Promise<void>;
}

/**
 * The browser's account: an anonymous account kept by a year-long cookie, or the
 * registered account its session signed in. Serves `/account/session`,
 * `/account/sign-ins`, `/auth/logout` and the account profile.
 */
export function accountRoutes<A extends Account>({ store, cookies, session, signIns, connectors = [], signedOut, logoutUrl, deleteTestUser }: AccountRoutesOptions<A>) {
  const naming = () => store().naming;
  const trustedAccountId = (c: Context) => store().sessionAccountId(cookies.sessionToken(c));
  async function operatorAccount(c: Context): Promise<A | null> {
    const bearer = c.req.header('x-botcube-test-user');
    if (bearer === undefined) return null;
    const account = await store().operatorTestUser(bearer);
    if (account === null) throw new HttpError(401, 'Invalid operator Test User token');
    return account;
  }


  /**
   * The account a request acts for: the bot's `preferred` pick given the signed-in account,
   * else the signed-in account, else the browser's anonymous one. Only the Chat Service resolves
   * identity (ADR 0068 §4): a request without an account fails here instead of running under a shared one.
   */
  async function owner(
    c: Context,
    preferred: (trusted: string | null, account: A | null) => Promise<string | null> = async () => null,
  ): Promise<{ owner: string; account: A | null }> {
    const testUser = await operatorAccount(c);
    if (testUser !== null) return { owner: testUser.accountId, account: testUser };
    const trustedAccount = await store().sessionAccount(cookies.sessionToken(c));
    const trusted = trustedAccount?.accountId ?? null;
    const candidateId = trusted ?? cookies.accountId(c);
    const candidateAccount = trustedAccount ?? (candidateId ? await store().loadAccount(candidateId) : null);
    let id = (await preferred(trusted, candidateAccount)) ?? trusted;
    let account: A | null;
    if (id !== null) {
      account = id === candidateId ? candidateAccount : await store().loadAccount(id);
    } else {
      account = candidateAccount;
      if (account?.status !== 'anonymous') throw new HttpError(401, `Missing ${naming().key} account cookie`);
      id = account.accountId;
    }
    if (account?.deletionOperationId !== undefined) throw new HttpError(409, 'Account deletion is pending');
    if (account !== null) await store().recordGuestActivity(account);
    return { owner: id, account };
  }

  /** The signed-in account: display name and photo are its own to edit. */
  async function signedInAccount(c: Context): Promise<A> {
    const account = await operatorAccount(c) ?? await store().loadAccount(await trustedAccountId(c));
    if (account === null) throw new HttpError(401, `${naming().product} authentication is required for the account profile`);
    return account;
  }

  const routes = new Hono();

  routes.delete('/operator/test-user', async (c) => {
    const account = await store().operatorTestUser(c.req.header('x-botcube-test-user') ?? '');
    if (account === null) throw new HttpError(401, 'Invalid operator Test User token');
    if (deleteTestUser === undefined) throw new HttpError(503, 'Test User cleanup is not configured');
    const cleanup = deleteTestUser;
    await store().accountDeletionLock(account.accountId, async () => {
      const current = await store().operatorTestUser(c.req.header('x-botcube-test-user') ?? '');
      if (current === null) throw new HttpError(401, 'Invalid operator Test User token');
      await cleanup(current.accountId);
    });
    return c.body(null, 204);
  });
  routes.post('/auth/logout', async (c) => {
    if (await operatorAccount(c) !== null) throw new HttpError(403, 'Test Users have no public login session');
    const token = cookies.sessionToken(c);
    if (token) await store().deleteTrustedSession(token);
    signedOut?.();
    clearCookie(c, cookies.session);
    return c.json(logoutUrl === undefined ? { status: 'ok' } : { status: 'ok', logoutUrl });
  });

  routes.get('/account/session', async (c) => {
    const accounts = store();
    const cookieAccountId = cookies.accountId(c);
    const trusted = await operatorAccount(c) ?? await accounts.loadAccount(await trustedAccountId(c));
    const { account, created } = trusted
      ? { account: trusted, created: false }
      : await accounts.anonymousAccount(cookieAccountId);
    if (account.status !== 'test' && (created || cookieAccountId !== account.accountId)) cookies.setAccount(c, account.accountId);
    if (!created && account.deletionOperationId === undefined) await accounts.recordGuestActivity(account);
    return c.json({
      accountId: account.accountId,
      status: account.status,
      rateTier: account.rateTier,
      authenticated: trusted !== null,
      ...await session?.(account),
      signInNeeded: Boolean(account.signInNeeded),
    });
  });

  routes.get('/account/sign-ins', async (c) => {
    if (await operatorAccount(c) !== null) return c.json({ signIns: [] });
    const trusted = await trustedAccountId(c);
    const account = await store().loadAccount(trusted ?? cookies.accountId(c));
    if (account === null) throw new HttpError(401, `Missing or invalid ${naming().key} account cookie`);
    if (trusted === null && account.status !== 'anonymous') {
      throw new HttpError(401, `${naming().product} authentication is required to list Sign-ins`);
    }
    return c.json({ signIns: await signIns(account) });
  });

  routes.get('/account/connectors', async (c) => {
    const { account } = await owner(c);
    const choices = account?.connectorChoices ?? {};
    return c.json({ connectors: connectors.map(({ name, defaultOn }) => ({
      name, enabled: Object.hasOwn(choices, name) ? choices[name] : defaultOn === true,
    })) });
  });

  routes.put('/account/connectors/:name', async (c) => {
    const account = await owner(c);
    const name = c.req.param('name');
    if (!connectors.some((connector) => connector.name === name)) throw new HttpError(404, 'Connector is not configured');
    const payload = await jsonPayload(c);
    if (typeof payload?.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
    await store().setConnectorChoice(account.owner, name, payload.enabled);
    return c.body(null, 204);
  });

  routes.route('/', accountProfileRoutes({ signedInAccount, store }));

  return { routes, owner, trustedAccountId, signedInAccount };
}

/**
 * What erasing an account does beyond its Sessions: the Credential Service revokes its credentials first, its
 * Files go with its chats (ADR 0077), and its Agent Computer stops and is erased. Saving changes no account
 * (ADR 0076), so nothing moves between them.
 */
export function accountLifecycle<A extends Account>({
  credentials,
  history,
  files,
  computers,
  store,
}: {
  /** The Credential Service's revoke of every credential the account holds, or null when nothing here holds any. */
  credentials: { revoke(accountId: string): Promise<void> } | null;
  history: AccountHistory;
  /** The deploy's Files, or null without them. */
  files: (() => AccountFiles) | null;
  computers: { erase(accountId: string): Promise<void> };
  store: () => AccountStore<A>;
}) {
  return {
    /** Erase the account: its credentials, its Agent Computer, then its Sessions and Files, then the account itself. */
    async deleteAccount(accountId: string): Promise<void> {
      await credentials?.revoke(accountId);
      await computers.erase(accountId);
      await history.delete(accountId);
      if (files !== null) await files().delete(accountId);
      await store().deleteAccount(accountId);
    },
  };
}
