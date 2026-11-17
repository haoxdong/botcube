import { z } from 'zod';

// The seam integrators depend on (ADR 0091): the bot settings and the Deployment Config.
// Every object is strict, so an unknown key fails startup instead of being ignored.

const schemaReference = z.string().optional().describe('The JSON Schema this file follows, for editors.');

const model = z.strictObject({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  provider: z.string().min(1).describe("Whose model it is: a Session's Turns all run on its first Turn's provider."),
});

// The built-in Web UI's settings, in their own block so other sections merge beside them.
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
    ...webUiSettings,
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

/** A secret the deployment reads at startup; its value never appears in the Deployment Config. */
export const secretReference = z
  .strictObject({ secretArn: z.string().regex(/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/) })
  .describe('A Secrets Manager secret, by ARN.');

// Each section lists its adapters, the open default first; a missing section is the default.
const defaultKind = <Kind extends string>(kind: Kind) => z.strictObject({ kind: z.literal(kind) });

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
const oidcIssuer = z.url().refine((issuer) => {
  const { protocol, hostname } = new URL(issuer);
  return protocol === 'https:' || (protocol === 'http:' && LOOPBACK.has(hostname));
}, 'An OIDC issuer is an https URL; only a stand-in on this machine may use http');

const identity = z.discriminatedUnion('kind', [
  defaultKind('botcube-accounts'),
  z.strictObject({
    kind: z.literal('oidc'),
    issuer: oidcIssuer.describe("The provider's issuer URL, where its OpenID configuration is discovered."),
    clientId: z.string().min(1),
    clientSecret: secretReference,
    subjectIsAccountId: z.boolean().optional().describe(
      "The provider's subject is the User's account ID (acct_…): a new User's account takes it, and a returning User lands in the account it names.",
    ),
  }).describe('Users sign in with an OpenID Connect provider, by authorization code with PKCE.'),
]);
const models = z.discriminatedUnion('kind', [
  defaultKind('bedrock'),
  z.strictObject({
    kind: z.literal('openai-compatible'),
    baseUrl: z.url({ protocol: /^https$/ }).describe("The endpoint's OpenAI API base URL, such as https://models.example.com/v1."),
    apiKey: secretReference.describe("The endpoint's API key."),
    turnSummaryModel: z.string().min(1).describe('The model on the endpoint that summarizes each finished Turn for the Activity.'),
  }).describe("Every model on an OpenAI-compatible endpoint, by its key in the bot settings; Plan Usage models still run through the Credential Service."),
]);
/** The audience of each kind of token BotCube's Chat Service signs; botcube/chat signs with these. */
export const TOKEN_AUDIENCES = {
  /** The Turn identity's, which STS exchanges for Memory credentials: STS's own, as EKS and GitHub Actions use. */
  turnIdentity: 'sts.amazonaws.com',
  /** The signed user token's: a product's own service accepts a token only with it. */
  user: 'botcube-user',
} as const;
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
  defaultKind('sigv4'),
  z.strictObject({
    kind: z.literal('jwt-bearer'),
    audience: z.string().min(1)
      .refine((audience) => !RESERVED_AUDIENCES.includes(audience), { error: (issue) => reservedAudienceError(String(issue.input)) })
      .describe("The `aud` of Chat's tokens, which the Runtime's JWT authorizer allows."),
  }).describe("Chat signs a short-lived bearer token with its Turn identity keys, as the issuer at its public origin; the AgentCore Runtime's JWT authorizer checks it."),
]);
const turnCredentials = z.discriminatedUnion('kind', [
  defaultKind('web-identity'),
  defaultKind('assume-role').describe('The Chat Service assumes the Memory role for each Turn with a session policy naming its User; no OIDC provider or session tags.'),
]);
const schedules = z.discriminatedUnion('kind', [
  defaultKind('eventbridge-scheduler'),
  z.strictObject({ kind: z.literal('table-poller') }).describe('The Chat Service polls its own table and sends each due run to the run queue.'),
]);

// Plain parameters (ADR 0091): no seam and no `kind`; each points at something the integrator already runs.

const subnet = z.strictObject({ subnetId: z.string().regex(/^subnet-[0-9a-z]+$/), availabilityZone: z.string().min(1) });
const kmsKeyArn = z.string().regex(/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/.+$/).describe('A KMS key, by ARN.');
const tableName = z.string().regex(/^[a-zA-Z0-9_.-]{3,255}$/);
const bucketName = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
const STREAM_ARN = /^arn:aws[a-z-]*:dynamodb:[a-z0-9-]+:\d{12}:table\/([a-zA-Z0-9_.-]+)\/stream\/.+$/;

