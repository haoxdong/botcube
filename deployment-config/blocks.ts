import { z } from 'zod';

const secretArn = z.string().regex(/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/, 'Expected a Secrets Manager secret ARN');

/** The seconds a command credential may run before it is stopped, as Google's executable sources default to. */
export const COMMAND_TIMEOUT_SECONDS = 30;

const secretSources = [
  z.strictObject({ kind: z.literal('secret'), secretArn }).describe("A Secrets Manager secret's string, read with the process's own AWS credentials."),
  z.strictObject({
    kind: z.literal('file'),
    path: z.string().startsWith('/', 'Expected an absolute path').describe('A file the platform mounts, such as a secret injector writes; read again as it rotates.'),
  }).describe("A mounted file's contents, a trailing newline dropped."),
  z.strictObject({
    kind: z.literal('command'),
    command: z.tuple([z.string().min(1)], z.string()).describe('The program and its arguments, run without a shell.'),
    timeoutSeconds: z.number().int().positive().default(COMMAND_TIMEOUT_SECONDS).describe('How long the command may run before it is stopped.'),
  }).describe(
    'A command printing a Kubernetes ExecCredential (status.token, status.expirationTimestamp) on stdout, run again before the token expires; its stderr is discarded. Runs only under allowCommandCredentials.',
  ),
] as const;

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const httpsOrLoopback = (url: string) => {
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
]);
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

/** An outbound External Service (ADR 0091): its URL, the credential sent as its bearer token, and headers sent on every request. */
export const endpoint = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  credential: credentialSource.describe('Sent as `Authorization: Bearer <value>`.'),
  headers: endpointHeaders,
});
export type Endpoint = z.output<typeof endpoint>;
export const cacheMarkers = z.literal('claude')
  .describe("Set to `claude` behind a gateway in front of Claude, so the Harness marks the system prompt and the latest messages with `cache_control` and repeated input is billed at the cached rate. Unset, no request carries a marker.");

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

/** The JSON the deploy set in `name`, as `schema` parses it, or undefined when unset; throws naming the variable and each bad field. */
export function jsonFromEnv<T>(env: NodeJS.ProcessEnv, name: string, schema: z.ZodType<T>): T | undefined {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new Error(`${name}: not JSON`);
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  throw new Error(parsed.error.issues.map((issue) => `${name}: ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n'));
}
