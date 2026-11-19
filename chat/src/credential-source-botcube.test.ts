import { generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { credentialSource } from './credential-source.js';
import { TurnIdentity } from './turn-identity.js';

const ISSUER = 'https://chat.example.com';
const key: JsonWebKey = { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'key-1' };
const identity = new TurnIdentity({ issuer: ISSUER, keys: [key] });
const verify = (token: string, audience: string) => jwtVerify(token, createLocalJWKSet(identity.jwks()), { issuer: ISSUER, audience });

describe('a botcube credential source', () => {
  it('gives a token the Chat Service signs for its audience, until the token expires', async () => {
    const source = credentialSource('harnessAuth', { kind: 'botcube', audience: 'botcube-harness' }, { botcube: identity });

    const { value, expiresAt } = await source.get();
    const { payload } = await verify(value, 'botcube-harness');
    expect(payload).toMatchObject({ iss: ISSUER, aud: 'botcube-harness', sub: 'botcube-chat-service' });
    expect(expiresAt).toEqual(new Date((payload.exp ?? 0) * 1000));
  });

  it('signs a new token a minute before the last one expires', async () => {
    let now = Date.now();
    const source = credentialSource('harnessAuth', { kind: 'botcube', audience: 'botcube-harness' }, { botcube: identity, now: () => now });
    const first = await source.get();

    now = (first.expiresAt?.getTime() ?? 0) - 60_000 - 1;
    expect(await source.get()).toBe(first);
    now += 2;
    const next = await source.get();
    expect(next.value).not.toBe(first.value);
    expect((await verify(next.value, 'botcube-harness')).payload.sub).toBe('botcube-chat-service');
  });

  it('signs nothing for an audience reserved for another kind of BotCube token, naming its seam', async () => {
    const source = credentialSource('telemetry.credential', { kind: 'botcube', audience: 'sts.amazonaws.com' }, { botcube: identity });

    await expect(source.get()).rejects.toThrow(
      'telemetry.credential credential (botcube sts.amazonaws.com): The Harness audience sts.amazonaws.com is reserved for another kind of BotCube token',
    );
  });

  it('stops at once in a process without the Turn identity keys that sign it, as the Harness is', () => {
    expect(() => credentialSource('telemetry.credential', { kind: 'botcube', audience: 'collector' })).toThrow(
      'telemetry.credential credential (botcube collector): only the Chat Service signs a botcube token, with its Turn identity keys',
    );
  });
});
