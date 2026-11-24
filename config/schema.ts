import { z } from 'zod';
import type { HarnessAuth, TokenAudiences } from './seams.js';
import { outsideIssuer, withClientSecret, type CredentialField } from 'botcube-config/credential-fields';
import { proxiedFields } from 'botcube-config/proxied-fields';
import { absolutePath, credentialSource, endpointHeaders, endpointTls, forwardProxy, gatewayModels, modelProvider, proxyReference, relayProviders, oidcDiscoveryUrl, oidcIssuer, trust, type CredentialSource, type EndpointTls } from 'botcube-config/blocks';
import { existing } from 'botcube-config/existing';
import { agentCore, alarms, cloudflare, deploymentKeys, natGateways, natRouteTables, openEgress, parking, publicIp, RETIRED_FILES, services } from 'botcube-config/deployment';
import { imageRegistry } from 'botcube-config/images';
import { userPool } from 'botcube-config/user-pool';
import { renamedBotKeys, renamedKeys } from 'botcube-config/renamed-keys';


const schemaReference = z.string().optional().describe('The JSON Schema this file follows, for editors.');

const model = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  provider: modelProvider.describe("A Session's Turns all run on its first Turn's provider."),
  maxTokens: z.number().int().positive().optional().describe("The most output tokens one call to the model may write, as LiteLLM's max_tokens; absent, LangChain's default; required on a model gateway for a model LangChain has no profile for."),
});

