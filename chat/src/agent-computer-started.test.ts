import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { agentComputerStarted, agentComputerStartedFromConfig } from './agent-computer-started.js';
import { TurnIdentity } from './turn-identity.js';

const ISSUER = 'https://chat.example.com';
const SERVICE = 'http://service.example:8081/me/agent-computer/started';

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  return { publicKey, jwk: { ...(await exportJWK(privateKey)), kid: 'k1' } };
}

function service(status = 200, body = '{}') {
  const posts: { url: string; method: string | undefined; authorization: string | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    posts.push({ url, method: init?.method, authorization: new Headers(init?.headers).get('authorization') });
    return new Response(body, { status });
  }) as typeof globalThis.fetch;
  return { posts, fetch };
}

describe("telling a product's service about each Agent Computer browser BotCube starts", () => {
  it("posts the User's signed user token naming the browser", async () => {
    const { publicKey, jwk } = await keys();
    const { posts, fetch } = service();
    const started = agentComputerStarted({ url: SERVICE, signer: new TurnIdentity({ issuer: ISSUER, keys: [jwk] }), anonymous: async () => false, fetch });

    await started('acct_1', 'chat-1', 'browser-1');

    expect(posts.map(({ url, method }) => [url, method])).toEqual([[SERVICE, 'POST']]);
    const token = posts[0]?.authorization?.replace(/^Bearer /, '') ?? '';
    const { payload } = await jwtVerify(token, publicKey, { issuer: ISSUER, audience: 'botcube-user', algorithms: ['ES256'] });
    expect(payload).toMatchObject({ sub: 'acct_1', anonymous: false, agentComputerSession: 'browser-1', threadId: 'chat-1' });
  });

  it("fails when the service refuses, so BotCube stops the browser", async () => {
    const { jwk } = await keys();
    const { fetch } = service(502);
    const started = agentComputerStarted({ url: SERVICE, signer: new TurnIdentity({ issuer: ISSUER, keys: [jwk] }), anonymous: async () => true, fetch });

    await expect(started('acct_1', 'chat-1', 'browser-1')).rejects.toThrow(`${SERVICE} answered HTTP 502`);
  });

  it.each([
    ['a message', { detail: 'Sign in again to continue' }],
    ['a coded message', { detail: { code: 'relink_required', message: 'Sign in again to continue' } }],
  ])("answers with the service's own refusal of the User, given as %s", async (_, body) => {
    const { jwk } = await keys();
    const { fetch } = service(401, JSON.stringify(body));
    const started = agentComputerStarted({ url: SERVICE, signer: new TurnIdentity({ issuer: ISSUER, keys: [jwk] }), anonymous: async () => false, fetch });

    await expect(started('acct_1', 'chat-1', 'browser-1')).rejects.toMatchObject({ status: 401, message: 'Sign in again to continue' });
  });

  it('is off unless its path is set, and needs the Credential Service and the Turn identity keys that sign the token', async () => {
    const { jwk } = await keys();
    const anonymous = async () => false;
    const signing = { BOTCUBE_TURN_IDENTITY_KEYS: JSON.stringify([jwk]), BOTCUBE_PUBLIC_ORIGIN: ISSUER };

    expect(agentComputerStartedFromConfig(undefined, {}, anonymous)).toBeUndefined();
    expect(() => agentComputerStartedFromConfig('/started', signing, anonymous)).toThrow(/BOTCUBE_CREDENTIAL_SERVICE_URL/);
    expect(() => agentComputerStartedFromConfig('/started', { BOTCUBE_CREDENTIAL_SERVICE_URL: SERVICE }, anonymous)).toThrow(/BOTCUBE_TURN_IDENTITY_KEYS/);
    expect(agentComputerStartedFromConfig('/started', { BOTCUBE_CREDENTIAL_SERVICE_URL: SERVICE, ...signing }, anonymous)).toBeTypeOf('function');
  });
});
