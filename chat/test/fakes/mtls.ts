import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect as tcpConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, getCACertificates, setDefaultCACertificates, type Server, type TLSSocket } from 'node:tls';

/** The SPIFFE ID the stand-in's server certificate carries, as its only identity: no DNS or IP SAN, as a SPIFFE SVID. */
export const SERVER_IDENTITY = 'spiffe://example.org/ns/egress/sa/proxy';
export const IMPOSTOR_IDENTITY = 'spiffe://example.org/ns/other/sa/impostor';
/** One URI SAN whose text embeds the expected identity, which Node prints JSON-quoted (CVE-2021-44532). */
export const SPOOFED_URI = `spiffe://example.org/x, URI:${SERVER_IDENTITY}`;

export interface MtlsCertificates {
  readonly dir: string;
  readonly authority: string;
  /** Each certificate's PEM chain and key file paths, by name. */
  readonly files: Record<'server' | 'impostor' | 'spoof' | 'untrusted' | 'clientA' | 'clientB', { certificate: string; key: string }>;
  pem(name: keyof MtlsCertificates['files']): { cert: string; key: string };
  /** Remove the files. */
  remove(): void;
}

const openssl = (dir: string, ...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
const EC = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1'];

/**
 * A CA, server certificates carrying a URI SAN (`scripts/web-checks/mtls-certificates.sh`, with `subjectAltName=URI:`),
 * one from outside the CA, and two client certificates a rotation swaps between.
 */
export function mtlsCertificates(): MtlsCertificates {
  const dir = mkdtempSync(join(tmpdir(), 'mtls-'));
  openssl(dir, 'req', '-x509', ...EC, '-subj', '/CN=Stand-in CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', 'ca.key', '-out', 'ca.pem');
  const leaf = (name: string, commonName: string, san: string | undefined, usage: string) => {
    openssl(dir, 'req', '-new', ...EC.slice(0, -2), '-subj', `/CN=${commonName}`, ...(san ? ['-addext', `subjectAltName=${san}`] : []),
      '-addext', `extendedKeyUsage=${usage}`, '-keyout', `${name}.key`, '-out', `${name}.csr`);
    openssl(dir, 'x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-copy_extensions', 'copy', '-out', `${name}.pem`);
  };
  leaf('server', 'egress proxy', `URI:${SERVER_IDENTITY}`, 'serverAuth');
  leaf('impostor', 'impostor', `URI:${IMPOSTOR_IDENTITY}`, 'serverAuth');
  writeFileSync(join(dir, 'spoof.ext'), `extendedKeyUsage=serverAuth\nsubjectAltName=@alt\n[alt]\nURI.1 = ${SPOOFED_URI}\n`);
  openssl(dir, 'req', '-new', ...EC.slice(0, -2), '-subj', '/CN=spoof', '-keyout', 'spoof.key', '-out', 'spoof.csr');
  openssl(dir, 'x509', '-req', '-in', 'spoof.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'spoof.ext', '-out', 'spoof.pem');
  leaf('clientA', 'client-a', 'URI:spiffe://example.org/ns/botcube/sa/chat', 'clientAuth');
  leaf('clientB', 'client-b', 'URI:spiffe://example.org/ns/botcube/sa/chat', 'clientAuth');
  openssl(dir, 'req', '-x509', ...EC, '-subj', '/CN=untrusted', '-addext', `subjectAltName=URI:${SERVER_IDENTITY}`, '-keyout', 'untrusted.key', '-out', 'untrusted.pem');
  const pair = (name: string) => ({ certificate: join(dir, `${name}.pem`), key: join(dir, `${name}.key`) });
  const files = { server: pair('server'), impostor: pair('impostor'), spoof: pair('spoof'), untrusted: pair('untrusted'), clientA: pair('clientA'), clientB: pair('clientB') };
  return {
    dir,
    authority: readFileSync(join(dir, 'ca.pem'), 'utf8'),
    files,
    pem: (name) => ({ cert: readFileSync(files[name].certificate, 'utf8'), key: readFileSync(files[name].key, 'utf8') }),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The common name of the client certificate `socket` was opened with. */
function commonName(socket: TLSSocket): string | undefined {
  const name = socket.getPeerCertificate().subject.CN;
  return Array.isArray(name) ? name.join(', ') : name;
}

/** Trust `ca` beside the system roots for this process's later connections, as NODE_EXTRA_CA_CERTS would at startup; returns the undo. */
export function trustCa(ca: string): () => void {
  const before = getCACertificates('default');
  setDefaultCACertificates([...before, ca]);
  return () => setDefaultCACertificates(before);
}

/**
 * An mTLS forward proxy: it asks every client for a certificate from the CA, records each connection's client common
 * name and request head, and answers a CONNECT by tunnelling to the route for its `host:port` (echoing without one).
 */
export class FakeMtlsProxy {
  readonly connections: { client: string | undefined; head: string }[] = [];
  private readonly server: Server;

  constructor(certificates: MtlsCertificates, server: 'server' | 'impostor' | 'spoof' | 'untrusted' = 'server', private readonly routes: Readonly<Record<string, number>> = {}) {
    this.server = createServer({ ...certificates.pem(server), ca: certificates.authority, requestCert: true, rejectUnauthorized: true }, (socket) => this.serve(socket));
    this.server.on('tlsClientError', () => undefined);
  }

  async listen(host: '127.0.0.1' | '::1' = '127.0.0.1'): Promise<URL> {
    await new Promise<void>((resolve) => this.server.listen(0, host, resolve));
    return new URL(`https://${host === '::1' ? '[::1]' : host}:${(this.server.address() as AddressInfo).port}`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** The client certificate's common name on each connection the proxy carried. */
  clients(): (string | undefined)[] {
    return this.connections.map(({ client }) => client);
  }

  /** The `host:port` of each CONNECT the proxy carried. */
  hosts(): string[] {
    return this.connections.flatMap(({ head }) => (head.startsWith('CONNECT ') ? [head.split(' ')[1] ?? ''] : []));
  }

  private serve(socket: TLSSocket): void {
    socket.on('error', () => socket.destroy());
    const client = commonName(socket);
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      const head = buffered.subarray(0, end).toString('latin1');
      const rest = buffered.subarray(end + 4);
      this.connections.push({ client, head });
      if (!head.startsWith('CONNECT ')) {
        socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok');
        return;
      }
      const port = this.routes[head.split(' ')[1] ?? ''];
      if (port === undefined) {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length) socket.write(rest);
        socket.pipe(socket);
        return;
      }
      const target: Socket = tcpConnect(port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length) target.write(rest);
        socket.pipe(target).pipe(socket);
      });
      target.on('error', () => socket.destroy());
      socket.on('close', () => target.destroy());
    };
    socket.on('data', onData);
  }
}

/**
 * An mTLS front for a plain HTTP stand-in, as a gateway terminates TLS in front of the models: it asks every client for
 * a certificate from the CA, records each connection's client common name, and carries the bytes to `target`.
 */
export class FakeMtlsFront {
  readonly clients: (string | undefined)[] = [];
  private readonly server: Server;
  private readonly open = new Set<TLSSocket>();

  constructor(certificates: MtlsCertificates, private readonly target: number, server: 'server' | 'impostor' = 'server') {
    this.server = createServer({ ...certificates.pem(server), ca: certificates.authority, requestCert: true, rejectUnauthorized: true }, (socket) => {
      this.clients.push(commonName(socket));
      this.open.add(socket);
      const upstream = tcpConnect(this.target, '127.0.0.1');
      socket.pipe(upstream).pipe(socket);
      const done = () => {
        this.open.delete(socket);
        socket.destroy();
        upstream.destroy();
      };
      socket.on('error', done).on('close', done);
      upstream.on('error', done).on('close', done);
    });
    this.server.on('tlsClientError', () => undefined);
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as AddressInfo).port;
  }

  /** Close every open connection, so the next request opens a new one. */
  dropConnections(): void {
    for (const socket of this.open) socket.destroy();
  }

  close(): Promise<void> {
    this.dropConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
