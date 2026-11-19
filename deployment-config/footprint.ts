import { outsideIssuer } from './credential-fields.js';
import type { DeploymentConfig } from './schema.js';
import type { CredentialSource } from './blocks.js';

const XRAY = ['xray:PutTelemetryRecords', 'xray:PutTraceSegments'];

/** The roles BotCube's processes run as. A role the deploy machinery alone uses (custom resources, image builds, ops) is not one. */
export const PRINCIPALS = {
  chatService: 'Chat Service task',
  credentialService: 'Credential Service task',
  scheduledRuns: 'EventBridge Scheduler, sending scheduled runs to their queue',
  agentComputerBrowser: 'Agent Computer browser',
  filesMount: "a Turn's Files mount",
  filesLinks: 'Files links function',
  harness: 'Harness (AgentCore Runtime)',
  sessionApi: 'session API function',
  userMemory: "a Turn's own Memory credentials",
} as const;

export type Principal = keyof typeof PRINCIPALS;

export interface Grant {
  readonly actions: readonly string[];
  /** AWS managed policies by name, such as `AWSLambdaBasicExecutionRole`. */
  readonly managedPolicies?: readonly string[];
}

export interface Need {
  readonly iam?: Partial<Record<Principal, Grant>>;
  /** `<region>` stands for the deployment's Region. */
  readonly egressHosts?: readonly string[];
  readonly supplied?: readonly SuppliedResource[];
  /** Each command credential, as `<field> (<principals>): <command>`. */
  readonly commands?: readonly string[];
  /** Sidecar images pulled from the image registry, by their path in it. */
  readonly pulled?: readonly string[];
}

/** A resource the operator supplies instead of BotCube creating it, and the grants they give on it in its place. */
export interface SuppliedResource {
  /** Where the Deployment Config supplies it, such as `supplied.tables.chat`. */
  readonly field: string;
  /** Its ARN, ID or name, as the Deployment Config gives it. */
  readonly name: string;
  readonly grants: readonly { readonly to: string; readonly actions: readonly string[] }[];
}

export interface Footprint {
  readonly supplied: SuppliedResource[];
  /** What BotCube creates that the Deployment Config could supply instead, as `<field>: <what it is>`. */
  readonly created: string[];
  readonly iam: Partial<Record<Principal, { actions: string[]; managedPolicies: string[] }>>;
  readonly egressHosts: string[];
  /** The images the deployment runs. */
  readonly images: string[];
  /** The images BotCube builds its own FROM. */
  readonly buildImages: string[];
  /** The commands the deployment's processes may run for a credential, which a reviewer approves one by one. */
  readonly commands: string[];
}

/** The images BotCube deploys; a bot's own image is built FROM the Harness image and stands in for it. */
export const IMAGES = {
  chatService: 'botcube-chat-service',
  credentialService: 'botcube-credential-service',
  bot: 'bot (FROM the BotCube Harness image)',
} as const;

/** The images BotCube pulls, by their path in the image registry: its sidecars, then what its own images are built FROM. */
const PULLED = {
  build: ['docker/library/nginx:stable-alpine', 'docker/library/node:24-bookworm-slim', 'docker/library/python:3.13-slim', 'docker/library/rust:1.88-slim-bookworm',
    'lambda/python:3.13', 'sam/build-python3.12'],
};

const CHAT_TABLE_ACTIONS = ['BatchGetItem', 'BatchWriteItem', 'ConditionCheckItem', 'DeleteItem', 'DescribeTable', 'GetItem', 'GetRecords',
  'GetShardIterator', 'PutItem', 'Query', 'Scan', 'UpdateItem'].map(action => `dynamodb:${action}`);
const BROWSERS = ['ConnectBrowserAutomationStream', 'CreateBrowserProfile', 'DeleteBrowserProfile', 'GetBrowser',
  'GetBrowserSession', 'ListBrowserSessions', 'SaveBrowserSessionProfile', 'StartBrowserSession', 'StopBrowserSession', 'UpdateBrowserStream']
  .map(action => `bedrock-agentcore:${action}`);
