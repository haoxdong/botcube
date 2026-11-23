import { X509Certificate } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeMtlsProxy, IMPOSTOR_IDENTITY, mtlsCertificates, SERVER_IDENTITY, SPOOFED_URI, trustCa } from '../test/fakes/mtls.js';
import { endpointTls } from './endpoint-tls.js';
import { startProxyRelay, type ProxyRelay } from './proxy-relay.js';

const certificates = mtlsCertificates();
let untrust: () => void;
beforeAll(() => {
  untrust = trustCa(certificates.authority);
});
afterAll(() => {
  untrust();
  certificates.remove();
});
const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((resource) => resource.close()));
});

/** Opens a tunnel through the relay and reads until the socket ends, sending `tunnelled` once it is answered. */
function tunnel(relay: ProxyRelay, tunnelled = 'hello'): Promise<string> {
  const url = new URL(relay.url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let received = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      const headEnd = received.indexOf('\r\n\r\n');
      if (headEnd === -1) return;
      if (!received.startsWith('HTTP/1.1 200')) return;
      if (received.length === headEnd + 4) socket.write(tunnelled);
      if (received.slice(headEnd + 4) === tunnelled) socket.end();
    });
    socket.on('end', () => resolve(received));
    socket.on('close', () => resolve(received));
    socket.write('CONNECT models.example.com:443 HTTP/1.1\r\nHost: models.example.com:443\r\n\r\n');
  });
}

async function relayThrough(proxy: FakeMtlsProxy, tls: Parameters<typeof endpointTls>[1], env: NodeJS.ProcessEnv = {}) {
  opened.push(proxy);
  const relay = await startProxyRelay({
    upstream: await proxy.listen(), listen: { host: '127.0.0.1', port: 0 }, headers: {}, tls: endpointTls('proxy', tls, { env }),
  });
  opened.push(relay);
  return relay;
}

