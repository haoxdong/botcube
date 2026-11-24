import { z } from 'zod';

const secretId = z
  .string()
  .regex(/^(arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+|[A-Za-z0-9/_+=.@-]{1,512})$/, 'Expected a Secrets Manager secret name or ARN')
  .describe("As Secrets Manager GetSecretValue's SecretId: the secret's name, in the reader's own account and region, or its ARN.");

export const kmsKeyArn = z.string().regex(/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/.+$/).describe('A KMS key, by ARN.');

/** The seconds a command credential may run before it is stopped, as Google's executable sources default to. */
export const COMMAND_TIMEOUT_SECONDS = 30;

export const absolutePath = z.string().startsWith('/', 'Expected an absolute path');
const command = {
  command: z.tuple([z.string().min(1)], z.string()).describe('The program and its arguments, run without a shell.'),
  timeoutSeconds: z.number().int().positive().default(COMMAND_TIMEOUT_SECONDS).describe('How long the command may run before it is stopped.'),
};

const secretSources = [
  z.strictObject({ kind: z.literal('secret'), secretId }).describe("A Secrets Manager secret's string, read with the process's own AWS credentials."),
  z.strictObject({
    kind: z.literal('file'),
    path: absolutePath.describe('A file the platform mounts, such as a secret injector writes; read again as it rotates.'),
  }).describe("A mounted file's contents, a trailing newline dropped."),
  z.strictObject({
    kind: z.literal('command'),
    ...command,
  }).describe(
    'A command printing a Kubernetes ExecCredential (status.token, status.expirationTimestamp) on stdout, run again before the token expires; its stderr is discarded. Runs only under allowCommandCredentials.',
  ),
] as const;

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
export const httpsOrLoopback = (url: string) => {
  const { protocol, hostname } = new URL(url);
  return protocol === 'https:' || (protocol === 'http:' && LOOPBACK.has(hostname));
};

/** RFC 6749's scope-token: printable ASCII but space, `"` and `\\`. */
const oauthScope = z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, 'Expected an OAuth scope: printable ASCII without spaces, quotes or backslashes');

/** Where a seam's secret or token comes from (ADR 0091); each source gives a value and when it expires. */
export const credentialSource = z.discriminatedUnion('kind', [
  ...secretSources,
  z.strictObject({
    kind: z.literal('oauth-client-credentials'),
    tokenEndpoint: z.url().refine(httpsOrLoopback, 'A token endpoint is an https URL; only a stand-in on this machine may use http')
      .describe("The identity provider's token endpoint, as its OpenID configuration names token_endpoint."),
    clientId: z.string().min(1),
    clientSecret: z.discriminatedUnion('kind', [...secretSources]).describe("Where the client's secret is read, sent as HTTP Basic each time a token is asked for."),
    scopes: z.array(oauthScope).min(1).optional().describe('The scopes asked for; absent, the provider grants its default.'),
  }).describe("An access token from an identity provider's OAuth 2.0 client-credentials grant, asked for again a minute before its expires_in runs out."),
  z.strictObject({
    kind: z.literal('aws'),
    audience: z.string().min(1).describe('The receiver, signed into the request as x-botcube-audience so it cannot be replayed to another.'),
  }).describe(
    "The process's own AWS identity, as Google's external-account aws source gives it: a SigV4-signed sts:GetCallerIdentity request, URL-encoded JSON {url, method, headers}, which the receiver replays to STS. Signed again before its 15 minutes run out.",
  ),
  z.strictObject({
    kind: z.literal('botcube'),
    audience: z.string().min(1).describe("The token's `aud`; not one reserved for another kind of BotCube token."),
  }).describe("A short-lived token the Chat Service signs with its Turn identity keys, as the issuer at its public origin: the Harness bearer `harnessAuth` sends, which no configured credential takes."),
]).meta({ id: 'credentialSource' });
export type CredentialSource = z.output<typeof credentialSource>;

const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'Expected an HTTP header name');