const VPC_ACCESS = 'AWSLambdaVPCAccessExecutionRole';
const EFS_CLIENT = ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'];
const SCHEDULED_RUNS_CONSUMER = ['ChangeMessageVisibility', 'DeleteMessage', 'GetQueueAttributes', 'GetQueueUrl', 'ReceiveMessage'].map(action => `sqs:${action}`);
const aws = (...services: string[]) => services.map(service => `${service}.<region>.amazonaws.com`);

/** What BotCube's own services need under every Deployment Config. */
const BUILT_IN: Need = {
  iam: {
    chatService: { actions: [
      ...BROWSERS, ...EFS_CLIENT, ...SCHEDULED_RUNS_CONSUMER,
      // Files: the access-point pool, and the role each Turn's Files mount assumes.
      'elasticfilesystem:CreateAccessPoint', 'elasticfilesystem:DeleteAccessPoint', 'elasticfilesystem:DescribeAccessPoints', 'sts:AssumeRole',
      // The Agent Computer's Chrome policy.
      's3:GetBucket*', 's3:GetObject*', 's3:List*',
      'ecs:DescribeTasks', 'ssm:GetParameterHistory',
    ] },
    credentialService: { actions: ['bedrock-agentcore:ConnectBrowserAutomationStream', 'bedrock-agentcore:GetBrowserSession'] },
    agentComputerBrowser: { actions: EFS_CLIENT },
    filesMount: { actions: EFS_CLIENT },
    filesLinks: { actions: EFS_CLIENT, managedPolicies: ['AWSLambdaBasicExecutionRole', VPC_ACCESS] },
    harness: { actions: [
      'ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetAuthorizationToken', 'ecr:GetDownloadUrlForLayer',
      'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:PutLogEvents',
    ] },
    sessionApi: {
      actions: ['BatchUpdateMemoryRecords', 'CreateEvent', 'DeleteEvent', 'DeleteMemoryRecord', 'GetEvent', 'ListEvents', 'ListMemoryRecords', 'ListSessions']
        .map(action => `bedrock-agentcore:${action}`),
      managedPolicies: ['AWSLambdaBasicExecutionRole'],
    },
  },
  egressHosts: [
    ...aws('bedrock-agentcore', 'dynamodb', 'ecs', 'elasticfilesystem', 'kms', 'logs', 's3', 'sqs', 'ssm', 'sts'),
    // Plan Usage, which the Credential Service reads with a User's OpenAI sign-in.
    'auth.openai.com', 'api.openai.com',
  ],
};

const VAULT_TABLE_ACTIONS = ['ConditionCheckItem', 'DeleteItem', 'GetItem', 'PutItem', 'Query', 'UpdateItem'].map(action => `dynamodb:${action}`);
const KEY_USE = ['kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey'];
const PARKING = 'production parking functions';
const ORIGIN_SMOKE = "the deploy role's origin smoke test";

type Supplied = NonNullable<DeploymentConfig['supplied']>;
interface Suppliable {
  /** What BotCube creates in its place; absent, it creates nothing, as for AgentCore Memory on its AWS owned key. */
  readonly created?: string;
  readonly name: (supplied: Supplied) => string | undefined;
  /** What a BotCube role needs on it, granted when BotCube creates it and supplied with it otherwise. */
  readonly grant?: { readonly to: Principal; readonly actions: readonly string[] };
  /** What the deploy machinery and AWS services need on it, granted the same way. */
  readonly others?: Readonly<Record<string, readonly string[]>>;
}

