import type { Endpoint as EndpointConfig } from 'botcube-deployment-config/blocks';
import { credentialSource, type CredentialSource } from './credential-source.js';

const RETRIED_STATUSES = new Set([502, 503, 504]);
const DROPPED_BEFORE_RESPONSE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']);
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;

export interface Endpoint {
  readonly url: string;
  readonly credential: CredentialSource;
  /**
   * A request to `path` under the Endpoint's URL, with its bearer credential and headers. It retries a 502, 503 or 504, and a
   * connection reset, refused or timed out connecting before the response starts; nothing once the response starts.
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

async function answer(url: string, request: RequestInit, last: boolean): Promise<Response | undefined> {
  try {
    return await fetch(url, request);
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
