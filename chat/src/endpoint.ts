import type { Endpoint as EndpointConfig } from 'botcube-deployment-config/blocks';
import { Agent, buildConnector, EnvHttpProxyAgent, Pool, type Dispatcher } from 'undici';
import { credentialSource, type CredentialSource } from './credential-source.js';
import { dispatcherFetch } from './dispatcher-fetch.js';
import { endpointTls, type EndpointTls } from './endpoint-tls.js';

const RETRIED_STATUSES = new Set([502, 503, 504]);
const DROPPED_BEFORE_RESPONSE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;

export interface EndpointRequest {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface Endpoint {
  readonly url: string;
  readonly credential: CredentialSource;
  /**
   * A request to `path` under the Endpoint's URL, with its bearer credential and headers. It retries a 502, 503 or 504, and a
   * connection reset, refused or timed out connecting before the response starts; nothing once the response starts.
   */
  fetch(path: string, init: EndpointRequest): Promise<Response>;
}

export function endpoint(seam: string, config: EndpointConfig, env: NodeJS.ProcessEnv = process.env): Endpoint {
  const credential = credentialSource(seam, config.credential, { env });
  const url = config.url.replace(/\/+$/, '');
  if (config.tls && new URL(url).protocol !== 'https:') throw new Error(`${seam} TLS: the Endpoint ${config.url} is not https`);
  const send = config.tls ? tlsFetch(endpointTls(seam, config.tls, { env }), env) : fetch;
  return {
    url,
    credential,
    async fetch(path, init) {
      const { value } = await credential.get();
      const request = { ...init, headers: { ...init.headers, ...config.headers, authorization: `Bearer ${value}` } };
      for (let attempt = 1; ; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- a retry follows the answer it retries
        const response = await answer(send, `${url}${path}`, request, attempt === ATTEMPTS);
        if (response !== undefined && (!RETRIED_STATUSES.has(response.status) || attempt === ATTEMPTS)) return response;
        // eslint-disable-next-line no-await-in-loop -- a retry follows the answer it retries
        await response?.body?.cancel();
        // eslint-disable-next-line no-await-in-loop -- a retry follows the answer it retries
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    },
  };
}

type SentRequest = EndpointRequest & { headers: Record<string, string> };
type Fetch = (url: string, request: SentRequest) => Promise<Response>;

async function answer(send: Fetch, url: string, request: SentRequest, last: boolean): Promise<Response | undefined> {
  try {
    return await send(url, request);
  } catch (error) {
    if (last || !droppedBeforeResponse(error)) throw error;
    return undefined;
  }
}

function droppedBeforeResponse(error: unknown): boolean {
  return error instanceof TypeError && hasErrorCode(error.cause) && DROPPED_BEFORE_RESPONSE_CODES.has(error.cause.code);
}

function hasErrorCode(cause: unknown): cause is Error & { code: string } {
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string';
}

/**
 * `fetch` presenting the Endpoint's client certificate as read for each new connection, and checking its identity in
 * the handshake, before the bearer is sent. With NODE_USE_ENV_PROXY set, as Node's own `fetch` reads it, the handshake
 * runs through the tunnel of the proxy the environment names.
 */
function tlsFetch(tls: EndpointTls, env: NodeJS.ProcessEnv): Fetch {
  const factory = (origin: string | URL, options: object): Dispatcher => new Pool(origin, { ...options, connect: tlsConnector(tls, proxyTunnel(options)) });
  const dispatcher = env.NODE_USE_ENV_PROXY === '1' ? new EnvHttpProxyAgent({ factory }) : new Agent({ factory });
  return (url, { method, headers, body, signal }) => dispatcherFetch(url, { method, headers, body: body ?? null, signal: signal ?? null, dispatcher });
}

/**
 * The CONNECT tunnel undici's ProxyAgent gives an origin's pool as its `connect` option. ProxyAgent takes its TLS
 * options (`requestTls`) once, when it is built, so a certificate read for each connection is presented over this
 * tunnel instead; undici types the factory's options as `object`, so this adapter is where the tunnel is read from them.
 */
function proxyTunnel(options: object): buildConnector.connector | undefined {
  if (!('connect' in options) || typeof options.connect !== 'function') return undefined;
  const { connect } = options;
  return (connectOptions, callback) => {
    Reflect.apply(connect, undefined, [connectOptions, callback]);
  };
}

/** A connector opening TLS with this connection's certificate, straight to the Endpoint or over the proxy's `tunnel`. */
function tlsConnector(tls: EndpointTls, tunnel: buildConnector.connector | undefined): buildConnector.connector {
  const plain = tunnel ?? buildConnector({});
  return (options, callback) => {
    if (options.protocol !== 'https:') {
      plain(options, callback);
      return;
    }
    tls.connectOptions().then((tlsOptions) => {
      const secure = buildConnector({ ...tlsOptions });
      if (tunnel === undefined) {
        secure(options, callback);
        return;
      }
      const port = options.port || '443';
      tunnel({ ...options, protocol: 'http:', port, host: `${options.hostname}:${port}` }, (error, socket) => {
        if (error) callback(error, null);
        else secure({ ...options, httpSocket: socket }, callback);
      });
    }, (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null));
  };
}
