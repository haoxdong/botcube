import { Hono, type Context } from 'hono';
import type { AccountCookies } from './account-cookies.js';
import { clearCookie } from './account-cookies.js';
import { accountProfileRoutes } from './account-profile.js';
import type { Account, AccountStore } from './account-store.js';
import { HttpError, type AccountHistory } from './cartridge.js';
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
  /** The Cartridge's own fields of `GET /account/session`. */
  session?: (account: A) => Record<string, unknown>;
  /** The Agent Profile's Sign-ins tab: the sites the account's agent is signed in to. */
  signIns: (account: A) => Promise<SignIn[]>;
  /** What else signing out clears, once the session is gone. */
  signedOut?: () => void;
}

/**
 * The browser's account: an anonymous account kept by a year-long cookie, or the
 * registered account its session signed in. Serves `/account/session`,
 * `/account/sign-ins`, `/auth/logout` and the account profile.
 */
export function accountRoutes<A extends Account>({ store, cookies, session, signIns, signedOut }: AccountRoutesOptions<A>) {
  const naming = () => store().naming;
  const trustedAccountId = (c: Context) => store().sessionAccountId(cookies.sessionToken(c));

  /**
   * The account a request acts for: the Cartridge's `preferred` pick given the signed-in account,
   * else the signed-in account, else the browser's anonymous one. Only the Chat Service resolves
   * identity (ADR 0068 §4): a request without an account fails here instead of running under a shared one.
   */
  async function owner(
    c: Context,
    preferred: (trusted: string | null) => Promise<string | null> = async () => null,
  ): Promise<{ owner: string; account: A | null }> {
    const trusted = await trustedAccountId(c);
    const anonymous = async () => {
      const account = await store().loadAccount(cookies.accountId(c));
      return account?.status === 'anonymous' ? account.accountId : null;
    };
    const id = (await preferred(trusted)) ?? trusted ?? (await anonymous());
    if (id === null) throw new HttpError(401, `Missing ${naming().key} account cookie`);
    const account = await store().loadAccount(id);
    if (account?.deletionOperationId !== undefined) throw new HttpError(409, 'Account deletion is pending');
    return { owner: id, account };
  }

  /** The signed-in account: display name and photo are its own to edit. */
  async function signedInAccount(c: Context): Promise<A> {
    const account = await store().loadAccount(await trustedAccountId(c));
    if (account === null) throw new HttpError(401, `${naming().product} authentication is required for the account profile`);
    return account;
  }

  const routes = new Hono();
  routes.post('/auth/logout', async (c) => {
    const token = cookies.sessionToken(c);
    if (token) await store().deleteTrustedSession(token);
    signedOut?.();
    clearCookie(c, cookies.session);
    return c.json({ status: 'ok' });
  });

  routes.get('/account/session', async (c) => {
    const accounts = store();
    const cookieAccountId = cookies.accountId(c);
    const trusted = await accounts.loadAccount(await trustedAccountId(c));
    const { account, created } = trusted
      ? { account: trusted, created: false }
      : await accounts.anonymousAccount(cookieAccountId);
    if (created || cookieAccountId !== account.accountId) cookies.setAccount(c, account.accountId);
    return c.json({
      accountId: account.accountId,
      status: account.status,
      rateTier: account.rateTier,
      authenticated: trusted !== null,
      ...session?.(account),
      signInNeeded: Boolean(account.signInNeeded),
    });
  });

  routes.get('/account/sign-ins', async (c) => {
    const trusted = await trustedAccountId(c);
    const account = await store().loadAccount(trusted ?? cookies.accountId(c));
    if (account === null) throw new HttpError(401, `Missing or invalid ${naming().key} account cookie`);
    if (trusted === null && account.status !== 'anonymous') {
      throw new HttpError(401, `${naming().product} authentication is required to list Sign-ins`);
    }
    return c.json({ signIns: await signIns(account) });
  });

  routes.route('/', accountProfileRoutes({ signedInAccount, store }));

  return { routes, owner, trustedAccountId, signedInAccount };
}

/**
 * What changing an account does beyond its Sessions: its Files go with its chats (an Account
 * Claim moves them, ADR 0077), and its Agent Computer stops and is erased.
 */
export function accountLifecycle<A extends Account>({
  history,
  files,
  computers,
  store,
}: {
  history: AccountHistory;
  /** The deploy's Files, or null without them. */
  files: (() => AccountFiles) | null;
  computers: { erase(accountId: string): Promise<void> };
  store: () => AccountStore<A>;
}) {
  const accountHistory: AccountHistory = {
    async transfer(source, destination) {
      await history.transfer(source, destination);
      if (files !== null) await files().transfer(source, destination);
      // The claimed account's Agent Computer does not move: its browsers stop, and its profile and screenshots go.
      await computers.erase(source);
    },
    async delete(accountId) {
      await history.delete(accountId);
      if (files !== null) await files().delete(accountId);
    },
    owns: (accountId, sessionId) => history.owns(accountId, sessionId),
    ownsMainChat: (accountId, sessionId) => history.ownsMainChat(accountId, sessionId),
  };
  return {
    history: accountHistory,
    /** Erase the account: its Agent Computer, then its Sessions and Files, then the account itself. */
    async deleteAccount(accountId: string): Promise<void> {
      await computers.erase(accountId);
      await accountHistory.delete(accountId);
      await store().deleteAccount(accountId);
    },
  };
}
