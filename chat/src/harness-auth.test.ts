import { generateKeyPairSync, randomUUID, type JsonWebKey } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { DeploymentConfig } from 'botcube-deployment-config';
import type { HarnessAuth } from 'botcube-deployment-config/seams';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { harnessBearer } from './harness-auth.js';
import { TurnIdentity } from './turn-identity.js';
import { filed } from '../test/stock-bot.js';

const ISSUER = 'https://chat.example.com';

it("shares the Deployment Config's harnessAuth with the CDK as the schema reads it", () => {
  expectTypeOf<HarnessAuth>().toEqualTypeOf<DeploymentConfig['harnessAuth']>();
});
const key: JsonWebKey = { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'key-1' };

describe('a Chat Service on the jwt-bearer Harness auth', () => {
  let stack: InProcessStack;
  beforeAll(async () => {
    stack = await startInProcess({ stock: true, config: { turnIdentity: { issuer: ISSUER, keys: [key] }, harnessAuth: { kind: 'jwt-bearer', issuer: 'botcube', clients: [{ clientId: 'botcube-harness' }] } } });
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