describe('the proxy relay to a proxy with TLS', () => {
  it('presents the client certificate and tunnels to a proxy carrying the expected identity, which has no hostname SAN', async () => {
    const proxy = new FakeMtlsProxy(certificates);
    const relay = await relayThrough(proxy, { clientCertificate: certificates.files.clientA, serverIdentity: SERVER_IDENTITY });

    expect(await tunnel(relay)).toBe('HTTP/1.1 200 Connection Established\r\n\r\nhello');
    expect(proxy.clients()).toEqual(['client-a']);
    expect(proxy.hosts()).toEqual(['models.example.com:443']);
  });

  it('presents a certificate whose files were replaced on the next connection, without a restart', async () => {
    const files = { certificate: join(certificates.dir, 'rotating.pem'), key: join(certificates.dir, 'rotating.key') };
    copyFileSync(certificates.files.clientA.certificate, files.certificate);
    copyFileSync(certificates.files.clientA.key, files.key);
    const proxy = new FakeMtlsProxy(certificates);
    const relay = await relayThrough(proxy, { clientCertificate: files, serverIdentity: SERVER_IDENTITY });

    await tunnel(relay);
    copyFileSync(certificates.files.clientB.certificate, files.certificate);
    copyFileSync(certificates.files.clientB.key, files.key);
    await tunnel(relay);

    expect(proxy.clients()).toEqual(['client-a', 'client-b']);
  });

  it.each([true, false])('runs one command until the certificate needs refresh (explicit expiry: %s)', async (explicitExpiry) => {
    const printed = join(certificates.dir, 'exec-credential.json');
    const calls = join(certificates.dir, 'certificate-command-calls');
    writeFileSync(calls, '');
    const start = Date.now();
    const expiry = explicitExpiry ? start + 40_000 : new X509Certificate(certificates.pem('clientA').cert).validToDate.getTime();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const print = (name: 'clientA' | 'clientB', expiresAt: number) => {
      const { cert, key } = certificates.pem(name);
      const status = { clientCertificateData: cert, clientKeyData: key, ...(explicitExpiry && { expirationTimestamp: new Date(expiresAt).toISOString() }) };
      writeFileSync(printed, JSON.stringify({ kind: 'ExecCredential', status }));
    };
    print('clientA', expiry);
    const command = [process.execPath, '-e', 'const fs = require("node:fs"); fs.appendFileSync(process.argv[1], "x"); process.stdout.write(fs.readFileSync(process.argv[2]));', calls, printed] as const;
    const proxy = new FakeMtlsProxy(certificates);
    const relay = await relayThrough(proxy, { clientCertificate: { command: [...command], timeoutSeconds: 5 }, serverIdentity: SERVER_IDENTITY }, {
      BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1',
    });

    await tunnel(relay);
    print('clientB', expiry + 600_000);
    await tunnel(relay);
    expect(proxy.clients()).toEqual(['client-a', 'client-a']);

    clock.mockReturnValue(expiry - 10_000);
    await Promise.all([tunnel(relay), tunnel(relay)]);
    expect(proxy.clients()).toEqual(['client-a', 'client-a', 'client-b', 'client-b']);
    expect(readFileSync(calls, 'utf8')).toBe('xx');
  });

  it('refuses a proxy carrying another identity before sending it anything, naming the expected and received identities', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const proxy = new FakeMtlsProxy(certificates, 'impostor');
    const relay = await relayThrough(proxy, { clientCertificate: certificates.files.clientA, serverIdentity: SERVER_IDENTITY });

    const answer = await tunnel(relay);

    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway');
    expect(answer).toContain(`expected server identity ${SERVER_IDENTITY}, but the server presented ${IMPOSTOR_IDENTITY}`);
    expect(proxy.connections).toEqual([]);
    expect(JSON.stringify([answer, errors.mock.calls])).not.toContain('PRIVATE KEY');
  });

  it('refuses a proxy whose one URI SAN only embeds the expected identity in its text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const proxy = new FakeMtlsProxy(certificates, 'spoof');
    const relay = await relayThrough(proxy, { serverIdentity: SERVER_IDENTITY });

    const answer = await tunnel(relay);

    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway');
    expect(answer).toContain(`but the server presented ${SPOOFED_URI}`);
    expect(proxy.connections).toEqual([]);
  });

  it("still verifies the proxy's chain: a certificate carrying the expected identity from outside the trust roots is refused", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const proxy = new FakeMtlsProxy(certificates, 'untrusted');
    const relay = await relayThrough(proxy, { serverIdentity: SERVER_IDENTITY });

    expect(await tunnel(relay)).toBe('');
    expect(proxy.connections).toEqual([]);
  });

  it('does not listen on a client certificate it cannot read, naming the file and no key', async () => {
    const missing = { certificate: certificates.files.clientA.certificate, key: join(certificates.dir, 'missing.key') };
    const relay = startProxyRelay({
      upstream: new URL('https://127.0.0.1:9'), listen: { host: '127.0.0.1', port: 0 }, headers: {}, tls: endpointTls('proxy', { clientCertificate: missing }),
    });

    await expect(relay).rejects.toThrow(`proxy client certificate (file ${missing.key}): ENOENT`);
  });
});

describe('the proxy relay without TLS', () => {
  it('still drops the client with no answer when the proxy is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const relay = await startProxyRelay({ upstream: new URL(`http://127.0.0.1:${port}`), listen: { host: '127.0.0.1', port: 0 }, headers: {} });
    opened.push(relay);

    expect(await tunnel(relay)).toBe('');
  });
});

describe('a client certificate command', () => {
  it('is refused at startup unless the deploy opted in to commands', () => {
    expect(() => endpointTls('proxy', { clientCertificate: { command: ['/bin/cat', '/dev/null'], timeoutSeconds: 5 } }, { env: {} }))
      .toThrow('proxy client certificate (command /bin/cat): a command runs only when BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1');
  });

  it('that prints no certificate fails naming the command, never its output', async () => {
    const printed = join(certificates.dir, 'token-only.json');
    writeFileSync(printed, JSON.stringify({ kind: 'ExecCredential', status: { token: 'not-a-certificate', clientKeyData: '-----BEGIN PRIVATE KEY-----' } }));
    const tls = endpointTls('proxy', { clientCertificate: { command: ['/bin/cat', printed], timeoutSeconds: 5 } }, { env: { BOTCUBE_ALLOW_COMMAND_CREDENTIALS: '1' } });

    const failure = tls.connectOptions();

    await expect(failure).rejects.toThrow(
      'proxy client certificate (command /bin/cat): the command did not print a Kubernetes ExecCredential with status.clientCertificateData and status.clientKeyData',
    );
    await expect(failure).rejects.not.toThrow('PRIVATE KEY');
  });
});
