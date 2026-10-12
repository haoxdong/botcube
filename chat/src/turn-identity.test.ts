import { generateKeyPairSync, randomUUID, type JsonWebKey } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from 'jose';
import { defined } from '../test/defined.js';
import type { InvocationPayload } from '../test/fakes/fake-agentcore.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { TurnIdentity, turnIdentityConfigFromEnv } from './turn-identity.js';

const ISSUER = 'https://chat.example.com';

function privateJwk(kid: string): JsonWebKey {
  return { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid };
}

const current = privateJwk('key-2026-10');
const next = privateJwk('key-2026-11');
const turn = { actorId: 'filed-account-1', filingActorId: 'filed-anon-7', sessionId: '3f2b8c1e-5d4a-4f6b-9c2d-1a2b3c4d5e6f', startedAt: '2026-10-11T12:00:00.000Z' };
const startedAtSeconds = Date.parse(turn.startedAt) / 1000;

let stack: InProcessStack;
beforeAll(async () => {
  stack = await startInProcess({ scheduled: true, config: { turnIdentity: { issuer: ISSUER, keys: [current, next] } } });
});
afterAll(() => stack.stop());

async function publishedKeys(): Promise<JSONWebKeySet> {
  const response = await stack.app.request('/.well-known/jwks.json');
  expect(response.status).toBe(200);
  return await response.json() as JSONWebKeySet;
}

describe('OIDC discovery', () => {
  it('names the issuer, its JWKS and ES256 ID tokens', async () => {
    const response = await stack.app.request('/.well-known/openid-configuration');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      claims_supported: ['iss', 'sub', 'aud', 'iat', 'exp', 'jti', 'https://aws.amazon.com/tags'],
    });
  });

  it('publishes every configured public key, so a new kid can sit beside the old one', async () => {
    const { keys } = await publishedKeys();

    expect(keys).toEqual([
      { kty: 'EC', crv: 'P-256', x: current.x, y: current.y, kid: 'key-2026-10', alg: 'ES256', use: 'sig' },
      { kty: 'EC', crv: 'P-256', x: next.x, y: next.y, kid: 'key-2026-11', alg: 'ES256', use: 'sig' },
    ]);
  });

  it('serves no discovery when the Chat Service has no Turn identity keys', async () => {
    const bare = await startInProcess();
    try {
      expect((await bare.app.request('/.well-known/openid-configuration')).status).toBe(404);
      expect((await bare.app.request('/.well-known/jwks.json')).status).toBe(404);
    } finally {
      await bare.stop();
    }
  });
});

