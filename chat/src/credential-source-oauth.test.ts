import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpFake, sendJson, type RecordedRequest } from '../test/fakes/http-fake.js';
import { TunnellingProxy } from '../test/fakes/tunnelling-proxy.js';
import { startChatTracing } from './tracing.js';
import { credentialSource } from './credential-source.js';

const START = Date.parse('2026-11-19T12:00:00Z');
const minutes = (count: number) => count * 60_000;
const CLIENT_SECRET = 's3cret-client-value';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function secretFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'credential-oauth-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'client-secret');
  writeFileSync(path, contents);
  return path;
}

async function tokenEndpoint(answer: (request: RecordedRequest, response: ServerResponse, issued: number) => void): Promise<HttpFake> {
  let issued = 0;
  const fake = await new HttpFake((request, response) => answer(request, response, ++issued)).listen();
  cleanups.push(() => fake.close());
  return fake;
}

const issuing = (expiresIn?: number) => (_: RecordedRequest, response: ServerResponse, issued: number) =>
  sendJson(response, 200, { access_token: `idp-token-${issued}`, token_type: 'Bearer', ...(expiresIn === undefined ? {} : { expires_in: expiresIn }) });

/** RFC 6749 section 2.3.1: HTTP Basic over the form-encoded client id and secret. */
const basicCredentials = (authorization: string | string[] | undefined) => {
  const [scheme, encoded] = String(authorization).split(' ');
  if (scheme !== 'Basic' || encoded === undefined) return undefined;
  return Buffer.from(encoded, 'base64').toString().split(':').map((part) => decodeURIComponent(part.replaceAll('+', ' ')));
};

const oauthSource = (tokenUrl: string, scopes?: string[]) => ({
  kind: 'oauth-client-credentials' as const,
  tokenEndpoint: `${tokenUrl}/oauth2/token`,
  clientId: 'botcube-chat',
  clientSecret: { kind: 'file' as const, path: secretFile(CLIENT_SECRET) },
  ...(scopes ? { scopes } : {}),
});

