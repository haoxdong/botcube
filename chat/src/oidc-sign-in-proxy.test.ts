import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotCubeConfig } from 'botcube-config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StandInOidcIssuer } from '../test/fakes/oidc-issuer.js';
import { TunnellingProxy } from '../test/fakes/tunnelling-proxy.js';
import { accountCookies } from './account-cookies.js';
import { oidcIdentity } from './oidc-sign-in.js';

const UI = 'http://localhost:3001/';

describe("the OIDC issuer's calls", () => {
  let issuer: StandInOidcIssuer;
  let proxy: TunnellingProxy;
  let forward: BotCubeConfig['integrations']['proxy'];
  let secret: string;
  beforeAll(async () => {
    issuer = await new StandInOidcIssuer().listen();
    proxy = new TunnellingProxy();
    forward = { kind: 'forward', url: await proxy.listen() };
    secret = join(mkdtempSync(join(tmpdir(), 'oidc-proxy-')), 'client-secret');
    writeFileSync(secret, 'stand-in-client-secret\n');
  });
  afterAll(async () => {
    await proxy.close();
    await issuer.close();
  });
  beforeEach(() => { proxy.targets.length = 0; });

  const signIn = async (named: { proxy?: 'integrations.proxy' }) => {
    const identity: Extract<BotCubeConfig['integrations']['signIn'], { kind: 'oidc' }> = {
      kind: 'oidc', issuer: issuer.url, clients: [{ clientId: 'botcube-web', clientSecret: { kind: 'file', path: secret } }], ...named,
    };
    const { routes } = oidcIdentity(identity, {}, {
      store: () => { throw new Error('a sign-in starts without the account store'); },
      cookies: accountCookies('stand-in'),
      returnOrigins: [new URL(UI).origin],
      proxy: forward,
    });
    return routes.request(`http://chat.test/auth/oidc/login?return_to=${encodeURIComponent(UI)}`);
  };

  it('go through the proxy when integrations.signIn names it', async () => {
    const login = await signIn({ proxy: 'integrations.proxy' });

    expect([login.status, new URL(login.headers.get('location') ?? '').origin]).toEqual([302, issuer.url]);
    expect(proxy.targets).toEqual([new URL(issuer.url).host]);
  });

  it('go direct when integrations.signIn names no proxy', async () => {
    const login = await signIn({});

    expect([login.status, new URL(login.headers.get('location') ?? '').origin]).toEqual([302, issuer.url]);
    expect(proxy.targets).toEqual([]);
  });
});
