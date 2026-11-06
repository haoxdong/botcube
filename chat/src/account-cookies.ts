import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { SESSION_COOKIE_MAX_AGE_SECONDS } from './account-store.js';

const ACCOUNT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Set an httpOnly, Lax cookie for the whole site, Secure when the browser reached it over https. */
export function setSiteCookie(c: Context, name: string, value: string, maxAge: number): void {
  // The first protocol of a proxy chain's list: one split piece, which join() returns as is.
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',', 1).join().trim().toLowerCase();
  setCookie(c, name, value, {
    maxAge,
    httpOnly: true,
    secure: forwardedProto === 'https' || new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
  });
}

export const clearCookie = (c: Context, name: string) => deleteCookie(c, name, { path: '/' });

/** The browser's account cookie and its session cookie, named `<key>_account_id` and `<key>_session`. */
export function accountCookies(key: string) {
  const account = `${key}_account_id`;
  const session = `${key}_session`;
  return {
    /** The browser's Account, anonymous or registered. */
    account,
    /** A session: the account signed in. */
    session,
    setAccount: (c: Context, accountId: string) => setSiteCookie(c, account, accountId, ACCOUNT_COOKIE_MAX_AGE_SECONDS),
    setSession: (c: Context, token: string, maxAge = SESSION_COOKIE_MAX_AGE_SECONDS) => setSiteCookie(c, session, token, maxAge),
    /** The request's account cookie, as sent. */
    accountId: (c: Context) => getCookie(c, account),
    /** The request's session token, trimmed; empty when there is none. */
    sessionToken: (c: Context) => (getCookie(c, session) ?? '').trim(),
  };
}

export type AccountCookies = ReturnType<typeof accountCookies>;
