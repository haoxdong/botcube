import { describe, expect, it } from 'vitest';
import { motoEndpoint } from '../test/fakes/moto.js';
import { credentialSource } from './credential-source.js';

const START = Date.parse('2026-11-19T12:00:00Z');
const minutes = (count: number) => count * 60_000;

interface SignedRequest { url: string; method: string; headers: { key: string; value: string }[] }
const signedRequest = (value: string) => JSON.parse(decodeURIComponent(value)) as SignedRequest;
const header = ({ headers }: SignedRequest, name: string) => headers.find(({ key }) => key.toLowerCase() === name)?.value;

/** What STS answers the receiver that replays the signed request, as a service trusting AWS identities does. */
async function replay(request: SignedRequest): Promise<string> {
  const headers = request.headers.filter(({ key }) => key.toLowerCase() !== 'host').map(({ key, value }): [string, string] => [key, value]);
  const response = await fetch(request.url, { method: request.method, headers });
  return await response.text();
}

describe('an aws credential source', () => {
  it("gives the process's own AWS identity as a signed sts:GetCallerIdentity request, its audience signed in, for fifteen minutes", async () => {
    const source = credentialSource('telemetry.credential', { kind: 'aws', audience: 'collector.example.com' }, {
      now: () => START,
      env: { AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_STS: motoEndpoint() },
    });

    const { value, expiresAt } = await source.get();
    const request = signedRequest(value);
    expect(request).toMatchObject({ method: 'POST', url: `${motoEndpoint()}/?Action=GetCallerIdentity&Version=2011-06-15` });
    expect(header(request, 'x-botcube-audience')).toBe('collector.example.com');
    expect(header(request, 'authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAPARITYSUITE\/\d{8}\/us-east-1\/sts\/aws4_request, SignedHeaders=[^,]*x-botcube-audience/);
    expect(await replay(request)).toContain('<Arn>arn:aws:sts::');
    expect(expiresAt).toEqual(new Date(START + minutes(15)));
  });

  it("signs STS's regional endpoint in the process's region", async () => {
    const source = credentialSource('telemetry.credential', { kind: 'aws', audience: 'collector.example.com' }, { env: { AWS_REGION: 'eu-west-2' } });

    expect(signedRequest((await source.get()).value).url).toBe('https://sts.eu-west-2.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15');
  });

  it('signs again a minute before the signature expires', async () => {
    let now = START;
    const source = credentialSource('telemetry.credential', { kind: 'aws', audience: 'collector.example.com' }, { now: () => now, env: { AWS_REGION: 'us-east-1' } });
    const first = await source.get();

    now = START + minutes(14) - 1;
    expect(await source.get()).toBe(first);
    now = START + minutes(14) + 1;
    expect((await source.get()).expiresAt).toEqual(new Date(now + minutes(15)));
  });
});