const agentColour = z.string().regex(/^#[0-9a-f]{6}$/i, 'Expected a colour as #rrggbb');
const webUiSettings = {
  theme: z
    .strictObject({ agentBody: agentColour, agentOutline: agentColour, agentDeep: agentColour, agentDeepest: agentColour })
    .optional()
    .describe("The agent's four colours, for its illustrations; absent, BotCube's own. The avatar is the Agent Identity's."),
  memory: z.boolean().default(true).describe('Whether the agent keeps a Memory across Sessions, and the Agent Profile shows it.'),
  agentComputer: z
    .strictObject({
      enabled: z.boolean().default(true).describe("Whether the Agent Profile shows the open chat's Agent Computer."),
      liveBrowser: z.boolean().default(false).describe("Whether the agent's browser floats over the chat while a Turn drives it."),
      profileOmitsCookieDomains: z
        .array(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Expected a domain such as example.com'))
        .default([])
        .describe("Domains, subdomains included, whose cookies BotCube deletes before saving the Agent Computer's browser profile, such as a site a product's own service seeds sign-ins for."),
    })
    .default({ enabled: true, liveBrowser: false, profileOmitsCookieDomains: [] }),
};

export const botSettings = z
  .strictObject({
    $schema: schemaReference,
    agentIdentity: z.strictObject({
      name: z.string().trim().min(1),
      character: z.string().min(1),
      avatar: z.string().optional().describe("An emoji; absent, the UI shows the name's initial."),
    }),
    accountKey: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .describe("Names the bot's Sessions and its `<key>_session` and `<key>_account_id` cookies; every stored Account is written under it. Changing it after the first deploy signs every User out and loses Guests' Accounts."),
    soul: z.string().min(1).optional().describe("The agent's Soul; absent, BotCube's own."),
    instructions: z
      .string()
      .min(1)
      .optional()
      .describe("A file of the bot's instructions to every User, relative to this file, joined to the system prompt after BotCube's own; the bot's image copies it beside it."),
    models: z.tuple([model], model).describe('The models a User picks from; the first is the default.'),
    skills: z
      .array(z.string().min(1))
      .optional()
      .describe("Skill directories, relative to this file, each holding a SKILL.md; the bot's image copies them beside it."),
    environment: z
      .record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Expected a variable name'),
        z.string().regex(/^(?:[^$]|\$\$|\$\{BOTCUBE_RELAY_URL\})*$/, 'Expected a literal value, where ${BOTCUBE_RELAY_URL} is the one variable and $$ a literal $'),
      )
      .optional()
      .describe(
        "Variables the agent's shell holds, as Docker Compose's `environment`: each value is literal, with ${BOTCUBE_RELAY_URL}, the agent's loopback origin, interpolated. A request to `${BOTCUBE_RELAY_URL}/<provider>/…` reaches that Credential Service Relay provider with the Turn's credential; the loopback forwards only the providers these values name, such as `SITE_URL: ${BOTCUBE_RELAY_URL}/site`.",
      ),
    ...webUiSettings,
    productName: z.string().trim().min(1).optional().describe("The product's name, as Users see it."),
    productService: z.strictObject({
      agentComputerStartedPath: z.string().startsWith('/', 'Expected a path starting with /')
        .describe("The Credential Service path called when an Agent Computer's browser starts, for the product to prepare it."),
    }).optional().describe("The product's own service."),
  })
  .superRefine(({ models, agentComputer }, context) => {
    if (agentComputer.liveBrowser && !agentComputer.enabled) {
      context.addIssue({ code: 'custom', path: ['agentComputer', 'liveBrowser'], message: 'The live browser is part of the Agent Computer, which agentComputer.enabled turns off' });
    }
    models.forEach(({ key }, index) => {
      const first = models.findIndex((other) => other.key === key);
      if (first !== index) context.addIssue({ code: 'custom', path: ['models', index, 'key'], message: `Model key "${key}" is already models.${first}.key` });
    });
  });

// Each section lists its adapters, the open default first; a missing section is the default.
const kindOnly = <Kind extends string>(kind: Kind) => z.strictObject({ kind: z.literal(kind) });


const identity = z.discriminatedUnion('kind', [
  kindOnly('botcube-accounts'),
  z.strictObject({
    kind: z.literal('oidc'),
    ...trust(
      oidcIssuer.describe("The provider's issuer URL, where its OpenID configuration is discovered."),
      z.strictObject({ clientId: z.string().min(1), clientSecret: credentialSource.describe("The client's secret, which redeems sign-in codes.") }),
    ),
    logoutUrl: z.url({ protocol: /^https$/ }).optional().describe(
      "Where signing out sends the browser, so the provider ends its own session and the next sign-in prompts again; for a provider whose discovery names no end_session_endpoint.",
    ),
    resources: z.array(z.strictObject({
      type: z.string().regex(/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/, 'Expected a CloudFormation resource type such as AWS::Service::Resource'),
      name: z.string().min(1),
    })).optional().describe("The AWS resources the deployment runs the provider on, beside BotCube's own, which the footprint lists."),
    userPool: userPool.optional(),
    proxy: proxyReference.optional().describe("The issuer's calls go through integrations.proxy; absent, direct."),
  }).superRefine(({ clients }, context) => {
    clients.forEach(({ clientId }, index) => {
      const first = clients.findIndex((other) => other.clientId === clientId);
      if (first !== index) context.addIssue({ code: 'custom', path: ['clients', index, 'clientId'], message: `Client ${clientId} is already identity.clients.${first}.clientId` });
    });
  }).describe('Users sign in with an OpenID Connect provider, by authorization code with PKCE: with the first client, or the one a sign-in names.'),
]);
const models = z.discriminatedUnion('kind', [
  kindOnly('bedrock'),
  gatewayModels,
]);
/** The audience of each kind of token BotCube's Chat Service signs; botcube/chat signs with these. */
export const TOKEN_AUDIENCES = { turnIdentity: 'sts.amazonaws.com', user: 'botcube-user' } as const satisfies TokenAudiences;
/** The subject of the Chat Service's own service tokens, such as the Harness bearer. */
export const CHAT_SERVICE_SUBJECT = 'botcube-chat-service';
/**
 * The audiences a Harness bearer may not take, so it never passes for another kind of BotCube token: the Turn identity
 * and the user token share its keys and issuer.
 */
export const RESERVED_AUDIENCES: readonly string[] = [...Object.values(TOKEN_AUDIENCES), CHAT_SERVICE_SUBJECT];
export const reservedAudienceError = (audience: string) =>
  `The Harness audience ${audience} is reserved for another kind of BotCube token`;
const harnessAuth = z.discriminatedUnion('kind', [
  kindOnly('sigv4'),
  z.strictObject({
    kind: z.literal('jwt-bearer'),
    ...trust(
      z.union([z.literal('botcube'), oidcDiscoveryUrl], { error: "Expected 'botcube' or an https OIDC discovery URL ending in /.well-known/openid-configuration" })
        .default('botcube')
        .describe("`botcube`, the Chat Service at its public origin signing with its Turn identity keys; or an outside issuer's OIDC discovery URL."),
      z.strictObject({
        clientId: z.string().min(1)
          .refine((audience) => !RESERVED_AUDIENCES.includes(audience), { error: (issue) => reservedAudienceError(String(issue.input)) })
          .describe("A client the Runtime's JWT authorizer allows: under `botcube`, a bearer's `aud`, Chat signing for the first; under an outside issuer, its `client_id`, so the issuer's other clients can't call the Harness."),
      }),
    ),
    token: credentialSource.optional().describe("The bearer Chat sends under an outside issuer, read again before it expires; required for a discovery URL issuer."),
  }).transform(({ token, ...auth }, context): Exclude<HarnessAuth<CredentialSource>, { kind: 'sigv4' }> => {
    if (auth.issuer === 'botcube') {
      if (token !== undefined) context.addIssue({ code: 'custom', path: ['token'], message: 'Chat signs its own bearer for the botcube issuer; token is for an issuer at a discovery URL' });
      return { kind: auth.kind, issuer: auth.issuer, clients: auth.clients };
    }
    if (token === undefined) {
      context.addIssue({ code: 'custom', path: ['token'], message: 'An issuer at a discovery URL needs the token Chat sends it, a Credential Source' });
      return z.NEVER;
    }
    return { kind: auth.kind, issuer: auth.issuer, clients: auth.clients, token };
  }).describe("A bearer token the AgentCore Runtime's JWT authorizer checks: one Chat signs with its Turn identity keys, or an outside issuer's from `token`."),
]);
/** Fails to compile when the schema and the `HarnessAuth` seam drift apart. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
true satisfies Same<z.infer<typeof harnessAuth>, HarnessAuth<CredentialSource>>;
const awsAccess = z.discriminatedUnion('kind', [
  kindOnly('web-identity'),
  kindOnly('assume-role').describe('The Chat Service assumes the Memory role for each Turn with a session policy naming its User; no OIDC provider or session tags.'),
]);
const schedules = z.discriminatedUnion('kind', [
  kindOnly('eventbridge-scheduler'),
  z.strictObject({ kind: z.literal('table-poller') }).describe('The Chat Service polls its own table and sends each due run to the run queue.'),
  kindOnly('none').describe('No scheduled tasks: the Chat Service offers none, and no queue, schedule group or scheduler grant is created.'),
]);
const liveView = z.discriminatedUnion('kind', [
  kindOnly('agentcore-browser').describe("The Agent Computer's browser streams its live view from AgentCore Browser to the User."),
  kindOnly('none').describe('No live view: bot settings may not turn agentComputer.liveBrowser on, and the Chat Service is granted no live view stream.'),
]);

// Plain parameters (ADR 0091): no seam and no `kind`; each points at something the integrator already runs.

const httpUrl = z.url({ protocol: /^https?$/ });

const telemetry = z.discriminatedUnion('kind', [
  kindOnly('xray').describe("AWS X-Ray, through each service's collector."),
  z.strictObject({
    kind: z.literal('otlp'),
    url: httpUrl.describe('The OTLP/HTTP traces endpoint the services export to, such as http://collector:4318/v1/traces.'),
    credential: credentialSource.optional().describe('Sent as `Authorization: Bearer <value>`; absent, exports are unauthenticated.'),
    headers: endpointHeaders,
    tls: endpointTls.optional(),
    proxy: proxyReference.optional(),
  }).refine(({ url, tls }) => tls === undefined || url.startsWith('https:'), { path: ['tls'], message: 'TLS needs the OTLP Endpoint at an https URL' })
    .describe("The operator's own OTLP collector, an Endpoint both services export to directly."),
  kindOnly('none').describe('No traces leave the services, and no collector or X-Ray grant is created.'),
]);

/** The BotCube Config's sections, for a process that reads some of them; `botcubeConfig` checks the whole file. */
export const configSections = z.strictObject({
  $schema: schemaReference,
  ...deploymentKeys,
  allowCommandCredentials: z
    .boolean()
    .default(false)
    .describe('Whether a credential may come from a command, which then runs as the service; whoever can edit this file chooses that command.'),
  caBundle: absolutePath.optional().describe(
    'A PEM file of the roots every process checks the proxy and endpoints against, as SSL_CERT_FILE, NODE_EXTRA_CA_CERTS and REQUESTS_CA_BUNDLE; loaded at startup. Absent, each image keeps its own.',
  ),
  integrations: z.strictObject({
    signIn: identity.default({ kind: 'botcube-accounts' }).describe('How Users sign in.'),
    modelGateway: models.default({ kind: 'bedrock' }).describe('Where models run.'),
    harnessAuth: harnessAuth.prefault({ kind: 'sigv4' }),
    awsAccess: awsAccess.default({ kind: 'web-identity' }),
    imageRegistry,
    telemetry: telemetry.default({ kind: 'xray' }),
    relayProviders,
    proxy: forwardProxy.default({ kind: 'none' }),
  }).prefault({}),
  services,
  agentCore,
  network: z.strictObject({
    natGateways,
    publicIp,
    openEgress,
  }).prefault({}),
  cloudflare,
  schedules: schedules.default({ kind: 'eventbridge-scheduler' }),
  liveView: liveView.default({ kind: 'agentcore-browser' }),
  existing,
  planUsage: z.strictObject({
    ownerAccountId: z.string().regex(/^acct_[A-Za-z0-9_-]{5,123}$/, 'Expected an Account id, acct_ and its token')
      .describe('The Account whose linked plans they run on.'),
  }).optional().describe('BotCube-owned: Plan Usage, whose models run on a linked plan.'),
  parking,
  alarms,
});


/** Every Endpoint TLS block the BotCube Config names, by its path. */
export function tlsFields({ integrations: { modelGateway: models, telemetry, proxy } }: z.output<typeof configSections>): [path: string[], tls: EndpointTls][] {
  return [
    ...(models.kind === 'openai-compatible' && models.tls ? [[['integrations','modelGateway', 'tls'], models.tls] satisfies [string[], EndpointTls]] : []),
    ...(proxy.kind === 'forward' && proxy.tls ? [[['integrations','proxy', 'tls'], proxy.tls] satisfies [string[], EndpointTls]] : []),
    ...(telemetry.kind === 'otlp' && telemetry.tls ? [[['integrations','telemetry', 'tls'], telemetry.tls] satisfies [string[], EndpointTls]] : []),
  ];
}

/** Every command the BotCube Config may run, by its path: a command credential or client certificate. */
export function commandFields(config: z.output<typeof configSections>): (string | number)[][] {
  return [
    ...credentialFields(config).filter(([, source]) => source.kind === 'command').map(([path]) => path),
    ...tlsFields(config).filter(([, tls]) => tls.clientCertificate && 'command' in tls.clientCertificate).map(([path]) => [...path, 'clientCertificate']),
  ];
}

/** Every Credential Source the BotCube Config names, by its path. */
export function credentialFields({ integrations: { signIn: identity, modelGateway: models, harnessAuth, telemetry, proxy } }: z.output<typeof configSections>): CredentialField[] {
  const fields: CredentialField[] = [
    ...(outsideIssuer(harnessAuth) ? [[['integrations','harnessAuth', 'token'], harnessAuth.token] satisfies CredentialField] : []),
    ...(proxy.kind === 'forward' && proxy.credential ? [[['integrations','proxy', 'credential'], proxy.credential] satisfies CredentialField] : []),
    ...(telemetry.kind === 'otlp' && telemetry.credential ? [[['integrations','telemetry', 'credential'], telemetry.credential] satisfies CredentialField] : []),
    ...(identity.kind === 'oidc' ? identity.clients.map(({ clientSecret }, index): CredentialField => [['integrations','signIn', 'clients', index, 'clientSecret'], clientSecret]) : []),
    ...(models.kind === 'openai-compatible' ? [[['integrations','modelGateway', 'credential'], models.credential] satisfies CredentialField] : []),
    ...(models.kind === 'openai-compatible' ? Object.entries<{ credential?: CredentialSource | undefined } | undefined>(models.providers ?? {}).flatMap(([provider, route]): CredentialField[] => route?.credential ? [[['integrations', 'modelGateway', 'providers', provider, 'credential'], route.credential]] : []) : []),
  ];
  return fields.flatMap(withClientSecret);
}

export const botcubeConfig = configSections.superRefine((config, context) => {
  for (const path of config.allowCommandCredentials ? [] : commandFields(config)) {
    const runs = path.at(-1) === 'clientCertificate' ? 'A command client certificate' : 'A command credential';
    context.addIssue({ code: 'custom', path, message: `${runs} runs only when allowCommandCredentials is true` });
  }
  for (const [path, source] of credentialFields(config)) {
    if (source.kind === 'botcube') {
      context.addIssue({ code: 'custom', path, message: 'A botcube token is the Harness bearer, which the Chat Service signs for harnessAuth; no configured credential takes one' });
    }
  }
  for (const path of config.integrations.proxy.kind === 'none' ? proxiedFields(config) : []) {
    context.addIssue({ code: 'custom', path, message: 'names integrations.proxy, which is none' });
  }
  for (const path of natRouteTables(config)) {
    context.addIssue({ code: 'custom', path, message: 'With network.natGateways 1, BotCube routes each private subnet to the NAT: give its route table' });
  }
});

/** Every section's default, for a process that runs without a BotCube Config: the keys a file must give are absent. */
export const sectionDefaults = () => configSections.partial({ name: true, env: true, domains: true, existing: true }).parse({});

export type BotSettings = z.output<typeof botSettings>;
export type BotCubeConfig = z.output<typeof botcubeConfig>;


/** The JSON Schemas of the files integrators write, for editors and for processes outside TypeScript. */
export const jsonSchemas = () => ({
  'bot.schema.json': { ...z.toJSONSchema(botSettings, { io: 'input' }), 'x-renamed-keys': renamedBotKeys },
  'botcube.schema.json': { ...z.toJSONSchema(botcubeConfig, { io: 'input' }), 'x-renamed-keys': renamedKeys, 'x-retired-files': RETIRED_FILES },
});

/** Where a schema is committed besides here, relative to this file: the Python packages check their files with it. */
export const jsonSchemaCopies: Readonly<Partial<Record<string, readonly string[]>>> = {
  'bot.schema.json': ['../harness/deepagents/src/botcube_harness_deepagents/bot.schema.json'],
  'botcube.schema.json': [
    '../credential-service/src/botcube_credential_service/botcube.schema.json',
    '../harness/deepagents/src/botcube_harness_deepagents/botcube.schema.json',
  ],
};
