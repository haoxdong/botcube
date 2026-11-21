import { generateKeyPairSync, randomUUID, type JsonWebKey } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { BotCubeConfig } from 'botcube-config';
import type { ChatHarnessAuth } from './harness-auth.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { harnessBearer } from './harness-auth.js';
import { TurnIdentity } from './turn-identity.js';
import { filed } from '../test/stock-bot.js';
import { HttpFake, sendJson } from '../test/fakes/http-fake.js';

const ISSUER = 'https://chat.example.com';

it("shares the BotCube Config's harnessAuth with the CDK as the schema reads it", () => {
  expectTypeOf<ChatHarnessAuth>().toEqualTypeOf<BotCubeConfig['integrations']['harnessAuth']>();
});
const key: JsonWebKey = { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'key-1' };

describe('a Chat Service on the jwt-bearer Harness auth', () => {
  let stack: InProcessStack;
  beforeAll(async () => {
    stack = await startInProcess({ config: { turnIdentity: { issuer: ISSUER, keys: [key] }, harnessAuth: { kind: 'jwt-bearer', issuer: 'botcube', clients: [{ clientId: 'botcube-harness' }] } } });
  });
  afterAll(() => stack.stop());

  it('invokes the AgentCore Runtime with its own bearer token for the Harness audience, not SigV4', async () => {
    const sessionId = randomUUID();
    await stack.sessionMetadata.recordTurn('acct_account-1', sessionId, { filingUserId: filed('acct_account-1'), title: 'Bearer', allocation: true });

    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: sessionId, runId: randomUUID(), state: {}, tools: [], context: [], messages: [{ id: randomUUID(), role: 'user', content: 'hello' }] }),
    });
    await response.text();

    const { headers } = stack.agentcore.invocationFor(sessionId);
    expect(headers['x-amz-date']).toBeUndefined();
    const token = /^Bearer (.+)$/.exec(String(headers.authorization))?.[1] ?? '';
    const jwks = await (await stack.app.request('/.well-known/jwks.json')).json() as JSONWebKeySet;
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer: ISSUER, audience: 'botcube-harness' });
    expect(payload).toEqual({ iss: ISSUER, aud: 'botcube-harness', sub: 'botcube-chat-service', iat: expect.any(Number), exp: (payload.iat ?? 0) + 300, jti: expect.any(String) });
  });
});

/**
 * A token endpoint as a command: each run prints the next token, `harness-token-<n>`, expiring 30 s on, inside the
 * minute before expiry Chat refreshes in; from `failFrom` runs on it fails.
 */
