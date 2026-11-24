import { mkdtempSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotCubeConfig } from 'botcube-config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StandInOidcIssuer } from '../test/fakes/oidc-issuer.js';
import { accountCookies } from './account-cookies.js';
import { oidcIdentity } from './oidc-sign-in.js';

/** A forward proxy that records the host of each request it carries: a CONNECT's tunnel, or a plain request in absolute form. */
class TunnellingProxy {
  readonly targets: string[] = [];
  private readonly server: Server = createServer((socket) => this.serve(socket));

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${address.port}`;
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private readonly sockets = new Set<Socket>();

  private serve(client: Socket): void {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => client.destroy());
    client.once('data', (head: Buffer) => {
      const [method = '', target = ''] = head.toString('latin1').split(' ');
      const tunnel = method === 'CONNECT';
      const host = tunnel ? target : new URL(target).host;
      this.targets.push(host);
      const [hostname = '', port = ''] = host.split(':');
      const upstream = connect(Number(port), hostname, () => {
        if (tunnel) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        else upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
    });
  }
}

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
