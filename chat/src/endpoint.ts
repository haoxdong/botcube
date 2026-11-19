import type { Endpoint as EndpointConfig } from 'botcube-deployment-config/blocks';
import { credentialSource, type CredentialSource } from './credential-source.js';

const RETRIED_STATUSES = new Set([502, 503, 504]);
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;

export interface Endpoint {
  readonly url: string;
  readonly credential: CredentialSource;
  /** A request to `path` under the Endpoint's URL, with its bearer credential and headers, retried on 502, 503 and 504. */
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
        const response = await fetch(`${url}${path}`, request);
        if (!RETRIED_STATUSES.has(response.status) || attempt === ATTEMPTS) return response;
        // eslint-disable-next-line no-await-in-loop -- a retry follows the answer it retries
        await response.body?.cancel();
        // eslint-disable-next-line no-await-in-loop -- a retry follows the answer it retries
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      }
    },
  };
}
