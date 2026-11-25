import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CHAT = 'chat/src';
const CONFIG_READER = 'config/src/botcube_config/resolved_config.py';
const CREDENTIAL_SOURCE = 'credential-source/src/botcube_credential_source/__init__.py';
const CREDENTIAL_SERVICE = 'credential-service/src/botcube_credential_service';
const CREDENTIAL_CLIENT_FACTORY = `${CREDENTIAL_SERVICE}/cookies.py`;

/** Why a client goes direct, never through the proxy: no Endpoint of the BotCube Config names its destination. */
const DIRECT = {
  loopback: 'loopback or the task metadata endpoint, on the machine itself',
  aws: 'an AWS API, reached as the AWS SDK reaches it, through the network the deployment gives AWS',
  botcube: "one of BotCube's own services in the deployment: the Credential Service, a local Harness or session API, the Chat Service",
  proxy: 'the forward proxy itself',
  operator: "an operator command, on the operator's own machine and its environment",
  sender: 'sends with the dispatcher its caller gives',
  harnessToken: 'the Harness bearer, whose configuration has no proxy reference',
} as const;

type Route =
  /** Reads the `proxy` reference at `reference` in the BotCube Config, by each `[file, text]` that reads it. */
  | { reference: string; reads: readonly (readonly [file: string, text: string])[] }
  | { direct: keyof typeof DIRECT };

/** Every outbound client the Chat Service and the Credential Service build, by the file that builds it. */
const CLIENTS: Readonly<Record<string, readonly { client: string; route: Route }[]>> = {
  [`${CHAT}/config-locator.ts`]: [{ client: 'the resolved BotCube Config bucket', route: { direct: 'aws' } }],
  [`${CHAT}/tracing.ts`]: [{ client: 'the OTLP trace exporter', route: { reference: 'integrations.telemetry.proxy', reads: [[`${CHAT}/tracing.ts`, 'otlp?.proxy && proxyUrl(proxy, env)']] } }],
  [`${CHAT}/oidc-sign-in.ts`]: [{ client: "the OIDC issuer's discovery, token and userinfo calls", route: { reference: 'integrations.signIn.proxy', reads: [[`${CHAT}/oidc-sign-in.ts`, 'identity.proxy && proxyUrl(proxy, env)']] } }],
  [`${CHAT}/credential-source.ts`]: [
    { client: 'a secret Credential Source: Secrets Manager', route: { direct: 'aws' } },
    { client: 'an OAuth token grant for the Harness bearer', route: { direct: 'harnessToken' } },
    { client: 'an OAuth token grant for telemetry', route: { reference: 'integrations.telemetry.proxy', reads: [[`${CHAT}/tracing.ts`, 'fetch: through && proxiedFetch(through)']] } },
    { client: 'an OAuth token grant for sign-in', route: { reference: 'integrations.signIn.proxy', reads: [[`${CHAT}/oidc-sign-in.ts`, 'const through = identity.proxy && proxyUrl(proxy, env)'], [`${CHAT}/oidc-sign-in.ts`, 'clientSecret, { env, fetch }']] } },
  ],
  [`${CHAT}/upstream.ts`]: [
    { client: 'the AgentCore Runtime invocation and stop', route: { direct: 'aws' } },
    { client: 'a local Harness', route: { direct: 'botcube' } },
  ],
  [`${CHAT}/session-api.ts`]: [
    { client: 'the session API function', route: { direct: 'aws' } },
    { client: "the session API's local mode", route: { direct: 'botcube' } },
  ],
  [`${CHAT}/credential-service-request.ts`]: [{ client: 'the Credential Service', route: { direct: 'botcube' } }],
  [`${CHAT}/proxy-relay.ts`]: [{ client: 'the loopback relay to the proxy', route: { direct: 'proxy' } }],
  [`${CHAT}/local-chromium.ts`]: [{ client: "the local Chromium's DevTools", route: { direct: 'loopback' } }],
  [`${CHAT}/task-address.ts`]: [{ client: 'the ECS task metadata', route: { direct: 'loopback' } }],
  [`${CHAT}/files-cleanup-worker.ts`]: [{ client: 'the ECS task metadata', route: { direct: 'loopback' } }, { client: 'ECS', route: { direct: 'aws' } }],
  [`${CHAT}/scheduled-runs.ts`]: [{ client: 'the ECS task metadata', route: { direct: 'loopback' } }, { client: 'ECS and SQS', route: { direct: 'aws' } }],
  [`${CHAT}/aws.ts`]: [{ client: 'a SigV4-signed AWS call', route: { direct: 'aws' } }],
  [`${CHAT}/dispatcher-fetch.ts`]: [{ client: 'fetch on a given dispatcher', route: { direct: 'sender' } }],
  [`${CHAT}/agent-computer.ts`]: [{ client: 'AgentCore Browser', route: { direct: 'aws' } }],
  [`${CHAT}/agent-computer-cdp-transport.ts`]: [{ client: "AgentCore Browser's automation stream", route: { direct: 'aws' } }],
  [`${CHAT}/cdp.ts`]: [{ client: "AgentCore Browser's automation stream", route: { direct: 'aws' } }],
  [`${CHAT}/browser-sessions.ts`]: [{ client: 'AgentCore Browser sessions', route: { direct: 'aws' } }],
  [`${CHAT}/server.ts`]: [{ client: 'AgentCore Browser live view', route: { direct: 'aws' } }],
  ...Object.fromEntries([
    'account-resources.ts', 'account-store.ts', 'agent-documents.ts', 'files-efs.ts', 'files-pool-lease.ts', 'files-pool-manifest.ts',
    'park-history.ts', 'production-activity.ts', 'scheduled-execution.ts', 'scheduled-run-store.ts', 'scheduled-tasks.ts', 'scheduler.ts',
    'schedules.ts', 'session-metadata.ts', 'session-writers.ts', 'table-schedules.ts', 'turn-credentials.ts', 'turn-quota.ts',
  ].map((file) => [`${CHAT}/${file}`, [{ client: 'an AWS SDK client', route: { direct: 'aws' } }]])),
  [CONFIG_READER]: [{ client: 'the resolved BotCube Config bucket', route: { direct: 'aws' } }],
  [`${CREDENTIAL_SERVICE}/models.py`]: [{ client: "the models Relay provider's client", route: { reference: 'integrations.modelGateway.proxy', reads: [[`${CREDENTIAL_SERVICE}/models.py`, "proxy_url_from_config(config, env) if models.get('proxy')"]] } }],
  [`${CREDENTIAL_SERVICE}/openai.py`]: [{
    client: "the openai Relay provider's client: Plan Usage's calls and its sign-in's refresh",
    route: {
      reference: 'integrations.relayProviders.openai.proxy',
      reads: [[`${CREDENTIAL_SERVICE}/compose.py`, 'relay_provider_proxy(config, OPENAI_PROVIDER)'], [`${CREDENTIAL_SERVICE}/openai.py`, 'proxy=self._proxy() if self._proxy else None']],
    },
  }],
  [CREDENTIAL_SOURCE]: [
    { client: 'a secret Credential Source: Secrets Manager', route: { direct: 'aws' } },
    { client: 'an OAuth token grant for the model gateway', route: { reference: 'integrations.modelGateway.proxy', reads: [[`${CREDENTIAL_SERVICE}/models.py`, "route['credential'], env=env, now=now, proxy=proxy"]] } },
  ],
  [`${CREDENTIAL_SERVICE}/endpoint_tls.py`]: [{ client: 'the connection to the proxy', route: { direct: 'proxy' } }],
  [`${CREDENTIAL_SERVICE}/sign_in.py`]: [{ client: "KMS and AgentCore Browser's automation stream", route: { direct: 'aws' } }],
  [`${CREDENTIAL_SERVICE}/openai_sign_in.py`]: [{ client: 'the Plan Usage sign-in command', route: { direct: 'operator' } }],
  ...Object.fromEntries(['audit_copy.py', 'aws.py', 'data_keys.py'].map((file) => [`${CREDENTIAL_SERVICE}/${file}`, [{ client: 'an AWS SDK client', route: { direct: 'aws' } }]])),
};