function tokenEndpoint(failFrom: number): [string, ...string[]] {
  const dir = mkdtempSync(join(tmpdir(), 'harness-token-'));
  const script = join(dir, 'token-endpoint.mjs');
  writeFileSync(script, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    const counter = new URL('./runs', import.meta.url);
    const runs = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
    writeFileSync(counter, String(runs));
    if (runs >= ${failFrom}) process.exit(7);
    const status = { token: 'harness-token-' + runs, expirationTimestamp: new Date(Date.now() + 30_000).toISOString() };
    process.stdout.write(JSON.stringify({ kind: 'ExecCredential', status }));
  `);
  return [process.execPath, script];
}

describe('a Chat Service on the jwt-bearer Harness auth from an outside issuer', () => {
  let stack: InProcessStack;
  let command: [string, ...string[]];
  beforeAll(async () => {
    vi.stubEnv('BOTCUBE_ALLOW_COMMAND_CREDENTIALS', '1');
    command = tokenEndpoint(3);
    stack = await startInProcess({ config: { harnessAuth: {
      kind: 'jwt-bearer',
      issuer: 'https://idp.example.com/realms/platform/.well-known/openid-configuration',
      clients: [{ clientId: 'botcube-harness' }],
      token: { kind: 'command', command, timeoutSeconds: 30 },
    } } });
  });
  afterAll(async () => {
    await stack.stop();
    vi.unstubAllEnvs();
  });

  const turn = async () => {
    const sessionId = randomUUID();
    await stack.sessionMetadata.recordTurn('acct_account-1', sessionId, { filingUserId: filed('acct_account-1'), title: 'Outside bearer', allocation: true });
    const response = await stack.app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: sessionId, runId: randomUUID(), state: {}, tools: [], context: [], messages: [{ id: randomUUID(), role: 'user', content: 'hello' }] }),
    });
    return { sessionId, answer: await response.text() };
  };
  const bearerOf = (sessionId: string) => stack.agentcore.invocationFor(sessionId).headers.authorization;

  it("sends the issuer's token, refreshed before it expires, and fails the Turn naming the Harness seam when it cannot be", async () => {
    const first = await turn();
    const second = await turn();
    const failed = await turn();

    expect([bearerOf(first.sessionId), bearerOf(second.sessionId)]).toEqual(['Bearer harness-token-1', 'Bearer harness-token-2']);
    expect(failed.answer).toContain(`harnessAuth credential (command ${command[0]}): the command exited with code 7`);
    expect(stack.agentcore.invocations()).toHaveLength(2);
  });
});

describe("a Chat Service on the jwt-bearer Harness auth with an outside issuer's OAuth client credentials", () => {
  let stack: InProcessStack;
  let idp: HttpFake;
  beforeAll(async () => {
    let issued = 0;
    idp = await new HttpFake((_, response) => {
      issued += 1;
      if (issued >= 3) sendJson(response, 401, { error: 'invalid_client', error_description: 'the client secret is wrong' });
      else sendJson(response, 200, { access_token: `idp-token-${issued}`, token_type: 'Bearer', expires_in: 30 });
    }).listen();
    const clientSecret = join(mkdtempSync(join(tmpdir(), 'harness-client-secret-')), 'client-secret');
    writeFileSync(clientSecret, 'client-secret-value');
    stack = await startInProcess({ config: { harnessAuth: {
      kind: 'jwt-bearer',
      issuer: 'https://idp.example.com/realms/platform/.well-known/openid-configuration',
      clients: [{ clientId: 'botcube-chat' }],
      token: { kind: 'oauth-client-credentials', tokenEndpoint: `${idp.url}/oauth2/token`, clientId: 'botcube-chat', clientSecret: { kind: 'file', path: clientSecret } },
    } } });
  });
  afterAll(async () => {
    await stack.stop();
    await idp.close();
  });

  it("sends the token endpoint's access token, refreshed before it expires, and fails the Turn naming the Harness seam when it cannot be", async () => {
    const turn = async () => {
      const sessionId = randomUUID();
      await stack.sessionMetadata.recordTurn('acct_account-1', sessionId, { filingUserId: filed('acct_account-1'), title: 'OAuth bearer', allocation: true });
      const response = await stack.app.request('/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: sessionId, runId: randomUUID(), state: {}, tools: [], context: [], messages: [{ id: randomUUID(), role: 'user', content: 'hello' }] }),
      });
      return { sessionId, answer: await response.text() };
    };
    const first = await turn();
    const second = await turn();
    const failed = await turn();

    const bearers = [first, second].map(({ sessionId }) => stack.agentcore.invocationFor(sessionId).headers.authorization);
    expect(bearers).toEqual(['Bearer idp-token-1', 'Bearer idp-token-2']);
    expect(failed.answer).toContain(`harnessAuth credential (oauth-client-credentials ${idp.url}/oauth2/token): the token endpoint answered 401 invalid_client`);
    expect(failed.answer).not.toContain('client-secret-value');
    expect(stack.agentcore.invocations()).toHaveLength(2);
  });
});

describe('Harness auth configuration', () => {
  it.each(['sts.amazonaws.com', 'botcube-user', 'botcube-chat-service'])(
    'signs no Harness bearer for the reserved audience %s',
    async audience => {
      const identity = new TurnIdentity({ issuer: ISSUER, keys: [key] });
      await expect(identity.signServiceToken(audience)).rejects.toThrow(
        `The Harness audience ${audience} is reserved for another kind of BotCube token`,
      );
    },
  );

  it('stops startup on a JWT bearer with no Turn identity keys to sign it', () => {
    expect(() => harnessBearer({ kind: 'jwt-bearer', issuer: 'botcube', clients: [{ clientId: 'botcube-harness' }] }, null)).toThrow('harnessAuth.kind: jwt-bearer signs with the Turn identity keys');
  });
});
