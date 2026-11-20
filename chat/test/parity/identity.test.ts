// Test seam 1 (ADR 0091) for the identity seam: the enterprise example, started from its Deployment Config, signs its
// Users in through a stand-in OIDC provider, and a product's own service, in its own process, verifies BotCube's
// signed user token against BotCube's JWKS.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { StandInOidcIssuer } from '../fakes/oidc-issuer.js';
import { startOnFreePort, type RunningProcess } from '../fakes/process.js';
import { frameData, sseFrames, type Browser } from './browser.js';
import { startLocalStack, type LocalStack } from './local-stack.js';

const ENTERPRISE = fileURLToPath(new URL('../../../examples/enterprise/deployment-config.json', import.meta.url));
const EXAMPLE_BOT = fileURLToPath(new URL('../../../examples/bot/bot.json', import.meta.url));
const PRODUCT_SERVICE = fileURLToPath(new URL('../fakes/product-service.ts', import.meta.url));
const PUBLIC_ORIGIN = 'https://chat.example';
const UI = 'http://localhost:3001/';

const signingKey = (kid: string): JWK => ({ ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid });
const botcubeKey = signingKey('botcube-1');

let dir: string;
let issuer: StandInOidcIssuer;
let stack: LocalStack;
let product: RunningProcess;
/** Stops what `beforeAll` has started, so a failed start still stops the rest. */
const stops: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'enterprise-'));
  issuer = await new StandInOidcIssuer().listen();
  stops.push(() => issuer.close());
  // The enterprise example as it ships, pointed at the stand-in provider in place of its own.
  const config = JSON.parse(await readFile(ENTERPRISE, 'utf8')) as { identity: Record<string, unknown> };
  const path = join(dir, 'deployment-config.json');
  await writeFile(path, JSON.stringify({ ...config, bot: EXAMPLE_BOT, identity: { ...config.identity, issuer: issuer.url } }));
  stack = await startLocalStack({ chatEnv: {
    BOTCUBE_DEPLOYMENT_CONFIG: path,
    BOTCUBE_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    BOTCUBE_TURN_IDENTITY_KEYS: JSON.stringify([botcubeKey]),
  } });
  stops.push(() => stack.stop());
  product = await startOnFreePort((port) => ({
    command: `node ${PRODUCT_SERVICE}`,
    env: { PATH: process.env.PATH, PORT: String(port), BOTCUBE_PUBLIC_ORIGIN: PUBLIC_ORIGIN, BOTCUBE_JWKS_URL: `${stack.url}/.well-known/jwks.json` },
    url: `http://127.0.0.1:${port}/whoami`,
    listening: `Product service listening on :${port}`,
  }));
  stops.push(() => product.stop());
}, 120_000);

afterAll(async () => {
  await Promise.all(stops.map((stop) => stop()));
  await rm(dir, { recursive: true, force: true });
});

/** Sign in as the UI's "Sign in" does: to the provider, which signs `user` in at once, and back to the Chat Service. */
async function signIn(browser: Browser, user: string): Promise<Response> {
  const login = await browser.get(`/auth/oidc/login?return_to=${encodeURIComponent(UI)}`);
  expect(login.status).toBe(302);
  const authorize = new URL(login.headers.get('location') ?? '');
  expect(authorize.origin).toBe(issuer.url);
  authorize.searchParams.set('login_hint', user);
  const back = await fetch(authorize, { redirect: 'manual' });
  // The provider returns the browser to the Chat Service's public origin, which this stack answers at its own URL.
  const callback = new URL(back.headers.get('location') ?? '');
  expect(callback.origin + callback.pathname).toBe(`${PUBLIC_ORIGIN}/auth/oidc/callback`);
  return browser.get(callback.pathname + callback.search);
}

const whoami = (token: string) => fetch(new URL('/whoami', product.url), { headers: { authorization: `Bearer ${token}` } });

async function userToken(browser: Browser): Promise<string> {
  const response = await browser.get('/account/user-token');
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

it('signs a User in through the OIDC provider, keeping the chats they started before', async () => {
  const browser = stack.browser();
  const anonymous = await browser.openAccountSession();
  const thread = await browser.newSideChat();
  // A chat is started by its first Turn: an allocated Side Chat with none has no conversation to open.
  const turn = await browser.sendTurn(thread, { text: 'Hello, who are you?' });
  expect(sseFrames(await turn.text()).map(frameData).some(({ type }) => type === 'RUN_FINISHED')).toBe(true);

  const back = await signIn(browser, 'ada');

  expect(back.status).toBe(302);
  expect(back.headers.get('location')).toBe(UI);
  expect(await browser.openAccountSession()).toMatchObject({ accountId: anonymous.accountId, status: 'registered', authenticated: true });
  expect((await browser.get(`/threads/${thread}`)).status).toBe(200);
});

it('signs the same User in to the same account from another browser, and another User to their own', async () => {
  const first = stack.browser();
  await signIn(first, 'grace');
  const again = stack.browser();
  await signIn(again, 'grace');
  const other = stack.browser();
  await signIn(other, 'linus');

  const [a, b, c] = await Promise.all([first, again, other].map((browser) => browser.openAccountSession()));
  expect(b?.accountId).toBe(a?.accountId);
  expect(c?.accountId).not.toBe(a?.accountId);
});

it('refuses a sign-in that comes back without the browser that started it', async () => {
  const browser = stack.browser();
  const login = await browser.get(`/auth/oidc/login?return_to=${encodeURIComponent(UI)}`);
  const back = await fetch(new URL(login.headers.get('location') ?? ''), { redirect: 'manual' });
  const callback = new URL(back.headers.get('location') ?? '');

  const elsewhere = await stack.browser().get(callback.pathname + callback.search);

  expect(elsewhere.status).toBe(400);
});

it('refuses to return a sign-in to a page outside the bot', async () => {
  expect((await stack.browser().get(`/auth/oidc/login?return_to=${encodeURIComponent('https://evil.example/')}`)).status).toBe(400);
});

it("lets a product's own service verify a signed-in User by BotCube's signed user token", async () => {
  const browser = stack.browser();
  await signIn(browser, 'ada');
  const { accountId } = await browser.openAccountSession();

  const response = await whoami(await userToken(browser));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accountId, anonymous: false });
});

it("tells a product's own service when the User has not signed in", async () => {
  const browser = stack.browser();
  const { accountId } = await browser.openAccountSession();

  expect(await (await whoami(await userToken(browser))).json()).toEqual({ accountId, anonymous: true });
});

it("refuses a forged or expired user token at the product's own service", async () => {
  const claims = { anonymous: false };
  const token = (key: JWK, expiresAt: number) => new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'botcube-1' })
    .setIssuer(PUBLIC_ORIGIN).setAudience('botcube-user').setSubject('acct_forged').setIssuedAt(expiresAt - 600).setExpirationTime(expiresAt).sign(key);
  const now = Math.floor(Date.now() / 1000);

  const forged = await whoami(await token(signingKey('botcube-1'), now + 600));
  const expired = await whoami(await token(botcubeKey, now - 60));

  expect([forged.status, await forged.json()]).toEqual([401, { detail: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' }]);
  expect([expired.status, await expired.json()]).toEqual([401, { detail: 'ERR_JWT_EXPIRED' }]);
});