const TYPESCRIPT_CLIENT = /(^|[^.\w])fetch\(|dispatcherFetch\(|awsFetch\(|new (Agent|ProxyAgent|Pool|EnvHttpProxyAgent|WebSocket)\(|tcpConnect\(|tlsConnect\(|client\.discovery\(|oidc\.\w+Grant\(|from '@aws-sdk\/client-/;
const PYTHON_CLIENT = /stateless_http_client\(|httpx\.(AsyncClient|Client|post|get|put|delete|request|stream)\(|httpcore\.\w*Pool\(|boto3\.(client|resource|Session|session)\b|\.client\('|websockets|socket\.create_connection\(|urlopen\(/;

const source = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const sources = (directory: string, extension: string): string[] => readdirSync(new URL(`../${directory}`, import.meta.url))
  .filter((name) => name.endsWith(extension) && !name.endsWith(`.test${extension}`))
  .map((name) => `${directory}/${name}`);
const buildsClient = (file: string): boolean => {
  const client = file.endsWith('.py') ? PYTHON_CLIENT : TYPESCRIPT_CLIENT;
  return source(file).split('\n').some((line) => {
    if (/^\s*(import type|#|\/\/|\*)/.test(line)) return false;
    if (file === CREDENTIAL_CLIENT_FACTORY && /^\s*(def stateless_http_client|return httpx\.AsyncClient)\(/.test(line)) return false;
    return client.test(line);
  });
};

/** The node at `path` in the emitted BotCube Config schema, through each adapter's branch; `*` is any record key. */
function schemaAt(path: string): unknown {
  type Node = { properties?: Record<string, Node>; oneOf?: Node[]; anyOf?: Node[]; additionalProperties?: Node; const?: unknown };
  const root: Node = JSON.parse(source('config/botcube.schema.json'));
  const child = (node: Node, key: string): Node | undefined => {
    const own = /^[a-z][a-z0-9-]*$/.test(key) && node.additionalProperties && !node.properties?.[key] ? node.additionalProperties : node.properties?.[key];
    return own ?? [...(node.oneOf ?? []), ...(node.anyOf ?? [])].map((branch) => child(branch, key)).find(Boolean);
  };
  return path.split('.').reduce<Node | undefined>((node, key) => node && child(node, key), root)?.const;
}

describe('every outbound client of the Chat Service and the Credential Service', () => {
  const files = [...sources(CHAT, '.ts'), ...sources(CREDENTIAL_SERVICE, '.py'), CREDENTIAL_SOURCE, CONFIG_READER];

  it('is listed with its route, and every listed file builds one', () => {
    expect(files.filter(buildsClient).sort()).toEqual(Object.keys(CLIENTS).sort());
  });

  it.each(Object.entries(CLIENTS).flatMap(([file, clients]) => clients.map(({ client, route }) => [file, client, route] as const)))(
    "%s: %s reads its Endpoint's proxy reference, or goes direct for a stated reason and reads none",
    (file, _client, route) => {
      if ('direct' in route) {
        if (route.direct !== 'proxy') expect(source(file)).not.toMatch(/proxyUrl\(|proxy_url_from_config\(|relay_provider_proxy\(/);
        return;
      }
      expect(schemaAt(route.reference)).toBe('integrations.proxy');
      for (const [reader, text] of route.reads) expect(source(reader)).toContain(text);
    },
  );
});
