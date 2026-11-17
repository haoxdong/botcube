import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { DeploymentConfig } from 'botcube-deployment-config';
import * as client from 'openid-client';
import type { AccountCookies } from './account-cookies.js';
import type { AccountStore } from './account-store.js';
import { HttpError } from './cartridge.js';
import { corsOriginsFromEnv, LOCAL_UI_ORIGINS } from './cors.js';

/** The Deployment Config's `oidc` identity section, with its client secret read. */
interface OidcIdentity {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

interface OidcSignInOptions {
  identity: OidcIdentity;
  store: () => AccountStore;
  cookies: AccountCookies;
  /** The UI origins a sign-in may return to. */
  returnOrigins: readonly string[];
  /** The Chat Service's public origin, the provider's redirect URI's; unset, the request's own (local stacks). */
  publicOrigin?: string | undefined;
}

const CALLBACK_PATH = '/auth/oidc/callback';
const PENDING_COOKIE = 'botcube_oidc_sign_in';
const PENDING_SECONDS = 600;

/** The `identity.clientSecret` the deploy reads from its secret into the Chat Service's environment. */
export function oidcClientSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.BOTCUBE_OIDC_CLIENT_SECRET;
  if (!secret) throw new Error('identity.clientSecret: BOTCUBE_OIDC_CLIENT_SECRET is not set; the deploy fills it from the secret this field names');
  return secret;
}

/** The Deployment Config's `oidc` identity as the Chat Service serves it: the provider's sign-in. */
export function oidcIdentity(
  identity: Extract<DeploymentConfig['identity'], { kind: 'oidc' }>,
  env: NodeJS.ProcessEnv,
  { store, cookies }: Pick<OidcSignInOptions, 'store' | 'cookies'>,
): { routes: Hono } {
  const { routes } = oidcSignIn({
    identity: { issuer: identity.issuer, clientId: identity.clientId, clientSecret: oidcClientSecret(env) },
    store,
    cookies,
    returnOrigins: corsOriginsFromEnv(env) ?? LOCAL_UI_ORIGINS,
    publicOrigin: env.BOTCUBE_PUBLIC_ORIGIN,
  });
  return { routes };
}

interface PendingSignIn {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

/**
 * Users sign in with an OpenID Connect provider: authorization code with PKCE, state and nonce. The provider's
 * user becomes the browser's account, registered; `/auth/logout` (accountRoutes) signs out.
 */
export function oidcSignIn({ identity, store, cookies, returnOrigins, publicOrigin }: OidcSignInOptions) {
  let configuration: Promise<client.Configuration> | undefined;
  const provider = () => (configuration ??= discover(identity).catch((error: unknown) => {
    configuration = undefined;
    throw Object.assign(new HttpError(502, `The OIDC provider ${identity.issuer} could not be discovered`), { cause: error });
  }));
  const redirectUri = (c: Context) => new URL(CALLBACK_PATH, publicOrigin ?? new URL(c.req.url).origin);

  const routes = new Hono();
  routes.get('/auth/oidc/login', async (c) => {
    const returnTo = c.req.query('return_to') ?? '';
    if (!URL.canParse(returnTo) || !returnOrigins.includes(new URL(returnTo).origin)) throw new HttpError(400, 'return_to is not a page of this bot');
    const pending: PendingSignIn = { state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier(), returnTo };
    const url = client.buildAuthorizationUrl(await provider(), {
      redirect_uri: redirectUri(c).href,
      scope: 'openid profile',
      code_challenge: await client.calculatePKCECodeChallenge(pending.verifier),
      code_challenge_method: 'S256',
      state: pending.state,
      nonce: pending.nonce,
    });
    setCookie(c, PENDING_COOKIE, JSON.stringify(pending), { maxAge: PENDING_SECONDS, httpOnly: true, secure: redirectUri(c).protocol === 'https:', sameSite: 'Lax', path: CALLBACK_PATH });
    return c.redirect(url.href);
  });

  routes.get(CALLBACK_PATH, async (c) => {
    const pending = pendingSignIn(getCookie(c, PENDING_COOKIE));
    deleteCookie(c, PENDING_COOKIE, { path: CALLBACK_PATH });
    const current = redirectUri(c);
    current.search = new URL(c.req.url).search;
    const claims = await redeem(await provider(), current, pending);
    const replaced = cookies.sessionToken(c);
    const { accountId, sessionToken } = await store().signInWithOidc(
      { issuer: claims.iss, subject: claims.sub, displayName: typeof claims.name === 'string' ? claims.name : undefined },
      cookies.accountId(c),
    );
    if (replaced) await store().deleteTrustedSession(replaced);
    cookies.setAccount(c, accountId);
    cookies.setSession(c, sessionToken);
    return c.redirect(pending.returnTo);
  });

  return { routes };
}

async function discover({ issuer, clientId, clientSecret }: OidcIdentity): Promise<client.Configuration> {
  // A stand-in issuer on this machine speaks http; the schema allows nothing else over http.
  const execute = new URL(issuer).protocol === 'http:' ? [client.allowInsecureRequests] : [];
  return client.discovery(new URL(issuer), clientId, clientSecret, undefined, { execute });
}

function pendingSignIn(cookie: string | undefined): PendingSignIn {
  try {
    const pending = JSON.parse(cookie ?? '') as Partial<PendingSignIn>;
    if (pending.state && pending.nonce && pending.verifier && pending.returnTo) return pending as PendingSignIn;
  } catch {
    // Malformed: the same answer as missing.
  }
  throw new HttpError(400, 'This sign-in has expired or was started in another browser; sign in again');
}

async function redeem(configuration: client.Configuration, current: URL, pending: PendingSignIn) {
  try {
    const tokens = await client.authorizationCodeGrant(configuration, current, {
      pkceCodeVerifier: pending.verifier, expectedState: pending.state, expectedNonce: pending.nonce, idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (claims === undefined) throw new HttpError(401, 'The OIDC provider returned no ID token');
    return claims;
  } catch (error) {
    if (error instanceof client.ClientError || error instanceof client.AuthorizationResponseError || error instanceof client.ResponseBodyError) {
      throw Object.assign(new HttpError(401, `OIDC sign-in failed: ${error.message}`), { cause: error });
    }
    throw error;
  }
}