describe('Turn identity JWT', () => {
  const identity = new TurnIdentity({ issuer: ISSUER, keys: [current, next] });

  it('is signed by the first key under its kid and verifies against the published JWKS', async () => {
    const token = await identity.sign(turn);

    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: 'key-2026-10', typ: 'JWT' });
    const { payload } = await jwtVerify(token, createLocalJWKSet(await publishedKeys()), {
      issuer: ISSUER, audience: 'sts.amazonaws.com', currentDate: new Date(turn.startedAt),
    });
    expect(payload).toEqual({
      iss: ISSUER,
      aud: 'sts.amazonaws.com',
      sub: 'filed-account-1',
      iat: startedAtSeconds,
      exp: startedAtSeconds + 3600,
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/),
      'https://aws.amazon.com/tags': {
        principal_tags: {
          actorId: ['filed-account-1'],
          filingActorId: ['filed-anon-7'],
          sessionId: ['3f2b8c1e-5d4a-4f6b-9c2d-1a2b3c4d5e6f'],
          // The snapshot checkpointer's writes-session prefix (`_writes_session_prefix`) without its trailing dash.
          writesPrefix: ['lgw-3d005e2ccf2461767eb01d780463736c'],
        },
      },
    });
  });

  it('expires one hour after Turn start', async () => {
    const token = await identity.sign(turn);
    const keys = createLocalJWKSet(await publishedKeys());
    const options = { issuer: ISSUER, audience: 'sts.amazonaws.com' };

    await expect(jwtVerify(token, keys, { ...options, currentDate: new Date(Date.parse(turn.startedAt) + 3_599_000) })).resolves.toBeDefined();
    await expect(jwtVerify(token, keys, { ...options, currentDate: new Date(Date.parse(turn.startedAt) + 3_600_000) })).rejects.toThrow('"exp" claim timestamp check failed');
  });

  it('gives each token its own jti', async () => {
    const [first, second] = await Promise.all([identity.sign(turn), identity.sign(turn)]);
    const keys = createLocalJWKSet(await publishedKeys());
    const options = { issuer: ISSUER, audience: 'sts.amazonaws.com', currentDate: new Date(turn.startedAt) };

    expect((await jwtVerify(first, keys, options)).payload.jti).not.toBe((await jwtVerify(second, keys, options)).payload.jti);
  });

  it('is refused when signed by a key the JWKS does not publish', async () => {
    const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const forged = await new SignJWT({ sub: turn.actorId }).setProtectedHeader({ alg: 'ES256', kid: 'key-2026-10' })
      .setIssuer(ISSUER).setAudience('sts.amazonaws.com').setExpirationTime('1h').sign(stranger);

    await expect(jwtVerify(forged, createLocalJWKSet(await publishedKeys()))).rejects.toThrow('signature verification failed');
  });

  it.each([
    ['an actor ID', { actorId: 'actor#1' }],
    ['a filing actor ID', { filingActorId: 'x'.repeat(257) }],
    ['a Session ID', { sessionId: 'session?' }],
  ])('refuses %s that is not a valid AWS session tag value', async (_name, change) => {
    await expect(identity.sign({ ...turn, ...change })).rejects.toThrow(/is not a valid AWS session tag value/);
  });
});

/** The session tags of a Turn identity the Chat Service signed, once it verifies against the published JWKS. */
async function forwardedTags(payload: InvocationPayload): Promise<Record<string, string[]>> {
  const token = payload.forwardedProps.turnIdentity;
  if (typeof token !== 'string') throw new Error('The invocation carries no Turn identity');
  const { payload: claims } = await jwtVerify(token, createLocalJWKSet(await publishedKeys()), { issuer: ISSUER, audience: 'sts.amazonaws.com' });
  return (claims['https://aws.amazon.com/tags'] as { principal_tags: Record<string, string[]> }).principal_tags;
}

const asOwner = (owner: string, path: string, body: unknown) => stack.app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': owner }, body: JSON.stringify(body),
});

describe('Turn identity forwarding', () => {
  it("hands each Turn the Chat Service's own identity under the Session's filing ID, and withholds a stream that carries it", async () => {
    const owner = `owner-${randomUUID()}`;
    const sessionId = randomUUID();
    // A claimed Session: filed under the account it started on.
    await stack.sessionMetadata.recordTurn(owner, sessionId, { filingUserId: 'filed-original', title: 'Claimed' });
    stack.agentcore.script(sessionId, { kind: 'stream', frames: (props) => [
      'data: {"type":"RUN_STARTED"}', `data: ${JSON.stringify({ type: 'RUN_ERROR', message: `STS refused ${String(props.turnIdentity)}` })}`,
    ] });

    const response = await asOwner(owner, '/', {
      threadId: sessionId, runId: randomUUID(), state: {}, tools: [], context: [],
      messages: [{ id: randomUUID(), role: 'user', content: 'hello' }], forwardedProps: { turnIdentity: 'client-sent' },
    });

    const { payload } = stack.agentcore.invocationFor(sessionId);
    expect(await forwardedTags(payload)).toMatchObject({ actorId: [`filed-${owner}`], filingActorId: ['filed-original'], sessionId: [sessionId] });
    const body = await response.text();
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain(payload.forwardedProps.turnIdentity as string);
  });

  it('hands a named warmup the identity its history read needs', async () => {
    const owner = `owner-${randomUUID()}`;
    const sessionId = randomUUID();
    await stack.sessionMetadata.recordTurn(owner, sessionId, { filingUserId: 'filed-original', title: 'Warm' });

    const response = await asOwner(owner, '/warmup', { threadId: sessionId });

    expect(response.status).toBe(200);
    const { payload } = stack.agentcore.invocationFor(sessionId);
    expect(payload.forwardedProps.warmup).toBe(true);
    expect(await forwardedTags(payload)).toMatchObject({ actorId: [`filed-${owner}`], filingActorId: ['filed-original'], sessionId: [sessionId] });
  });

  it("hands a scheduled run the identity of its owner's Side Chat", async () => {
    const owner = `owner-${randomUUID()}`;
    const prompt = `Brief me ${randomUUID()}`;
    const created = await asOwner(owner, '/scheduled-tasks', { title: 'Brief', prompt, schedule: 'rate(1 day)', timezone: 'UTC', proposalId: prompt });
    const { id } = await created.json() as { id: string };

    await defined(stack.scheduler, 'the stack schedules tasks').fire(id);

    const invocation = await vi.waitFor(() => defined(stack.agentcore.invocations()
      .map((request) => JSON.parse(request.body) as InvocationPayload & { messages: { content: unknown }[] })
      .find((payload) => payload.messages.at(-1)?.content === prompt), 'the scheduled invocation'), { timeout: 10_000 });
    expect(await forwardedTags(invocation)).toMatchObject({ actorId: [`filed-${owner}`], filingActorId: [`filed-${owner}`], sessionId: [invocation.threadId] });
  });
});

