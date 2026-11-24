import { propagation, type Context } from '@opentelemetry/api';
import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici';
import { awsFetch } from './aws.js';
import { dispatcherFetch } from './dispatcher-fetch.js';
import type { HarnessBearer } from './harness-auth.js';

/** The header that names the Session a Runtime invocation belongs to. */
const SESSION_ID_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';
const CREDENTIAL_INVOCATION_HEADER = 'X-BotCube-Credential-Invocation';

/** A cold AgentCore Runtime can take this long to accept a connection; headers and body wait 300 s (the default). */
const CONNECT_TIMEOUT_MS = 30_000;

interface UpstreamOptions {
  connectTimeoutMs?: number;
  /** Set: each call carries this bearer token instead of a SigV4 signature (the `jwt-bearer` Harness auth). */
  bearer?: HarnessBearer | undefined;
}

// Under the BotCube Config's proxy (NODE_USE_ENV_PROXY), through HTTP(S)_PROXY except NO_PROXY's hosts.
const turnDispatcher = ({ connectTimeoutMs = CONNECT_TIMEOUT_MS }: UpstreamOptions): Dispatcher =>
  process.env.NODE_USE_ENV_PROXY === '1'
    ? new EnvHttpProxyAgent({ connect: { timeout: connectTimeoutMs } })
    : new Agent({ connect: { timeout: connectTimeoutMs } });

/** Where a Turn's invocation goes: the AgentCore Runtime, or a local Harness. */
export interface Upstream {
  /** How client-facing errors name this upstream. */
  readonly label: string;
  readonly runtimeTarget?: string;
  invoke(body: string, sessionId: string, init?: InvocationOptions): Promise<Response>;
}

interface InvocationOptions {
  accept?: string | undefined;
  signal?: AbortSignal | undefined;
  traceContext?: Context | undefined;
  credentialServiceInvocationToken?: string | undefined;
}

function invocationHeaders(sessionId: string, init: InvocationOptions): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', [SESSION_ID_HEADER]: sessionId };
  if (init.credentialServiceInvocationToken !== undefined) headers[CREDENTIAL_INVOCATION_HEADER] = init.credentialServiceInvocationToken;
  if (init.traceContext !== undefined) propagation.inject(init.traceContext, headers);
  return headers;
}

export interface AgentCoreRuntime {
  arn: string;
  region: string;
  /** The data-plane endpoint; AWS_ENDPOINT_URL_BEDROCK_AGENTCORE overrides the regional one. */
  endpoint: string;
}

/**
 * AWS_REGION and the AgentCore data-plane endpoint. AWS_ENDPOINT_URL_BEDROCK_AGENTCORE
 * overrides the regional endpoint, as the AWS SDKs honour it; the parity suite points it at a local fake.
 */
export function agentCoreEndpointFromEnv(env: NodeJS.ProcessEnv): { region: string; endpoint: string } {
  const region = env.AWS_REGION || 'us-east-1';
  const endpoint = env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE || `https://bedrock-agentcore.${region}.amazonaws.com`;
  return { region, endpoint: endpoint.replace(/\/+$/, '') };
}

const runtimeInvocationUrl = (runtime: AgentCoreRuntime): string => `${runtime.endpoint}/runtimes/${encodeURIComponent(runtime.arn)}/invocations?qualifier=DEFAULT`;

/** A Runtime call, SigV4-signed as botocore signs it, or with the Harness auth's bearer token. */
async function runtimeFetch(runtime: AgentCoreRuntime, bearer: HarnessBearer | undefined, url: string, init: Parameters<typeof awsFetch>[3] & { headers: Record<string, string>; dispatcher: Dispatcher }): Promise<Response> {
  if (bearer === undefined) return await awsFetch('bedrock-agentcore', runtime.region, url, init);
  return await dispatcherFetch(url, {
    method: init.method,
    headers: { ...init.headers, authorization: `Bearer ${await bearer()}` },
    body: init.body ?? null,
    redirect: 'manual',
    signal: init.signal ?? null,
    dispatcher: init.dispatcher,
  });
}

/** Invokes the AgentCore Runtime over HTTPS, signed by SigV4 or carrying a JWT bearer token. */
export function agentCoreUpstream(runtime: AgentCoreRuntime, options: UpstreamOptions = {}): Upstream & { readonly runtimeTarget: string; stop(sessionId: string): Promise<void | 'absent'> } {
  const url = runtimeInvocationUrl(runtime);
  const dispatcher = turnDispatcher(options);
  return {
    label: 'AgentCore upstream',
    runtimeTarget: JSON.stringify([runtime.region, url]),
    async stop(sessionId) {
      const response = await runtimeFetch(runtime, options.bearer,
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
      return runtimeFetch(runtime, options.bearer, url, {
        method: 'POST',
        headers: invocationHeaders(sessionId, init),
        body,
        signal: init.signal,
        dispatcher,
      });
    },
  };
}

/** Invokes a local Harness's `/invocations` over plain HTTP, with the Harness auth's bearer token when it has one. */
export function localAgentUpstream(baseUrl: string, options: UpstreamOptions = {}): Upstream {
  const dispatcher = turnDispatcher(options);
  return {
    label: 'Local Harness',
    async invoke(body, sessionId, init = {}) {
      const headers = invocationHeaders(sessionId, init);
      headers.accept = init.accept ?? 'text/event-stream';
      if (options.bearer !== undefined) headers.authorization = `Bearer ${await options.bearer()}`;
      return await dispatcherFetch(`${baseUrl}/invocations`, {
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
