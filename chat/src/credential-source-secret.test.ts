import { randomUUID } from 'node:crypto';
import { CreateSecretCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterAll, describe, expect, it } from 'vitest';
import { motoAws } from '../test/fakes/moto.js';
import { credentialSource } from './credential-source.js';

const client = new SecretsManagerClient(motoAws());
afterAll(() => client.destroy());

async function secret(value: string): Promise<string> {
  const { ARN } = await client.send(new CreateSecretCommand({ Name: `models-api-key-${randomUUID()}`, SecretString: value }));
  if (!ARN) throw new Error('moto created a secret without an ARN');
  return ARN;
}

const START = Date.parse('2026-11-19T12:00:00Z');
const minutes = (count: number) => count * 60_000;
const options = (now: () => number) => ({ now, env: { AWS_ENDPOINT_URL_SECRETS_MANAGER: motoAws().endpoint } });

describe('a Secrets Manager credential source', () => {
  it("gives the secret's string until five minutes on", async () => {
    const secretArn = await secret('sk-from-secret');
    const source = credentialSource('models', { kind: 'secret', secretArn }, options(() => START));

    expect(await source.get()).toEqual({ value: 'sk-from-secret', expiresAt: new Date(START + minutes(5)) });
  });

  it('reads the secret again a minute before its value expires, picking up a rotation', async () => {
    const secretArn = await secret('sk-first');
    let now = START;
    const source = credentialSource('models', { kind: 'secret', secretArn }, options(() => now));
    await source.get();
    await client.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: 'sk-rotated' }));

    now = START + minutes(2);
    expect((await source.get()).value).toBe('sk-first');
    now = START + minutes(4) + 1;
    expect((await source.get()).value).toBe('sk-rotated');
  });

  it('fails naming its seam and its secret, on each use while the secret cannot be read', async () => {
    const secretArn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:absent-${randomUUID()}`;
    const source = credentialSource('models', { kind: 'secret', secretArn }, options(Date.now));

    await expect(source.get()).rejects.toThrow(new RegExp(`^models credential \\(secret ${secretArn}\\): Secrets Manager can.t find the specified secret`));
    await expect(source.get()).rejects.toThrow(`models credential (secret ${secretArn})`);
  });
});