/** Each resource BotCube creates unless the Deployment Config supplies it with its grants (ADR 0091). */
const SUPPLIABLE: Readonly<Record<string, Suppliable>> = {
  network: {
    created: "the private subnets' NAT gateway, its Elastic IP and route",
    name: ({ network }) => network?.vpcId,
    others: { "every other Lambda function's role, the deploy's own included": [`AWS managed policy ${VPC_ACCESS}`] },
  },
  'kmsKeys.vault': { created: "the Credential Service's vault key", name: ({ kmsKeys }) => kmsKeys?.vault, grant: { to: 'credentialService', actions: KEY_USE } },
  'kmsKeys.sheet': { created: "the Sign-in Sheet's RSA key", name: ({ kmsKeys }) => kmsKeys?.sheet, grant: { to: 'credentialService', actions: ['kms:Decrypt', 'kms:GetPublicKey'] } },
  'kmsKeys.memory': { name: ({ kmsKeys }) => kmsKeys?.memory, others: { 'AgentCore Memory execution role': KEY_USE } },
  'kmsKeys.images': { created: "the bot image repository's key", name: ({ kmsKeys }) => kmsKeys?.images, grant: { to: 'harness', actions: ['kms:Decrypt'] } },
  'tables.chat': {
    created: 'the chat table and its stream',
    name: ({ tables }) => tables?.chat?.tableName,
    grant: { to: 'chatService', actions: CHAT_TABLE_ACTIONS },
    others: {
      [PARKING]: ['DeleteItem', 'DescribeStream', 'GetItem', 'GetRecords', 'GetShardIterator', 'ListStreams', 'PutItem', 'Query', 'UpdateItem'].map(action => `dynamodb:${action}`),
      [ORIGIN_SMOKE]: ['dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    },
  },
  'tables.vault': { created: "the Credential Service's vault table", name: ({ tables }) => tables?.vault?.tableName, grant: { to: 'credentialService', actions: VAULT_TABLE_ACTIONS } },
  'buckets.connectionLogs': {
    created: "the origin load balancer's connection logs bucket",
    name: ({ buckets }) => buckets?.connectionLogs,
    others: { 'Elastic Load Balancing log delivery': ['s3:PutObject'] },
  },
};

/** Each resource BotCube would create: supplied, with the grants on it moved to its entry, or created and granted. */
function suppliedResources({ supplied = {}, identity }: DeploymentConfig): { need: Need; created: string[] } {
  const entries = Object.entries(SUPPLIABLE).map(([key, resource]) => ({ key, resource, name: resource.name(supplied) }));
  const suppliedEntries: SuppliedResource[] = entries.flatMap(({ key, resource, name }) => (name === undefined ? [] : [{
    field: `supplied.${key}`,
    name,
    grants: [
      ...(resource.grant ? [{ to: PRINCIPALS[resource.grant.to], actions: resource.grant.actions }] : []),
      ...Object.entries(resource.others ?? {}).map(([to, actions]) => ({ to, actions })),
    ],
  }]));
  const providerResources = identity.kind === 'oidc'
    ? (identity.resources ?? []).map(({ type, name }) => ({ field: 'identity.resources', name: `${type} ${name}`, grants: [] }))
    : [];
  const createdEntries = entries.filter(({ name }) => name === undefined);
  const iam: Partial<Record<Principal, Grant>> = {};
  for (const { resource: { grant } } of createdEntries) {
    if (grant) iam[grant.to] = { actions: [...(iam[grant.to]?.actions ?? []), ...grant.actions] };
  }
  if (supplied.network) iam.sessionApi = { actions: [], managedPolicies: [VPC_ACCESS] };
  return {
    need: { iam, supplied: [...suppliedEntries, ...providerResources] },
    created: createdEntries.flatMap(({ key, resource }) => (resource.created ? [`supplied.${key}: ${resource.created}`] : [])),
  };
}

/** The fields with no `kind`: the bot, and the plain parameters (supplied resources, the image registry). */
type Section = Exclude<keyof DeploymentConfig, '$schema' | 'bot' | 'allowCommandCredentials' | 'supplied' | 'imageRegistry'>;

/** An adapter's need: fixed, or read from its section, such as the host it names. */
type AdapterNeed<Config> = Need | ((config: Config) => Need | Need[]);

/** Each section's adapters by `kind`: a kind the schema adds without an entry here fails to type-check. */
const ADAPTERS: { readonly [S in Section]: { readonly [K in DeploymentConfig[S]['kind']]: AdapterNeed<Extract<DeploymentConfig[S], { kind: K }>> } } = {
  identity: {
    // Accounts live in the chat table the Chat Service already holds.
    'botcube-accounts': {},
    // The Chat Service discovers the provider and redeems sign-in codes with the client secret it reads.
    oidc: ({ issuer, clients }) => [
      { egressHosts: [new URL(issuer).host] },
      ...clients.map(({ clientSecret }, index) => credentialNeed(`identity.clients.${index}.clientSecret`, clientSecret, ['chatService'])),
    ],
  },
  models: {
    bedrock: {
      iam: {
        chatService: { actions: ['bedrock:InvokeModel'] },
        harness: { actions: ['bedrock:CountTokens', 'bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'] },
      },
      egressHosts: aws('bedrock-runtime'),
    },
    // Both read the endpoint's credential, the Harness for the agent and the Chat Service for turn summaries.
    'openai-compatible': ({ url, credential }) => [{ egressHosts: [new URL(url).host] }, credentialNeed('models.credential', credential, ['chatService', 'harness'])],
  },
  harnessAuth: {
    sigv4: {
      iam: { chatService: { actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession', 'lambda:InvokeFunction'] } },
      egressHosts: aws('bedrock-agentcore', 'lambda'),
    },
    'jwt-bearer': (auth) => [
      { iam: { chatService: { actions: ['lambda:InvokeFunction'] } }, egressHosts: aws('bedrock-agentcore', 'lambda') },
      ...(outsideIssuer(auth) ? [{ egressHosts: [new URL(auth.issuer).host] }, credentialNeed('harnessAuth.token', auth.token, ['chatService'])] : []),
    ],
  },
  turnCredentials: {
    'web-identity': {
      iam: {
        userMemory: { actions: ['CreateEvent', 'DeleteEvent', 'DeleteMemoryRecord', 'GetEvent', 'GetMemoryRecord', 'ListEvents', 'ListMemoryRecords',
          'RetrieveMemoryRecords'].map(action => `bedrock-agentcore:${action}`) },
      },
      egressHosts: aws('sts'),
    },
    'assume-role': {
      iam: {
        chatService: { actions: ['sts:AssumeRole'] },
        userMemory: { actions: ['CreateEvent', 'DeleteEvent', 'DeleteMemoryRecord', 'GetEvent', 'GetMemoryRecord', 'ListEvents', 'ListMemoryRecords',
          'RetrieveMemoryRecords'].map(action => `bedrock-agentcore:${action}`) },
      },
      egressHosts: aws('sts'),
    },
  },
  schedules: {
    'eventbridge-scheduler': {
      iam: {
        chatService: { actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule', 'scheduler:GetScheduleGroup',
          'scheduler:UpdateSchedule', 'iam:PassRole'] },
        scheduledRuns: { actions: ['sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage'] },
      },
      egressHosts: aws('scheduler'),
    },
    // The Chat Service fires the schedules in its own table into its own run queue.
    'table-poller': { iam: { chatService: { actions: ['sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage'] } } },
    none: {},
  },
  liveView: {
    'agentcore-browser': { iam: { chatService: { actions: ['bedrock-agentcore:ConnectBrowserLiveViewStream'] } } },
    none: {},
  },
  telemetry: {
    // Each service's spans go to X-Ray: the Chat Service's through its collector sidecar.
    xray: {
      iam: { chatService: { actions: XRAY }, harness: { actions: XRAY } },
      egressHosts: aws('xray'),
      pulled: ['aws-observability/aws-otel-collector:v0.50.0'],
    },
    // Both services export straight to the Endpoint with the credential they read.
    // AgentCore's Runtime construct grants the Harness X-Ray unless telemetry is none.
    otlp: ({ url, credential }) => [{ egressHosts: [new URL(url).host], iam: { harness: { actions: XRAY } } }, ...(credential ? [credentialNeed('telemetry.credential', credential, ['chatService', 'harness'])] : [])],
    none: {},
  },
  proxy: {
    // Every service and browser reaches the internet through it; the Chat Service and the Harness relay to it with its credential.
    forward: ({ url, credential }) => [{ egressHosts: [new URL(url).host] }, ...(credential ? [credentialNeed('proxy.credential', credential, ['chatService', 'harness'])] : [])],
    none: {},
  },
};

/** What reading `credential` at `field` needs of each of its `readers`: a secret's grant, a command they may run, or a token endpoint they reach. */
function credentialNeed(field: string, credential: CredentialSource, readers: readonly Principal[]): Need {
  switch (credential.kind) {
    case 'secret':
      return { iam: Object.fromEntries(readers.map(reader => [reader, { actions: ['secretsmanager:GetSecretValue'] }])), egressHosts: aws('secretsmanager') };
    // The process signs an aws source with its own credentials, and a botcube one with the Chat Service's keys.
    case 'file':
    case 'aws':
    case 'botcube':
      return {};
    case 'command':
      return { commands: [`${field} (${readers.join(', ')}): ${credential.command.join(' ')}`] };
    case 'oauth-client-credentials': {
      const secret = credentialNeed(`${field}.clientSecret`, credential.clientSecret, readers);
      return { ...secret, egressHosts: [new URL(credential.tokenEndpoint).host, ...(secret.egressHosts ?? [])] };
    }
  }
}

/** The supplied and created resources, IAM actions, egress hosts, images and commands this Deployment Config needs. */
export function footprint(config: DeploymentConfig): Footprint {
  const resources = suppliedResources(config);
  const needs = [BUILT_IN, ...(Object.keys(ADAPTERS) as Section[]).flatMap(section => adapter(section, config[section])), resources.need];
  const iam: Footprint['iam'] = {};
  for (const principal of Object.keys(PRINCIPALS) as Principal[]) {
    const grants = needs.flatMap(need => need.iam?.[principal] ?? []);
    if (grants.length) iam[principal] = {
      actions: sorted(grants.flatMap(grant => grant.actions)),
      managedPolicies: sorted(grants.flatMap(grant => grant.managedPolicies ?? [])),
    };
  }
  const pulled = (paths: readonly string[]) => paths.map(image => `${config.imageRegistry}/${image}`);
  return {
    supplied: needs.flatMap(need => need.supplied ?? []).map(resource => ({ ...resource, grants: resource.grants.map(({ to, actions }) => ({ to, actions: sorted(actions) })) })),
    created: resources.created,
    iam,
    egressHosts: sorted(needs.flatMap(need => need.egressHosts ?? [])),
    images: sorted([...Object.values(IMAGES), ...pulled(needs.flatMap(need => need.pulled ?? []))]),
    buildImages: sorted(pulled(PULLED.build)),
    commands: sorted(needs.flatMap(need => need.commands ?? [])),
  };
}

function adapter(section: Section, config: { kind: string }): Need[] {
  const need = (ADAPTERS[section] as Partial<Record<string, AdapterNeed<typeof config>>>)[config.kind];
  if (!need) throw new Error(`${section}.kind: no footprint for adapter "${config.kind}"`);
  return [typeof need === 'function' ? need(config) : need].flat();
}

const sorted = (values: readonly string[]) => [...new Set(values)].sort();

/** The footprint as a security reviewer reads it. */
export function formatFootprint({ supplied, created, iam, egressHosts, images, buildImages, commands }: Footprint): string {
  const roles = (Object.entries(iam) as [Principal, { actions: string[]; managedPolicies: string[] }][]).flatMap(([principal, grant]) => [
    `  ${principal} (${PRINCIPALS[principal]})`,
    ...grant.actions.map(action => `    ${action}`),
    ...grant.managedPolicies.map(policy => `    AWS managed policy ${policy}`),
  ]);
  return [
    'Supplied resources', ...supplied.flatMap(({ field, name, grants }) => [
      `  ${field} ${name}`,
      ...grants.map(({ to, actions }) => `    grant ${to}: ${actions.join(' ')}`),
    ]),
    'Created resources', ...created.map(resource => `  ${resource}`),
    'IAM actions', ...roles,
    'Egress hosts', ...egressHosts.map(host => `  ${host}`),
    'Images', ...images.map(image => `  ${image}`),
    'Build images', ...buildImages.map(image => `  ${image}`),
    'Commands', ...commands.map(command => `  ${command}`),
  ].join('\n') + '\n';
}
