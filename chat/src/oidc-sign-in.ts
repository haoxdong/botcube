import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { DeploymentConfig } from 'botcube-deployment-config';
import * as client from 'openid-client';
import { clearCookie, type AccountCookies } from './account-cookies.js';
import type { AccountStore } from './account-store.js';
import { HttpError } from './http-error.js';
import { credentialSource, type CredentialSource } from './credential-source.js';

interface OidcClient {
  clientId: string;
  clientSecret: CredentialSource;
}

interface OidcIdentity {
  issuer: string;
  clients: readonly [OidcClient, ...OidcClient[]];
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
const DELETION_REAUTH_SECONDS = 300;

export function oidcIdentity(
  identity: Extract<DeploymentConfig['identity'], { kind: 'oidc' }>,
  env: NodeJS.ProcessEnv,
  { store, cookies, returnOrigins }: Pick<OidcSignInOptions, 'store' | 'cookies' | 'returnOrigins'>,
) {
  const client = ({ clientId, clientSecret }: (typeof identity.clients)[number], index: number): OidcClient =>
    ({ clientId, clientSecret: credentialSource(`identity.clients.${index}.clientSecret`, clientSecret, { env }) });
  const [first, ...rest] = identity.clients;
  return oidcSignIn({
    identity: { issuer: identity.issuer, clients: [client(first, 0), ...rest.map((other, index) => client(other, index + 1))] },
    store,
    cookies,
    returnOrigins,
    publicOrigin: env.BOTCUBE_PUBLIC_ORIGIN,
  });
}

interface PendingSignIn {
  clientId: string;
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  /** The sign-in re-authenticates the signed-in User to delete their account. */
  deletion: boolean;
}

export function oidcSignIn({ identity, store, cookies, returnOrigins, publicOrigin }: OidcSignInOptions) {
  const configurations = new Map<string, Promise<client.Configuration>>();
  const provider = (signInClient: OidcClient) => {
    const known = configurations.get(signInClient.clientId);
    if (known) return known;
    const discovered = discover(identity.issuer, signInClient).catch((error: unknown) => {
      configurations.delete(signInClient.clientId);
      throw Object.assign(new HttpError(502, `The OIDC provider ${identity.issuer} could not be discovered`), { cause: error });
    });
    configurations.set(signInClient.clientId, discovered);
    return discovered;
  };
  const clientNamed = (clientId: string | undefined): OidcClient => {
    const named = clientId === undefined ? identity.clients[0] : identity.clients.find((candidate) => candidate.clientId === clientId);
    if (!named) throw new HttpError(400, 'client is not a sign-in client of this bot');
    return named;
  };
  const redirectUri = (c: Context) => new URL(CALLBACK_PATH, publicOrigin ?? new URL(c.req.url).origin);

  const routes = new Hono();
  /** The provider's authorization URL for this browser's sign-in, remembered in its pending cookie. */
  async function authorization(c: Context, deletion: boolean, reauthentication: Record<string, string> = {}): Promise<URL> {
    const returnTo = c.req.query('return_to') ?? '';
    if (!URL.canParse(returnTo) || !returnOrigins.includes(new URL(returnTo).origin)) throw new HttpError(400, 'return_to is not a page of this bot');
    const signInClient = clientNamed(c.req.query('client'));
    const pending: PendingSignIn = {
      clientId: signInClient.clientId, state: client.randomState(), nonce: client.randomNonce(), verifier: client.randomPKCECodeVerifier(), returnTo, deletion,
    };
    const url = client.buildAuthorizationUrl(await provider(signInClient), {
      redirect_uri: redirectUri(c).href,
      scope: 'openid profile',
      code_challenge: await client.calculatePKCECodeChallenge(pending.verifier),
      code_challenge_method: 'S256',
      state: pending.state,
      nonce: pending.nonce,
      ...reauthentication,
    });
    setCookie(c, PENDING_COOKIE, JSON.stringify(pending), { maxAge: PENDING_SECONDS, httpOnly: true, secure: redirectUri(c).protocol === 'https:', sameSite: 'Lax', path: CALLBACK_PATH });
    return url;
  }

  routes.get('/auth/oidc/login', async (c) => c.redirect((await authorization(c, false)).href));

  /** Deleting the account starts with the User signing in again at the provider; the callback records the deletion. */
  const deletion = new Hono();
  deletion.post('/auth/oidc/delete', async (c) => {
    if (await store().sessionAccountId(cookies.sessionToken(c)) === null) throw new HttpError(401, 'Sign in before deleting your account');
    const url = await authorization(c, true, { prompt: 'login', max_age: '0' });
    return c.json({ authorizeUrl: url.href });
  });

  routes.get(CALLBACK_PATH, async (c) => {
    const pending = pendingSignIn(getCookie(c, PENDING_COOKIE));
    deleteCookie(c, PENDING_COOKIE, { path: CALLBACK_PATH });
    const current = redirectUri(c);
    current.search = new URL(c.req.url).search;
    const claims = await redeem(await provider(clientNamed(pending.clientId)), current, pending);
    if (pending.deletion) {
      const authTime = claims.auth_time;
      if (authTime === undefined || authTime < Math.floor(Date.now() / 1000) - DELETION_REAUTH_SECONDS) {
        throw new HttpError(401, 'Deleting your account needs a sign-in at the provider within the last 5 minutes, and its auth_time says otherwise; start the deletion again');
      }
      const intent = await store().authorizeOidcAccountDeletion(cookies.sessionToken(c), { issuer: claims.iss, subject: claims.sub });
      if (intent === null) throw new HttpError(403, 'The provider signed in someone other than this account; nothing was deleted');
      clearCookie(c, cookies.account);
      clearCookie(c, cookies.session);
      return c.redirect(pending.returnTo);
    }
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

  return { routes, deletion, credentials: identity.clients.map(({ clientSecret }) => clientSecret) };
}

async function discover(issuer: string, { clientId, clientSecret }: OidcClient): Promise<client.Configuration> {
  // A stand-in issuer on this machine speaks http; the schema allows nothing else over http.
  const execute = new URL(issuer).protocol === 'http:' ? [client.allowInsecureRequests] : [];
  // Read at each redemption, so a rotated secret reaches the provider without a restart.
  const clientSecretPost: client.ClientAuth = async (...request) => client.ClientSecretPost((await clientSecret.get()).value)(...request);
  return client.discovery(new URL(issuer), clientId, undefined, clientSecretPost, { execute });
}

function pendingSignIn(cookie: string | undefined): PendingSignIn {
  try {
    const pending = JSON.parse(cookie ?? '') as Partial<PendingSignIn>;
    if (pending.clientId && pending.state && pending.nonce && pending.verifier && pending.returnTo && typeof pending.deletion === 'boolean') return pending as PendingSignIn;
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
