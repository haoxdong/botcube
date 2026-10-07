import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import type { Dispatcher } from 'undici';

// The Chat Service is the AWS credential boundary (ADR 0068): every AWS call a
// Cartridge makes goes through these signers, with the task's credentials.
const credentials = defaultProvider();

const signer = (service: string, region: string) => new SignatureV4({ service, region, credentials, sha256: Sha256 });

function httpRequest(url: URL, method: string, headers: Record<string, string>, body?: string) {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values;
  }
  return {
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    query,
    headers: { ...headers, host: url.host },
    body,
  };
}

/** SigV4 headers for a request, as botocore signs it; `host` is left to the HTTP client. */
export async function signedAwsHeaders(
  service: string,
  region: string,
  request: { method: string; url: string; headers?: Record<string, string>; body?: string | undefined },
): Promise<Record<string, string>> {
  const url = new URL(request.url);
  const signed = await signer(service, region).sign(
    httpRequest(url, request.method, request.headers ?? {}, request.body),
  );
  const { host: _host, ...headers } = signed.headers;
  return headers;
}

/** A SigV4-signed fetch to an AWS service. */
export async function awsFetch(
  service: string,
  region: string,
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string | undefined;
    signal?: AbortSignal | undefined;
    dispatcher?: Dispatcher;
  },
): Promise<Response> {
  const headers = await signedAwsHeaders(service, region, { ...init, url });
  return fetch(url, {
    method: init.method,
    headers,
    body: init.body,
    redirect: 'manual',
    signal: init.signal,
    dispatcher: init.dispatcher,
  } as RequestInit);
}

/** A SigV4 query-presigned GET URL, as botocore's SigV4QueryAuth signs it. */
export async function presignAwsUrl(
  service: string,
  region: string,
  url: string,
  expiresInSeconds: number,
): Promise<string> {
  const target = new URL(url);
  // Stryker disable next-line StringLiteral: the signer reads an empty method as GET
  const signed = await signer(service, region).presign(httpRequest(target, 'GET', {}), {
    expiresIn: expiresInSeconds,
  });
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(signed.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null) query.append(key, item);
    }
  }
  return `${target.origin}${target.pathname}?${query.toString()}`;
}