const existing = z
  .strictObject({
    network: z
      .strictObject({
        vpcId: z.string().regex(/^vpc-[0-9a-z]+$/),
        publicSubnets: z.array(subnet).min(2).describe("The origin load balancer's subnets."),
        privateSubnets: z
          .array(subnet.extend({ cidrBlock: z.string().min(1) }))
          .min(2)
          .describe("The services' and browsers' subnets, which must already reach the internet or the proxy."),
      })
      .optional(),
    kmsKeys: z
      .strictObject({
        vault: kmsKeyArn.optional().describe("Encrypts the Credential Service's vault."),
        sheet: kmsKeyArn.optional().describe('Decrypts what the Sign-in Sheet encrypts: an RSA_2048 ENCRYPT_DECRYPT key.'),
        memory: kmsKeyArn.optional().describe("Encrypts the agent's AgentCore Memory."),
        images: kmsKeyArn.optional().describe("Encrypts the bot's image repository."),
      })
      .optional(),
    tables: z
      .strictObject({
        chat: z
          .strictObject({ tableName, streamArn: z.string().regex(STREAM_ARN).describe("The table's NEW_IMAGE stream, which parking reads.") })
          .optional(),
        vault: z.strictObject({ tableName }).optional().describe("The Credential Service's vault: partition key accountId, sort key provider."),
      })
      .optional(),
    buckets: z
      .strictObject({
        connectionLogs: bucketName.optional().describe("The origin load balancer's connection logs."),
      })
      .optional(),
  })
  .superRefine(({ tables }, context) => {
    const chat = tables?.chat;
    const streamTable = chat && STREAM_ARN.exec(chat.streamArn)?.[1];
    if (chat && streamTable !== chat.tableName) {
      context.addIssue({ code: 'custom', path: ['tables', 'chat', 'streamArn'], message: `The stream is table ${streamTable}'s, not ${chat.tableName}'s` });
    }
  })
  .describe('Resources BotCube imports instead of creating; each one left out, it creates.');

const httpUrl = z.url({ protocol: /^https?$/ });

const telemetry = z.strictObject({
  otlpEndpoint: httpUrl.describe('The OTLP/HTTP traces endpoint the services export to, such as http://collector:4318/v1/traces.'),
});

const proxy = z.strictObject({
  url: httpUrl.describe('The forward proxy outbound HTTP and HTTPS go through, as HTTP_PROXY and HTTPS_PROXY.'),
  noProxy: z
    .array(z.string().min(1))
    .optional()
    .describe('Hosts and domain suffixes reached directly, as NO_PROXY; loopback and the AWS metadata addresses always are.'),
});

export const deploymentConfig = z.strictObject({
  $schema: schemaReference,
  bot: z.string().min(1).describe('The bot settings file, relative to this file.'),
  identity: identity.default({ kind: 'botcube-accounts' }).describe('How Users sign in.'),
  models: models.default({ kind: 'bedrock' }).describe('Where the agent and turn summaries reach their models.'),
  harnessAuth: harnessAuth.default({ kind: 'sigv4' }).describe('How Chat authenticates to the Harness.'),
  turnCredentials: turnCredentials.default({ kind: 'web-identity' }).describe("How each Turn gets its User's AWS credentials."),
  schedules: schedules.default({ kind: 'eventbridge-scheduler' }).describe('What fires scheduled tasks.'),
  existing: existing.optional(),
  telemetry: telemetry.optional().describe('Where traces go; absent, AWS X-Ray.'),
  proxy: proxy.optional().describe('The proxy outbound traffic goes through; absent, it goes direct.'),
});

export type BotSettings = z.output<typeof botSettings>;
export type DeploymentConfig = z.output<typeof deploymentConfig>;

/** The JSON Schemas of the files integrators write, for editors and for processes outside TypeScript. */
export const jsonSchemas = () => ({
  'bot-settings.schema.json': z.toJSONSchema(botSettings, { io: 'input' }),
  'deployment-config.schema.json': z.toJSONSchema(deploymentConfig, { io: 'input' }),
});

/** Where a schema is committed besides here, relative to this file: the Harness checks the bot settings in Python. */
export const jsonSchemaCopies: Readonly<Partial<Record<string, readonly string[]>>> = {
  'bot-settings.schema.json': ['../harness/deepagents/src/botcube_harness_deepagents/bot-settings.schema.json'],
};
