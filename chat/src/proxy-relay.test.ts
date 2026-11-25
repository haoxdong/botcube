import { readFileSync } from 'node:fs';
import { connect, createServer, Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialSource, type CredentialSource } from './credential-source.js';
import { proxyUrl, startProxyRelay, type ProxyRelay } from './proxy-relay.js';

/** An authenticating forward proxy: records each request head, then answers a CONNECT and echoes the tunnel. */
class FakeUpstreamProxy {
  readonly heads: string[] = [];
  private readonly server: Server = createServer((socket) => this.serve(socket));

  async listen(host: '127.0.0.1' | '::1' = '127.0.0.1'): Promise<URL> {
    await new Promise<void>((resolve) => this.server.listen(0, host, resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return new URL(`http://${host === '::1' ? '[::1]' : host}:${address.port}`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private serve(socket: Socket): void {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const head = buffered.subarray(0, end).toString('latin1');
      this.heads.push(head);
      if (head.startsWith('CONNECT ')) {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.pipe(socket);
      } else {
        socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok');
      }
    };
    socket.on('data', onData);
  }
}

/** Sends `head` through the relay and reads until the socket ends; with `tunnelled`, sends it once answered and ends on its echo. */
function exchange(relay: Pick<ProxyRelay, 'url'>, head: string, tunnelled?: string): Promise<string> {
  const url = new URL(relay.url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let received = '';
    let sent = false;
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      const headEnd = received.indexOf('\r\n\r\n');
      if (tunnelled === undefined || headEnd === -1) return;
      if (!sent) {
        sent = true;
        socket.write(tunnelled);
      }
      if (received.slice(headEnd + 4) === tunnelled) socket.end();
    });
    socket.on('end', () => resolve(received));
    socket.write(head);
  });
}

