import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialSource, type CredentialSource } from './credential-source.js';
import { startProxyRelay, startProxyRelayForConfig, type ProxyRelay } from './proxy-relay.js';

/** An authenticating forward proxy: records each request head, then answers a CONNECT and echoes the tunnel. */
class FakeUpstreamProxy {
  readonly heads: string[] = [];
  private readonly server: Server = createServer((socket) => this.serve(socket));

  async listen(): Promise<URL> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return new URL(`http://127.0.0.1:${address.port}`);
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
function exchange(relay: ProxyRelay, head: string, tunnelled?: string): Promise<string> {
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

async function relayTo(options: Omit<Parameters<typeof startProxyRelay>[0], 'upstream' | 'listen'>) {
  const upstream = new FakeUpstreamProxy();
  opened.push(upstream);
  const relay = await startProxyRelay({ ...options, upstream: await upstream.listen(), listen: { host: '127.0.0.1', port: 0 } });
  opened.push(relay);
  return { upstream, relay };
}

describe('the proxy relay', () => {
  it("opens each tunnel through the operator's proxy with the credential's current value and the Endpoint's headers", async () => {
    // The relay reads the credential once as it starts.
    const { upstream, relay } = await relayTo({ credential: values('startup', 'first', 'rotated'), headers: { 'x-tenant': 'botcube-example' } });

    const answer = await exchange(relay, 'CONNECT models.example.com:443 HTTP/1.1\r\nHost: models.example.com:443\r\nProxy-Authorization: Basic stale\r\n\r\n', 'hello');
    await exchange(relay, 'CONNECT models.example.com:443 HTTP/1.1\r\nHost: models.example.com:443\r\n\r\n', 'again');

    expect(answer).toBe('HTTP/1.1 200 Connection Established\r\n\r\nhello');
    expect(upstream.heads.map((head) => head.split('\r\n')[0])).toEqual(['CONNECT models.example.com:443 HTTP/1.1', 'CONNECT models.example.com:443 HTTP/1.1']);
    expect(upstream.heads.map((head) => header(head, 'proxy-authorization'))).toEqual([['Bearer first'], ['Bearer rotated']]);
    expect(upstream.heads.map((head) => header(head, 'x-tenant'))).toEqual([['botcube-example'], ['botcube-example']]);
  });

  it('authenticates a plain HTTP request it forwards, one request to a connection', async () => {
    const { upstream, relay } = await relayTo({ credential: values('token'), headers: {} });

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

  it('answers 502 naming the credential, and opens nothing upstream, when the credential fails after it started', async () => {
    let started = false;
    const failing: CredentialSource = { get: async () => {
      if (started) throw new Error('proxy.credential credential (file /run/secrets/proxy): ENOENT');
      started = true;
      return { value: 'startup', expiresAt: undefined };
    } };
    const { upstream, relay } = await relayTo({ credential: failing, headers: {} });

    const answer = await exchange(relay, 'CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n');

    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway');
    expect(answer).toContain('proxy.credential credential (file /run/secrets/proxy): ENOENT');
    expect(upstream.heads).toEqual([]);
  });
});

describe('the proxy relay at startup', () => {
  it('does not listen on a credential it cannot read, naming the seam and the source', async () => {
    const path = `/nonexistent/proxy-token-${Math.random().toString(36).slice(2)}`;
    const relay = startProxyRelay({
      upstream: new URL('http://127.0.0.1:9'), listen: { host: '127.0.0.1', port: 0 },
      credential: credentialSource('proxy', { kind: 'file', path }), headers: {},
    });
    await expect(relay).rejects.toThrow(`proxy credential (file ${path}): ENOENT`);
  });

  it("relays the BotCube Config's proxy where HTTPS_PROXY points, with its credential and headers", async () => {
    const path = `/nonexistent/proxy-token-${Math.random().toString(36).slice(2)}`;
    const relay = startProxyRelayForConfig(
      { kind: 'forward', url: 'http://127.0.0.1:9', credential: { kind: 'file', path }, headers: { 'x-tenant': 'a' } },
      { HTTPS_PROXY: 'http://127.0.0.1:0' },
    );
    await expect(relay).rejects.toThrow(`proxy credential (file ${path}): ENOENT`);
  });

  it.each([{ kind: 'none' } as const, { kind: 'forward', url: 'http://proxy.example.com:3128' } as const])('needs no relay for %j', (proxy) => {
    expect(startProxyRelayForConfig(proxy, { HTTPS_PROXY: 'http://proxy.example.com:3128' })).toBeUndefined();
  });

  it('needs HTTPS_PROXY pointed at the relay beside a proxy credential or headers', () => {
    expect(() => startProxyRelayForConfig({ kind: 'forward', url: 'http://proxy.example.com:3128', headers: { 'x-tenant': 'a' } }, {}))
      .toThrow("HTTPS_PROXY is unset beside the BotCube Config's proxy credential, headers or TLS");
  });
});
