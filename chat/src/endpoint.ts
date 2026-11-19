import type { Endpoint as EndpointConfig } from 'botcube-deployment-config/blocks';
import { credentialSource, type CredentialSource } from './credential-source.js';

// The Endpoint's one retry rule (ADR 0091), as the Harness's `llm.py` keeps it: an answer before any body, a gateway's or a dropped connection's.
const RETRIED_STATUSES = new Set([502, 503, 504]);
// The codes `fetch` rejects with when it fails to connect, or the connection drops before the response starts.
const DROPPED_CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;

export interface Endpoint {
  readonly url: string;
  readonly credential: CredentialSource;
  /**
   * A request to `path` under the Endpoint's URL, with its bearer credential and headers. It retries an answer before any body:
   * a 502, 503 or 504, or a connection that fails or drops before the response starts. Nothing is retried once the response starts.
   */
  fetch(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response>;
}

export function endpoint(seam: string, config: EndpointConfig, env: NodeJS.ProcessEnv = process.env): Endpoint {
  const credential = credentialSource(seam, config.credential, { env });
  const url = config.url.replace(/\/+$/, '');
  return {
    url,
    credential,
    async fetch(path, init) {
      const { value } = await credential.get();
      const request = { ...init, headers: { ...init.headers, ...config.headers, authorization: `Bearer ${value}` } };
      for (let attempt = 1; ; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- a retry follows the answer it retries
        const response = await answer(`${url}${path}`, request, attempt === ATTEMPTS);
        if (response !== undefined && (!RETRIED_STATUSES.has(response.status) || attempt === ATTEMPTS)) return response;
        // eslint-disable-next-line no-await-in-loop -- a retry follows the answer it retries
        await response?.body?.cancel();
        // eslint-disable-next-line no-await-in-loop -- a retry follows the answer it retries
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    },
  };
}

/** The response's start, or undefined for a connection that failed or dropped before it, unless this is the last attempt. */
async function answer(url: string, request: RequestInit, last: boolean): Promise<Response | undefined> {
  try {
    return await fetch(url, request);
  } catch (error) {
    if (last || !droppedConnection(error)) throw error;
    return undefined;
  }
}

function droppedConnection(error: unknown): boolean {
  if (!(error instanceof TypeError) || !(error.cause instanceof Error)) return false;
  const { code } = error.cause as Error & { code?: unknown };
  return typeof code === 'string' && DROPPED_CONNECTION_CODES.has(code);
}
