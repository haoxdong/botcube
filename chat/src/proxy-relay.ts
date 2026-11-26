import { once } from 'node:events';
import { connect as tcpConnect, createServer, type Socket } from 'node:net';
import { urlToHttpOptions } from 'node:url';
import type { BotCubeConfig } from 'botcube-config';
import type { CustomFetch } from 'openid-client';
import { ProxyAgent } from 'undici';
import { dispatcherFetch } from './dispatcher-fetch.js';
import { credentialSource, type CredentialSource } from './credential-source.js';
import { endpointTls, EndpointTlsError, type EndpointTls } from './endpoint-tls.js';

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
  /** The client certificate presented to the proxy and the identity it must carry; absent, plain TLS to an https proxy. */
  tls?: EndpointTls | undefined;
}

/** Serve `listen` as a forward proxy that sends each request on to `upstream`, authenticated. */
export async function startProxyRelay({ upstream, listen, credential, headers, tls }: ProxyRelayOptions): Promise<ProxyRelay> {
  const server = createServer((client) => {
    client.on('error', () => client.destroy());
    readHead(client)
      .then(async ({ head, rest }) => {
        const authorization = credential ? `Bearer ${(await credential.get()).value}` : undefined;
        await relay(client, upstream, rewrite(head, authorization, headers), rest, tls);
      })
      .catch((error: unknown) => refuse(client, `could not open a request through ${upstream.origin}`, error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => resolve());
  });
  server.unref();
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The proxy relay has no TCP address');
  return {
    url: `http://${listen.host}:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Where a client reaches the BotCube Config's proxy: its URL, or this process's loopback relay to it. */
export type ProxyUrl = () => Promise<string>;

const relays = new Map<string, Promise<string>>();

/**
 * Where this process's clients reach the BotCube Config's `proxy`, or undefined without one: the proxy's own URL, or,
 * for a proxy taking a credential, headers or TLS, one loopback relay per process, started when first asked for.
 */
export function proxyUrl(proxy: BotCubeConfig['integrations']['proxy'], env: NodeJS.ProcessEnv = process.env): ProxyUrl | undefined {
  if (proxy.kind === 'none') return undefined;
  if (proxy.credential === undefined && proxy.headers === undefined && proxy.tls === undefined) return async () => proxy.url;
  const key = JSON.stringify(proxy);
  return () => {
    const running = relays.get(key);
    if (running) return running;
    const started = startProxyRelay({
      upstream: new URL(proxy.url),
      listen: { host: '127.0.0.1', port: 0 },
      credential: proxy.credential && credentialSource('proxy', proxy.credential, { env }),
      headers: proxy.headers ?? {},
      tls: proxy.tls && endpointTls('proxy', proxy.tls, { env }),
    }).then((relay) => relay.url, (error: unknown) => {
      relays.delete(key);
      throw error;
    });
    relays.set(key, started);
    return started;
  };
}

/** `fetch` through the proxy `through` names, its agent built on the first request and again after a failed start. */
export function proxiedFetch(through: ProxyUrl): CustomFetch {
  let agent: Promise<ProxyAgent> | undefined;
  const built = () => (agent ??= through().then((uri) => new ProxyAgent(uri), (error: unknown) => {
    agent = undefined;
    throw error;
  }));
  return async (url, { method, headers, body, redirect, signal }) =>
    dispatcherFetch(url, { method, headers, body: body ?? null, redirect, signal: signal ?? null, dispatcher: await built() });
}

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

function refuse(client: Socket, doing: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Proxy relay ${doing}: ${message}`);
  client.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(message)}\r\nconnection: close\r\n\r\n${message}`);
}

const DEFAULT_TLS = endpointTls('proxy');

async function relay(client: Socket, upstream: URL, head: string, rest: Buffer, tls: EndpointTls | undefined): Promise<void> {
  const { protocol, hostname: host, port } = urlToHttpOptions(upstream);
  if (!host) throw new TypeError('The forward proxy URL must include a hostname');
  const secure = protocol === 'https:';
  const address = { host, port: Number(port ?? (secure ? 443 : 80)) };
  let proxy: Socket;
  try {
    if (secure) {
      proxy = await (tls ?? DEFAULT_TLS).secure(address, host);
    } else {
      proxy = tcpConnect(address);
      await once(proxy, 'connect');
    }
  } catch (error) {
    if (error instanceof EndpointTlsError) {
      refuse(client, `refused ${upstream.origin}`, error);
      return;
    }
    console.error(`Proxy relay could not reach ${upstream.origin}: ${error instanceof Error ? error.message : String(error)}`);
    client.destroy();
    return;
  }

  proxy.on('error', (error) => {
    console.error(`Proxy relay could not reach ${upstream.origin}: ${error.message}`);
    client.destroy();
  });
  if (client.destroyed) {
    proxy.destroy();
    return;
  }
  client.on('close', () => proxy.destroy());
  proxy.on('close', () => client.end().resume());
  proxy.write(head);
  if (rest.length) proxy.write(rest);
  client.pipe(proxy).pipe(client);
  client.resume();
}
