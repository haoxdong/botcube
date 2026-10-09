import { Agent } from 'undici';
import { awsFetch } from './aws.js';
import { HttpError } from './cartridge.js';

/** The header that names the Session a Runtime invocation belongs to. */
const SESSION_ID_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';

/** A cold AgentCore Runtime can take this long to accept a connection; headers and body wait 300 s (the default). */
const CONNECT_TIMEOUT_MS = 30_000;

interface UpstreamOptions {
  connectTimeoutMs?: number;
}

const turnDispatcher = ({ connectTimeoutMs = CONNECT_TIMEOUT_MS }: UpstreamOptions) =>
  new Agent({ connect: { timeout: connectTimeoutMs } });

/** Where a Turn's invocation goes: the AgentCore Runtime, or a local Harness. */
export interface Upstream {
  /** How client-facing errors name this upstream. */
  readonly label: string;
  readonly runtimeTarget?: string;
  invoke(body: string, sessionId: string, init?: { accept?: string | undefined; signal?: AbortSignal | undefined }): Promise<Response>;
}

export interface AgentCoreRuntime {
  arn: string;
  region: string;
  /** The data-plane endpoint; AWS_ENDPOINT_URL_BEDROCK_AGENTCORE overrides the regional one. */
  endpoint: string;
}

/**
 * AGENTCORE_REGION and the AgentCore data-plane endpoint. AWS_ENDPOINT_URL_BEDROCK_AGENTCORE
 * overrides the regional endpoint, as the AWS SDKs honour it; the parity suite points it at a local fake.
 */
export function agentCoreEndpointFromEnv(env: NodeJS.ProcessEnv): { region: string; endpoint: string } {
  const region = env.AGENTCORE_REGION || 'us-east-1';
  const endpoint = env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE || `https://bedrock-agentcore.${region}.amazonaws.com`;
  return { region, endpoint: endpoint.replace(/\/+$/, '') };
}

const runtimeInvocationUrl = (runtime: AgentCoreRuntime): string => `${runtime.endpoint}/runtimes/${encodeURIComponent(runtime.arn)}/invocations?qualifier=DEFAULT`;

/** Invokes the AgentCore Runtime over SigV4-signed HTTPS, as botocore signs it. */
export function agentCoreUpstream(runtime: AgentCoreRuntime, options: UpstreamOptions = {}): Upstream & { readonly runtimeTarget: string; stop(sessionId: string): Promise<void | 'absent'> } {
  const url = runtimeInvocationUrl(runtime);
  const dispatcher = turnDispatcher(options);
  return {
    label: 'AgentCore upstream',
    runtimeTarget: JSON.stringify([runtime.region, url]),
    async stop(sessionId) {
      const response = await awsFetch('bedrock-agentcore', runtime.region,
        `${runtime.endpoint}/runtimes/${encodeURIComponent(runtime.arn)}/stopruntimesession?qualifier=DEFAULT`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SESSION_ID_HEADER]: sessionId },
          body: '{}',
          signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
          dispatcher,
        });
      await response.arrayBuffer();
      // AWS reports an already terminated or absent Session as 404; the purge queue reports it.
      if (response.status === 404) return 'absent';
      if (!response.ok) {
        throw new Error(`AgentCore Session stop failed: HTTP ${response.status}`);
      }
      return undefined;
    },
    invoke(body, sessionId, init = {}) {
      return awsFetch('bedrock-agentcore', runtime.region, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SESSION_ID_HEADER]: sessionId },
        body,
        signal: init.signal,
        dispatcher,
      });
    },
  };
}

/** Invokes a local Harness's `/invocations` over plain HTTP. */
export function localAgentUpstream(baseUrl: string, options: UpstreamOptions = {}): Upstream {
  const dispatcher = turnDispatcher(options);
  return {
    label: 'Local Harness',
    invoke(body, sessionId, init = {}) {
      return fetch(`${baseUrl}/invocations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: init.accept ?? 'text/event-stream',
          [SESSION_ID_HEADER]: sessionId,
        },
        body,
        redirect: 'manual',
        signal: init.signal,
        dispatcher,
      } as RequestInit);
    },
  };
}

export interface HarnessEndpoint {
  url: string;
  sigv4: boolean;
  region: string;
}

function validateHarnessUrl(url: string): void {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) {
    throw new Error('BOTCUBE_HARNESS_ENDPOINT must be HTTPS without credentials or a fragment');
  }
}

export function harnessEndpointFromEnv(env: NodeJS.ProcessEnv): HarnessEndpoint | null {
  const url = env.BOTCUBE_HARNESS_ENDPOINT;
  const signing = env.BOTCUBE_HARNESS_SIGV4;
  if (signing !== undefined && signing !== 'true' && signing !== 'false') {
    throw new Error('BOTCUBE_HARNESS_SIGV4 must be true or false');
  }
  if (!url) {
    if (signing !== undefined) throw new Error('BOTCUBE_HARNESS_SIGV4 requires BOTCUBE_HARNESS_ENDPOINT');
    return null;
  }
  validateHarnessUrl(url);
  if (env.BOTCUBE_LOCAL_HARNESS_URL) throw new Error('Configure only one Harness endpoint');
  return { url, sigv4: signing !== 'false', region: env.AGENTCORE_REGION || 'us-east-1' };
}

export function httpsHarnessUpstream(endpoint: HarnessEndpoint, options: UpstreamOptions = {}, runtime?: AgentCoreRuntime | null): Upstream & { readonly runtimeBound: boolean; stop(sessionId: string): Promise<void | 'absent'> } {
  validateHarnessUrl(endpoint.url);
  const dispatcher = turnDispatcher(options);
  const bound = runtime != null && endpoint.region === runtime.region && endpoint.url === runtimeInvocationUrl(runtime)
    ? agentCoreUpstream(runtime, options) : null;
  return {
    runtimeBound: bound !== null,
    ...(bound === null ? {} : { runtimeTarget: bound.runtimeTarget }),
    async stop(sessionId) {
      if (bound === null) throw new HttpError(503, 'HTTPS Harness Runtime stop identity is unproved; deletion remains pending');
      return bound.stop(sessionId);
    },
    label: 'Harness upstream',
    invoke(body, sessionId, init = {}) {
      const request = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: init.accept ?? 'text/event-stream',
          [SESSION_ID_HEADER]: sessionId,
        },
        body,
        signal: init.signal,
        dispatcher,
      };
      return endpoint.sigv4
        ? awsFetch('bedrock-agentcore', endpoint.region, endpoint.url, request)
        : fetch(endpoint.url, { ...request, redirect: 'manual' } as RequestInit);
    },
  };
}