/** An Endpoint's headers, which may not set `credentialHeader`: its credential does. */
export const headersBeside = (credentialHeader: string, sentOn: string) => z
  .record(headerName, z.string())
  .superRefine((headers, context) => {
    for (const name of Object.keys(headers).filter((name) => name.toLowerCase() === credentialHeader.toLowerCase())) {
      context.addIssue({ code: 'custom', path: [name], message: `The credential sets ${credentialHeader}` });
    }
  })
  .optional()
  .describe(`Headers sent on ${sentOn}, such as a tenant or routing header a gateway requires; never a secret.`);

export const endpointHeaders = headersBeside('Authorization', 'every request');

/**
 * An Endpoint's TLS (ADR 0091): the client certificate it presents, read again for each new connection, and the server
 * identity it expects. Its chain is checked against the BotCube Config's `caBundle`.
 */
export const endpointTls = z.strictObject({
  clientCertificate: z.union([
    z.strictObject({
      certificate: absolutePath.describe('A PEM certificate chain the platform mounts, such as a SPIFFE helper writes.'),
      key: absolutePath.describe("The certificate's PEM private key."),
    }).describe('A mounted certificate and key, read again for each new connection as they rotate.'),
    z.strictObject(command).describe(
      'A command printing a Kubernetes ExecCredential (status.clientCertificateData, status.clientKeyData, both PEM) on stdout, run again for each new connection; its stderr is discarded. Runs only under allowCommandCredentials.',
    ),
  ]).optional().describe('The client certificate presented in each handshake; absent, none.'),
  serverIdentity: z.url().describe(
    "The URI or SPIFFE ID the server's certificate must carry as a URI SAN, checked in the handshake before any request is sent. Set, it replaces the hostname check; the chain is still verified.",
  ).optional(),
}).refine((tls) => tls.clientCertificate !== undefined || tls.serverIdentity !== undefined, 'Expected a clientCertificate, a serverIdentity or both');
export type EndpointTls = z.output<typeof endpointTls>;

/** The proxy an Endpoint is reached through, by its key in the BotCube Config; absent, the Endpoint is reached direct. */
export const proxyReference = z.literal('integrations.proxy')
  .describe('Reached through the forward proxy at integrations.proxy; absent, direct.');

/** An outbound External Service (ADR 0091): its URL, the credential sent as its bearer token, headers sent on every request, its TLS and its proxy. */
export const endpoint = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  credential: credentialSource.describe('Sent as `Authorization: Bearer <value>`.'),
  headers: endpointHeaders,
  tls: endpointTls.optional(),
  proxy: proxyReference.optional(),
});
export type Endpoint = z.output<typeof endpoint>;

/** The operator's forward proxy, or none. */
export const forwardProxy = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('forward'),
    url: z.url({ protocol: /^https?$/ }).describe('The forward proxy, as an HTTP client takes it.'),
    credential: credentialSource
      .refine((source) => source.kind === 'file', 'A proxy credential is read from a file; any other source would reach out through the proxy it authenticates')
      .optional()
      .describe("A file, sent as `Proxy-Authorization: Bearer <value>` on each tunnel and request, read again as it rotates; absent, the proxy takes none."),
    headers: headersBeside('Proxy-Authorization', 'each tunnel and request the proxy carries'),
    tls: endpointTls.optional(),
  }).refine(({ url, tls }) => tls === undefined || url.startsWith('https:'), { path: ['tls'], message: 'TLS needs the proxy at an https URL' }).describe(
    "The operator's forward proxy, an Endpoint: each Endpoint, and network.openEgress, that names it is reached through it; everything else goes direct.",
  ),
  z.strictObject({ kind: z.literal('none') }).describe('Outbound traffic goes direct.'),
]);

/** Whose model it is, by LangChain's provider name: `anthropic` and `openai` on their own APIs or on Bedrock, `deepseek` on Bedrock, and `echo`, BotCube's own. */
export const modelProvider = z.enum(['anthropic', 'openai', 'deepseek', 'echo']);
export type ModelProvider = z.output<typeof modelProvider>;

/** The providers whose own API a model gateway serves. */
export const GATEWAY_PROVIDERS = ['anthropic', 'openai'] as const satisfies readonly ModelProvider[];