describe('an OAuth client-credentials source', () => {
  it('gets the telemetry token through the proxy named by its Endpoint', async () => {
    const endpoint = await tokenEndpoint(issuing(3600));
    const proxy = new TunnellingProxy();
    const tracing = startChatTracing({
      kind: 'otlp', url: endpoint.url, credential: oauthSource(endpoint.url), proxy: 'integrations.proxy',
    }, { OTEL_TRACES_EXPORTER: 'otlp' }, { kind: 'forward', url: await proxy.listen() });
    try {
      expect(await tracing?.credential?.get()).toMatchObject({ value: 'idp-token-1' });
      expect(proxy.targets).toEqual([new URL(endpoint.url).host]);
    } finally {
      await tracing?.shutdown();
      await proxy.close();
    }
  });

  it("gives the token endpoint's access token until it expires, asking with the client's id and secret and its scopes", async () => {
    const endpoint = await tokenEndpoint(issuing(3600));
    const source = credentialSource('harnessAuth', oauthSource(endpoint.url, ['harness.invoke', 'harness.stop']), { now: () => START });

    expect(await source.get()).toEqual({ value: 'idp-token-1', expiresAt: new Date(START + minutes(60)) });
    const [request] = endpoint.requests;
    expect(request).toMatchObject({ method: 'POST', path: '/oauth2/token' });
    expect(basicCredentials(request?.headers.authorization)).toEqual(['botcube-chat', CLIENT_SECRET]);
    expect(Object.fromEntries(new URLSearchParams(request?.body))).toEqual({ grant_type: 'client_credentials', scope: 'harness.invoke harness.stop' });
  });

  it('asks for no scope when it names none', async () => {
    const endpoint = await tokenEndpoint(issuing(3600));
    await credentialSource('harnessAuth', oauthSource(endpoint.url), { now: () => START }).get();

    expect(Object.fromEntries(new URLSearchParams(endpoint.requests[0]?.body))).toEqual({ grant_type: 'client_credentials' });
  });

  it('asks for a new token a minute before the last one expires', async () => {
    const endpoint = await tokenEndpoint(issuing(600));
    let now = START;
    const source = credentialSource('harnessAuth', oauthSource(endpoint.url), { now: () => now });

    expect((await source.get()).value).toBe('idp-token-1');
    now = START + minutes(4);
    expect((await source.get()).value).toBe('idp-token-1');
    now = START + minutes(9) + 1;
    expect((await source.get()).value).toBe('idp-token-2');
    expect(endpoint.requests).toHaveLength(2);
  });

  it('reads an opaque token the endpoint gave no expiry again after five minutes', async () => {
    const endpoint = await tokenEndpoint(issuing());
    const source = credentialSource('harnessAuth', oauthSource(endpoint.url), { now: () => START });
    expect(await source.get()).toEqual({ value: 'idp-token-1', expiresAt: new Date(START + minutes(5)) });
  });

  it("keeps a JWT the endpoint gave no expiry until the JWT's own exp", async () => {
    const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const jwt = `${segment({ alg: 'RS256' })}.${segment({ exp: (START + minutes(30)) / 1000 })}.signature`;
    const endpoint = await tokenEndpoint((_, response) => sendJson(response, 200, { access_token: jwt, token_type: 'Bearer' }));
    const source = credentialSource('harnessAuth', oauthSource(endpoint.url), { now: () => START });
    expect(await source.get()).toEqual({ value: jwt, expiresAt: new Date(START + minutes(30)) });
  });

  it('fails naming its seam, its endpoint and the OAuth error, on each use, without the secret or the reply', async () => {
    const endpoint = await tokenEndpoint((_, response) =>
      sendJson(response, 401, { error: 'invalid_client', error_description: `client secret ${CLIENT_SECRET} is wrong` }));
    const source = credentialSource('harnessAuth', oauthSource(endpoint.url));
    const named = `harnessAuth credential (oauth-client-credentials ${endpoint.url}/oauth2/token): `;

    const failure = source.get();
    await expect(failure).rejects.toThrow(`${named}the token endpoint answered 401 invalid_client`);
    await expect(failure).rejects.not.toThrow(CLIENT_SECRET);
    await expect(source.get()).rejects.toThrow(named);
    expect(endpoint.requests).toHaveLength(2);
  });

  it('fails on a reply without an access token, without echoing it', async () => {
    const endpoint = await tokenEndpoint((_, response) => sendJson(response, 200, { token: CLIENT_SECRET }));

    const failure = credentialSource('harnessAuth', oauthSource(endpoint.url)).get();
    await expect(failure).rejects.toThrow('the token endpoint did not answer with an access_token');
    await expect(failure).rejects.not.toThrow(CLIENT_SECRET);
  });

  it('fails naming the client secret source when the secret cannot be read, before asking the endpoint', async () => {
    const endpoint = await tokenEndpoint(issuing(3600));
    const source = credentialSource('harnessAuth', { ...oauthSource(endpoint.url), clientSecret: { kind: 'file', path: '/absent/client-secret' } });

    await expect(source.get()).rejects.toThrow(
      `harnessAuth credential (oauth-client-credentials ${endpoint.url}/oauth2/token): client secret (file /absent/client-secret): ENOENT`,
    );
    expect(endpoint.requests).toHaveLength(0);
  });

  it('is refused when its client secret is a command the deploy did not opt in to', () => {
    const source = { ...oauthSource('https://login.example.com'), clientSecret: { kind: 'command' as const, command: ['/usr/local/bin/secret'] as [string], timeoutSeconds: 30 } };

    expect(() => credentialSource('harnessAuth', source, { env: {} })).toThrow(
      'harnessAuth credential (oauth-client-credentials https://login.example.com/oauth2/token): client secret (command /usr/local/bin/secret): a command credential runs only when BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1',
    );
  });
});
