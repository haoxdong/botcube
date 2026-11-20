import { connect as tcpConnect, createServer, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { DeploymentConfig } from 'botcube-deployment-config';
import { credentialSource, type CredentialSource } from './credential-source.js';

// The proxy Endpoint's credential and headers (ADR 0091). Every HTTP client in a process, and every command it runs,
// reads HTTP(S)_PROXY once, so the process points them at this loopback relay, which opens each request to the
// operator's proxy with the credential's current value: a rotated or refreshed token reaches the next request.
// botcube/harness has its Python twin.

/** The most a client's request head may take before the relay refuses it. */
const MAX_HEAD_BYTES = 64 * 1024;
/** Request headers the relay sets itself, dropping a client's. */
const REPLACED = new Set(['proxy-authorization', 'proxy-connection', 'connection']);

export interface ProxyRelay {
  /** The proxy URL the process's clients use, as HTTP(S)_PROXY. */
  readonly url: string;
  close(): Promise<void>;
}

export interface ProxyRelayOptions {
  /** The operator's forward proxy. */
  upstream: URL;
  /** Where the relay listens; port 0 picks a free one. */
  listen: { host: string; port: number };
  /** Sent as `Proxy-Authorization: Bearer <value>`; absent, the proxy takes no credential. */
  credential?: CredentialSource | undefined;
  headers: Readonly<Record<string, string>>;
}

/** Serve `listen` as a forward proxy that sends each request on to `upstream`, authenticated. */
export async function startProxyRelay({ upstream, listen, credential, headers }: ProxyRelayOptions): Promise<ProxyRelay> {
  await credential?.get();
  const server = createServer((client) => {
    client.on('error', () => client.destroy());
    readHead(client)
      .then(async ({ head, rest }) => {
        const authorization = credential ? `Bearer ${(await credential.get()).value}` : undefined;
        relay(client, upstream, rewrite(head, authorization, headers), rest);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Proxy relay could not open a request through ${upstream.origin}: ${message}`);
        client.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(message)}\r\nconnection: close\r\n\r\n${message}`);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The proxy relay has no TCP address');
  return {
    url: `http://${listen.host}:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * The relay for the Deployment Config's `proxy`, listening where HTTPS_PROXY points (`proxyEnvironment` in
 * botcube/deployment-config) before any client connects; undefined unless the proxy takes a credential or headers.
 * A relay that cannot listen stops the process.
 */
export function startProxyRelayForConfig(proxy: DeploymentConfig['proxy'], env: NodeJS.ProcessEnv = process.env): Promise<ProxyRelay> | undefined {
  if (proxy.kind === 'none' || (proxy.credential === undefined && proxy.headers === undefined)) return undefined;
  const listen = env.HTTPS_PROXY ? new URL(env.HTTPS_PROXY) : undefined;
  if (listen === undefined || !listen.hostname || !listen.port) {
    throw new Error("HTTPS_PROXY is unset beside the Deployment Config's proxy credential or headers; the deploy points it at the proxy relay");
  }
  return startProxyRelay({
    upstream: new URL(proxy.url),
    listen: { host: listen.hostname, port: Number(listen.port) },
    credential: proxy.credential && credentialSource('proxy', proxy.credential, { env }),
    headers: proxy.headers ?? {},
  });
}

/** The client's request head, up to its blank line, and any bytes after it. */
function readHead(client: Socket): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffered.length > MAX_HEAD_BYTES) done(new Error(`the request head is over ${MAX_HEAD_BYTES} bytes`));
        return;
      }
      client.pause();
      done(undefined, { head: buffered.subarray(0, end).toString('latin1'), rest: buffered.subarray(end + 4) });
    };
    const onEnd = () => done(new Error('the client closed before its request head ended'));
    const done = (error?: Error, value?: { head: string; rest: Buffer }) => {
      client.off('data', onData).off('end', onEnd);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    client.on('data', onData).on('end', onEnd);
  });
}

/**
 * The head with the client's own proxy credential dropped and the relay's credential and headers set. A plain HTTP
 * request is sent `Connection: close`, so each one opens its own authenticated connection.
 */
function rewrite(head: string, authorization: string | undefined, headers: Readonly<Record<string, string>>): string {
  const [requestLine = '', ...lines] = head.split('\r\n');
  const kept = lines.filter((line) => !REPLACED.has(line.slice(0, line.indexOf(':')).trim().toLowerCase()));
  const added = [
    ...(authorization ? [`Proxy-Authorization: ${authorization}`] : []),
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ...(requestLine.startsWith('CONNECT ') ? [] : ['Connection: close']),
  ];
  return [requestLine, ...kept, ...added, '', ''].join('\r\n');
}

/** Send `head` and `rest` to the operator's proxy, then carry bytes both ways until either side closes. */
function relay(client: Socket, upstream: URL, head: string, rest: Buffer): void {
  const port = Number(upstream.port) || (upstream.protocol === 'https:' ? 443 : 80);
  const proxy = upstream.protocol === 'https:'
    ? tlsConnect({ host: upstream.hostname, port, servername: upstream.hostname })
    : tcpConnect(port, upstream.hostname);
  proxy.on('error', (error) => {
    console.error(`Proxy relay could not reach ${upstream.origin}: ${error.message}`);
    client.destroy();
  });
  client.on('close', () => proxy.destroy());
  proxy.write(head);
  if (rest.length) proxy.write(rest);
  client.pipe(proxy).pipe(client);
  client.resume();
}