const gatewayUrl = z.url().refine(httpsOrLoopback, 'A models endpoint is an https URL; only a stand-in on this machine may use http');
const providerRoute = z.strictObject({
  url: gatewayUrl.optional().describe("The base URL of the provider's own API on the gateway, as LiteLLM's api_base, such as https://models.example.com/anthropic; absent, the gateway's."),
  credential: credentialSource.optional().describe("Sent as `Authorization: Bearer <value>` in place of the gateway's credential."),
  headers: endpointHeaders.describe("Headers sent on every request to this provider, in place of the gateway's."),
});

/** Every model on a gateway, by its key in the bot settings, called on its provider's own API (ADR 0091). */
export const gatewayModels = endpoint.extend({
  kind: z.literal('openai-compatible'),
  url: gatewayUrl.describe("The gateway's base URL, such as https://models.example.com/v1, for each provider `providers` gives no URL."),
  providers: z.strictObject({
    anthropic: providerRoute.optional(),
    openai: providerRoute.extend({
      useResponsesApi: z.boolean().default(false).describe("Call OpenAI's Responses API, as LangChain's use_responses_api; false, its Chat Completions API."),
    }).optional(),
  }).optional()
    .describe("Every provider the gateway serves, by LangChain's provider name, and where; absent, it serves each at its URL."),
}).describe("Every model on a gateway, by its key in the bot settings, called on its provider's own API; Plan Usage models still run through the Credential Service.");
export type GatewayModels = z.output<typeof gatewayModels>;

/** Why `gateway` cannot call a model on `provider`, or undefined when it can; Bedrock runs every model it serves, and `echo` is never called. */
export function unreachedProvider(gateway: GatewayModels | { kind: 'bedrock' }, provider: ModelProvider): string | undefined {
  if (gateway.kind === 'bedrock') return undefined;
  const served: readonly ModelProvider[] = gateway.providers ? GATEWAY_PROVIDERS.filter((name) => gateway.providers?.[name]) : GATEWAY_PROVIDERS;
  if (provider === 'echo') return undefined;
  if (!served.includes(provider)) return `integrations.modelGateway reaches the providers ${served.join(' and ')}`;
  if (provider === 'anthropic' && !gateway.providers?.anthropic?.url && /\/v1\/?$/.test(new URL(gateway.url).pathname)) {
    return "integrations.modelGateway.url ends in /v1, which Anthropic's API adds itself: set integrations.modelGateway.providers.anthropic.url without /v1";
  }
  return undefined;
}

/** A model named `provider:model`, its provider read as a bot model's is; undefined unless it names both. */
export const oidcIssuer = z.url().refine(httpsOrLoopback, 'An OIDC issuer is an https URL; only a stand-in on this machine may use http');

/** An OIDC issuer's discovery URL, as AgentCore's JWT authorizer takes it. */
export const oidcDiscoveryUrl = z.templateLiteral(['https://', z.string(), '/.well-known/openid-configuration']).refine((url) => URL.canParse(url));

/** Who BotCube accepts tokens from (ADR 0091): an OIDC issuer and the clients its tokens are for. */
export const trust = <Issuer extends z.ZodType<string>, Client extends z.ZodType>(issuer: Issuer, client: Client) => ({
  issuer,
  clients: z.tuple([client], client).describe("The issuer's clients, each by its id: a token's audience."),
});

/** The variable the operator sets to `1` in the deploy environment, beside `allowCommandCredentials`, for a command credential to run. */
export const ALLOW_COMMAND_CREDENTIALS_ENV = 'BOTCUBE_ALLOW_COMMAND_CREDENTIALS';

export const relayProviders = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/, 'Expected a Relay provider name such as openai'), z.strictObject({ proxy: proxyReference.optional() }))
  .superRefine((providers, context) => {
    if ('models' in providers) {
      context.addIssue({ code: 'custom', path: ['models'], message: 'The models Relay provider is integrations.modelGateway: name the proxy at integrations.modelGateway.proxy' });
    }
  })
  .optional()
  .describe("The Credential Service's Relay providers, by name, such as openai, Plan Usage's, and each one's upstream calls; a provider not listed reaches its upstream direct.");
