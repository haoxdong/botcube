import { propagation, type Context } from '@opentelemetry/api';
import { Agent } from 'undici';
import { awsFetch } from './aws.js';
import { dispatcherFetch } from './dispatcher-fetch.js';

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
  invoke(body: string, sessionId: string, init?: { accept?: string | undefined; signal?: AbortSignal | undefined; traceContext?: Context | undefined }): Promise<Response>;
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
      const headers = { 'content-type': 'application/json', [SESSION_ID_HEADER]: sessionId };
      if (init.traceContext !== undefined) propagation.inject(init.traceContext, headers);
      return awsFetch('bedrock-agentcore', runtime.region, url, {
        method: 'POST',
        headers,
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
      const headers = {
        'content-type': 'application/json',
        accept: init.accept ?? 'text/event-stream',
        [SESSION_ID_HEADER]: sessionId,
      };
      if (init.traceContext !== undefined) propagation.inject(init.traceContext, headers);
      return dispatcherFetch(`${baseUrl}/invocations`, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: init.signal ?? null,
        dispatcher,
      });
    },
  };
}