const header = (head: string, name: string) =>
  head.split('\r\n').filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`)).map((line) => line.slice(name.length + 1).trim());

const values = (...tokens: string[]): CredentialSource & { calls: number } => {
  const source = { calls: 0, get: async () => ({ value: tokens[Math.min(source.calls++, tokens.length - 1)] ?? '', expiresAt: undefined }) };
  return source;
};

const opened: { close(): Promise<void> }[] = [];
afterEach(() => Promise.all(opened.splice(0).map((resource) => resource.close())));

async function relayTo(options: Omit<Parameters<typeof startProxyRelay>[0], 'upstream' | 'listen'>, host?: Parameters<FakeUpstreamProxy['listen']>[0]) {
  const upstream = new FakeUpstreamProxy();
  opened.push(upstream);
  const relay = await startProxyRelay({ ...options, upstream: await upstream.listen(host), listen: { host: '127.0.0.1', port: 0 } });
  opened.push(relay);
  return { upstream, relay };
}

describe('the proxy relay', () => {
  it("opens each tunnel through the operator's proxy with the credential's current value and the Endpoint's headers", async () => {
    const { upstream, relay } = await relayTo({ credential: values('first', 'rotated'), headers: { 'x-tenant': 'botcube-example' } });

    const answer = await exchange(relay, 'CONNECT models.example.com:443 HTTP/1.1\r\nHost: models.example.com:443\r\nProxy-Authorization: Basic stale\r\n\r\n', 'hello');
    await exchange(relay, 'CONNECT models.example.com:443 HTTP/1.1\r\nHost: models.example.com:443\r\n\r\n', 'again');

    expect(answer).toBe('HTTP/1.1 200 Connection Established\r\n\r\nhello');
    expect(upstream.heads.map((head) => head.split('\r\n')[0])).toEqual(['CONNECT models.example.com:443 HTTP/1.1', 'CONNECT models.example.com:443 HTTP/1.1']);
    expect(upstream.heads.map((head) => header(head, 'proxy-authorization'))).toEqual([['Bearer first'], ['Bearer rotated']]);
    expect(upstream.heads.map((head) => header(head, 'x-tenant'))).toEqual([['botcube-example'], ['botcube-example']]);
  });

  it.each(['127.0.0.1', '::1'] as const)('authenticates a plain HTTP request it forwards over %s', async (host) => {
    const { upstream, relay } = await relayTo({ credential: values('token'), headers: {} }, host);

    const answer = await exchange(relay, 'POST http://collector.example.com:4318/v1/traces HTTP/1.1\r\nHost: collector.example.com:4318\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n');

    expect(answer).toContain('HTTP/1.1 200 OK');
    const [head = ''] = upstream.heads;
    expect(head.split('\r\n')[0]).toBe('POST http://collector.example.com:4318/v1/traces HTTP/1.1');
    expect([header(head, 'proxy-authorization'), header(head, 'connection')]).toEqual([['Bearer token'], ['close']]);
  });

  it("sends only the Endpoint's headers without a credential", async () => {
    const { upstream, relay } = await relayTo({ headers: { 'x-route': 'egress-a' } });

    await exchange(relay, 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n', 'x');

    expect([header(upstream.heads[0] ?? '', 'proxy-authorization'), header(upstream.heads[0] ?? '', 'x-route')]).toEqual([[], ['egress-a']]);
  });

  it('listens without reading the credential, and answers 502 naming it, opening nothing upstream, when it cannot be read', async () => {
    const path = `/nonexistent/proxy-token-${Math.random().toString(36).slice(2)}`;
    const { upstream, relay } = await relayTo({ credential: credentialSource('proxy', { kind: 'file', path }), headers: {} });

    const answer = await exchange(relay, 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n');

    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway');
    expect(answer).toContain(`proxy credential (file ${path}): ENOENT`);
    expect(upstream.heads).toEqual([]);
  });
});

describe("the BotCube Config's proxy in a process", () => {
  const cases: [Parameters<typeof proxyUrl>[0], string | null][] = JSON.parse(
    readFileSync(new URL('../../tests/fixtures/proxy-url.json', import.meta.url), 'utf8'),
  );
  it.each(cases)('resolves and reuses the URL for %j', async (proxy, expected) => {
    const result = await proxyUrl(proxy)?.();
    if (expected?.endsWith(':')) {
      const port = result?.slice(expected.length);
      expect(port).toMatch(/^\d+$/);
      expect(result).toBe(expected + port);
    } else expect(result).toBe(expected ?? undefined);
    expect(await proxyUrl(proxy)?.()).toBe(result);
  });

  it('starts a new relay after a failed listen', async () => {
    const upstream = new FakeUpstreamProxy();
    opened.push(upstream);
    const url = proxyUrl({ kind: 'forward', url: (await upstream.listen()).href, headers: { 'x-route': 'retry' } });
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
      process.nextTick(() => this.emit('error', new Error('relay could not listen')));
      return this;
    });
    try {
      await expect(url?.()).rejects.toThrow('relay could not listen');
      const [relay, concurrent] = await Promise.all([url?.(), url?.()]);
      expect(relay).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(concurrent).toBe(relay);
      const answer = await exchange({ url: relay ?? '' }, 'GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\n\r\n');
      expect(answer).toContain('HTTP/1.1 200 OK');
      expect(header(upstream.heads[0] ?? '', 'x-route')).toEqual(['retry']);
    } finally {
      listen.mockRestore();
    }
  });

  it('is one loopback relay, started when first asked for, with the credential and headers', async () => {
    const upstream = new FakeUpstreamProxy();
    opened.push(upstream);
    const proxy = { kind: 'forward', url: (await upstream.listen()).href, headers: { 'x-tenant': 'a' }, credential: { kind: 'file', path: `/nonexistent/${Math.random()}` } } as const;
    const url = proxyUrl(proxy);

    const relay = await url?.();
    expect(relay).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await url?.()).toBe(relay);
    expect(await proxyUrl(proxy)?.()).toBe(relay);
    const answer = await exchange({ url: relay ?? '' }, 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n');
    expect(answer).toContain(`proxy credential (file ${proxy.credential.path}): ENOENT`);
  });
});