describe('Turn identity configuration', () => {
  const keys = JSON.stringify([current, next]);

  it('is absent without keys', () => {
    expect(turnIdentityConfigFromEnv({})).toBeUndefined();
  });

  it('reads the issuer and the keys, signing key first', () => {
    expect(turnIdentityConfigFromEnv({ BOTCUBE_PUBLIC_ORIGIN: `${ISSUER}/`, BOTCUBE_TURN_IDENTITY_KEYS: keys })).toEqual({ issuer: ISSUER, keys: [current, next] });
  });

  it.each([
    ['no public origin', { BOTCUBE_TURN_IDENTITY_KEYS: keys }, 'BOTCUBE_PUBLIC_ORIGIN must be an https origin'],
    ['an http origin', { BOTCUBE_PUBLIC_ORIGIN: 'http://chat.example.com', BOTCUBE_TURN_IDENTITY_KEYS: keys }, 'BOTCUBE_PUBLIC_ORIGIN must be an https origin'],
    ['no keys in the list', { BOTCUBE_PUBLIC_ORIGIN: ISSUER, BOTCUBE_TURN_IDENTITY_KEYS: '[]' }, 'BOTCUBE_TURN_IDENTITY_KEYS must be a JSON list of private P-256 JWKs, each with a kid'],
    ['a key without kid', { BOTCUBE_PUBLIC_ORIGIN: ISSUER, BOTCUBE_TURN_IDENTITY_KEYS: JSON.stringify([{ ...current, kid: undefined }]) }, 'BOTCUBE_TURN_IDENTITY_KEYS must be a JSON list of private P-256 JWKs, each with a kid'],
    ['a public key', { BOTCUBE_PUBLIC_ORIGIN: ISSUER, BOTCUBE_TURN_IDENTITY_KEYS: JSON.stringify([{ ...current, d: undefined }]) }, 'BOTCUBE_TURN_IDENTITY_KEYS must be a JSON list of private P-256 JWKs, each with a kid'],
    ['a repeated kid', { BOTCUBE_PUBLIC_ORIGIN: ISSUER, BOTCUBE_TURN_IDENTITY_KEYS: JSON.stringify([current, current]) }, 'BOTCUBE_TURN_IDENTITY_KEYS repeats a kid'],
  ])('fails loud on %s', (_name, env, message) => {
    expect(() => turnIdentityConfigFromEnv(env)).toThrow(message);
  });

  it('fails loud on keys that are not JSON, without quoting them', () => {
    expect(() => turnIdentityConfigFromEnv({ BOTCUBE_PUBLIC_ORIGIN: ISSUER, BOTCUBE_TURN_IDENTITY_KEYS: '{"d":"secret' }))
      .toThrow(/^BOTCUBE_TURN_IDENTITY_KEYS must be a JSON list of private P-256 JWKs, each with a kid$/);
  });
});
