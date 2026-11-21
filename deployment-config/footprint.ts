import { outsideIssuer } from './credential-fields.js';
import type { DeploymentConfig } from './schema.js';
import type { CredentialSource, EndpointTls } from './blocks.js';
import { PRINCIPALS, type Principal } from './principals.js';
import { NETWORK_INTERFACES, SUPPLIABLE } from './suppliable.js';

const XRAY = ['xray:PutTelemetryRecords', 'xray:PutTraceSegments'];
const OWN_LOGS = ['logs:CreateLogStream', 'logs:PutLogEvents'];

export interface Grant {
  readonly actions: readonly string[];
  /** AWS managed policies by name, such as `AWSLambdaBasicExecutionRole`. */
  readonly managedPolicies?: readonly string[];
}

export interface Need {
  readonly iam?: Partial<Record<Principal, Grant>>;
  /** `<region>` stands for the deployment's Region. */
  readonly egressHosts?: readonly string[];
  readonly egressFrom?: Readonly<Record<string, readonly Principal[]>>;
  readonly supplied?: readonly SuppliedResource[];
  /** Each command credential, as `<field> (<principals>): <command>`. */
  readonly commands?: readonly string[];
  /** As `Footprint.tls`. */
  readonly tls?: readonly string[];
  /** Sidecar images pulled from the image registry, by their path in it. */
  readonly pulled?: readonly string[];
  /** As `Footprint.runtime`. */
  readonly runtime?: readonly string[];
}

/** A resource the operator supplies instead of BotCube creating it, and the grants they give on it in its place. */
export interface SuppliedResource {
  /** Where the Deployment Config supplies it, such as `supplied.tables.chat`. */
  readonly field: string;
  /** Its ARN, ID or name, as the Deployment Config gives it. */
  readonly name: string;
  readonly grants: readonly { readonly to: string; readonly actions: readonly string[]; readonly on?: string }[];
}

export interface Footprint {
  readonly supplied: SuppliedResource[];
  /** What BotCube creates that the Deployment Config could supply instead, as `<field>: <what it is>`. */
  readonly created: string[];
  /** AWS infrastructure BotCube creates after deploy, as `<action> on <resource> (<who>, <when>)`. */
  readonly runtime: string[];
  readonly iam: Partial<Record<Principal, { actions: string[]; managedPolicies: string[] }>>;
  /** Where the models run, and over which wire an OpenAI-compatible Endpoint is called. */
  readonly models: string;
  readonly egressHosts: string[];
  readonly egressFrom: Partial<Record<string, Principal[]>>;
  /** The images the deployment runs. */
  readonly images: string[];
  /** The images BotCube builds its own FROM. */
  readonly buildImages: string[];
  /** The commands the deployment's processes may run for a credential, which a reviewer approves one by one. */
  readonly commands: string[];
  /** Each Endpoint's TLS, as `<field> (<principals>): <identity and certificate source>`; never key material. */
  readonly tls: string[];
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

const BROWSERS = ['ConnectBrowserAutomationStream', 'CreateBrowserProfile', 'DeleteBrowserProfile', 'GetBrowser',
  'GetBrowserSession', 'ListBrowserSessions', 'SaveBrowserSessionProfile', 'StartBrowserSession', 'StopBrowserSession', 'UpdateBrowserStream']
  .map(action => `bedrock-agentcore:${action}`);
const SCHEDULED_RUNS_CONSUMER = ['ChangeMessageVisibility', 'DeleteMessage', 'GetQueueAttributes', 'GetQueueUrl', 'ReceiveMessage'].map(action => `sqs:${action}`);
const aws = (...services: string[]) => services.map(service => `${service}.<region>.amazonaws.com`);

/** What BotCube's own services need under every Deployment Config. */
const BUILT_IN: Need = {
  iam: {
    chatService: { actions: [
      ...BROWSERS, ...SCHEDULED_RUNS_CONSUMER,
      // Files: the role each Turn's Files mount assumes.
      'sts:AssumeRole',
      // The Agent Computer's Chrome policy.
      's3:GetBucket*', 's3:GetObject*', 's3:List*',
      'ecs:DescribeTasks', 'ssm:GetParameterHistory',
    ] },
    credentialService: { actions: ['bedrock-agentcore:ConnectBrowserAutomationStream', 'bedrock-agentcore:GetBrowserSession'] },
    auditCopy: { actions: OWN_LOGS },
    harness: { actions: [
      'ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetAuthorizationToken', 'ecr:GetDownloadUrlForLayer',
      'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:PutLogEvents',
    ] },
    sessionApi: {
      actions: ['BatchUpdateMemoryRecords', 'CreateEvent', 'DeleteEvent', 'DeleteMemoryRecord', 'GetEvent', 'ListEvents', 'ListMemoryRecords', 'ListSessions']
        .map(action => `bedrock-agentcore:${action}`).concat(OWN_LOGS),
    },
  },
  egressHosts: [
    ...aws('bedrock-agentcore', 'dynamodb', 'ecs', 'elasticfilesystem', 'kms', 'logs', 's3', 'sqs', 'ssm', 'sts'),
    // Plan Usage, which the Credential Service reads with a User's OpenAI sign-in.
    'auth.openai.com', 'api.openai.com',
  ],
};

export type FilesAccessPointMode = 'runtime' | 'pool';
export interface FootprintOptions {
  /** Mirrors the CDK context: `runtime` (default) creates a User's access point on first use; `pool` leases a deploy-time one. */
  readonly filesAccessPointMode?: FilesAccessPointMode;
}

const FILES_ACCESS_POINTS: Readonly<Record<FilesAccessPointMode, Need>> = {
  runtime: {
    iam: { chatService: { actions: ['elasticfilesystem:CreateAccessPoint', 'elasticfilesystem:DeleteAccessPoint', 'elasticfilesystem:DescribeAccessPoints'] } },
    runtime: [`elasticfilesystem:CreateAccessPoint on the Files file system (Chat Service, on a User's first Files use)`],
  },
  pool: {},
};

/** Each resource BotCube would create: supplied, with the grants on it moved to its entry, or created and granted. */
function suppliedResources({ supplied = {}, identity }: DeploymentConfig): { need: Need; created: string[] } {
  const entries = Object.entries(SUPPLIABLE).map(([key, resource]) => ({ key, resource, name: resource.name(supplied) }));
  const suppliedEntries: SuppliedResource[] = entries.flatMap(({ key, resource, name }) => (name === undefined ? [] : [{
    field: `supplied.${key}`,
    name,
    grants: [
      ...(resource.grant ?? []).map(({ to, role, actions, on }) => ({
        to: role ? `${PRINCIPALS[to]} (role ${role})` : PRINCIPALS[to], actions, ...(on ? { on: on(name) } : {}),
      })),
      ...Object.entries(resource.others ?? {}).map(([to, actions]) => ({ to, actions })),
    ],
  }]));
  const providerResources = identity.kind === 'oidc'
    ? (identity.resources ?? []).map(({ type, name }) => ({ field: 'identity.resources', name: `${type} ${name}`, grants: [] }))
    : [];
  const createdEntries = entries.filter(({ name, resource }) => name === undefined && resource.created !== undefined);
  const iam: Partial<Record<Principal, Grant>> = {};
  for (const { resource: { grant } } of createdEntries) {
    for (const { to, actions } of grant ?? []) iam[to] = { actions: [...(iam[to]?.actions ?? []), ...actions] };
  }
  if (supplied.network) {
    iam.sessionApi = { actions: NETWORK_INTERFACES };
    iam.auditCopy = { actions: NETWORK_INTERFACES };
  }
  return {
    need: { iam, supplied: [...suppliedEntries, ...providerResources] },
    created: createdEntries.map(({ key, resource }) => `supplied.${key}: ${resource.created}`),
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
    'openai-compatible': ({ url, credential, tls }) => {
      const host = new URL(url).host;
      const readers = ['chatService', 'credentialService'] as const;
      return [{ egressHosts: [host], egressFrom: { [host]: readers } }, credentialNeed('models.credential', credential, readers), ...tlsNeed('models.tls', tls, readers)];
    },
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
    otlp: ({ url, credential, tls }) => [
      { egressHosts: [new URL(url).host], iam: { harness: { actions: XRAY } } },
      ...(credential ? [credentialNeed('telemetry.credential', credential, ['chatService', 'harness'])] : []),
      ...tlsNeed('telemetry.tls', tls, ['chatService', 'harness']),
    ],
    none: {},
  },
  proxy: {
    // Every service and browser reaches the internet through it; the Chat Service and the Harness relay to it with its credential.
    forward: ({ url, credential, tls }) => [
      { egressHosts: [new URL(url).host] },
      ...(credential ? [credentialNeed('proxy.credential', credential, ['chatService', 'credentialService', 'harness'])] : []),
      ...tlsNeed('proxy.tls', tls, ['chatService', 'credentialService', 'harness']),
    ],
    none: {},
  },
};

/** What connecting with `tls` at `field` needs of its `readers`: its line, and a client certificate command they may run. */
function tlsNeed(field: string, tls: EndpointTls | undefined, readers: readonly Principal[]): Need[] {
  if (tls === undefined) return [];
  const { clientCertificate, serverIdentity } = tls;
  const certificate = clientCertificate === undefined ? undefined : 'command' in clientCertificate
    ? 'client certificate from a command'
    : `client certificate ${clientCertificate.certificate}, key ${clientCertificate.key}`;
  const described = [...(serverIdentity ? [`server identity ${serverIdentity}`] : []), ...(certificate ? [certificate] : [])].join('; ');
  return [{
    tls: [`${field} (${readers.join(', ')}): ${described}`],
    ...(clientCertificate && 'command' in clientCertificate ? { commands: [`${field}.clientCertificate (${readers.join(', ')}): ${clientCertificate.command.join(' ')}`] } : {}),
  }];
}

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

/** The supplied, created and runtime resources, IAM actions, egress hosts, images and commands this Deployment Config needs. */
export function footprint(config: DeploymentConfig, { filesAccessPointMode = 'runtime' }: FootprintOptions = {}): Footprint {
  const resources = suppliedResources(config);
  const needs = [BUILT_IN, config.supplied?.files ? {} : FILES_ACCESS_POINTS[filesAccessPointMode],
    ...(Object.keys(ADAPTERS) as Section[]).flatMap(section => adapter(section, config[section])), resources.need];
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
    supplied: needs.flatMap(need => need.supplied ?? []).map(resource => ({ ...resource, grants: resource.grants.map(grant => ({ ...grant, actions: sorted(grant.actions) })) })),
    created: resources.created,
    runtime: needs.flatMap(need => need.runtime ?? []),
    iam,
    models: config.models.kind === 'openai-compatible' ? `openai-compatible ${config.models.url} wire ${config.models.wire}` : config.models.kind,
    egressHosts: sorted(needs.flatMap(need => need.egressHosts ?? [])),
    egressFrom: Object.fromEntries(needs.flatMap(need => Object.entries(need.egressFrom ?? {})).map(([host, from]) => [host, [...from]])),
    images: sorted([...Object.values(IMAGES), ...pulled(needs.flatMap(need => need.pulled ?? []))]),
    buildImages: sorted(pulled(PULLED.build)),
    commands: sorted(needs.flatMap(need => need.commands ?? [])),
    tls: sorted(needs.flatMap(need => need.tls ?? [])),
  };
}

function adapter(section: Section, config: { kind: string }): Need[] {
  const need = (ADAPTERS[section] as Partial<Record<string, AdapterNeed<typeof config>>>)[config.kind];
  if (!need) throw new Error(`${section}.kind: no footprint for adapter "${config.kind}"`);
  return [typeof need === 'function' ? need(config) : need].flat();
}

const sorted = (values: readonly string[]) => [...new Set(values)].sort();

/** The footprint as a security reviewer reads it. */
export function formatFootprint({ supplied, created, runtime, iam, models, egressHosts, egressFrom, tls, images, buildImages, commands }: Footprint): string {
  const roles = (Object.entries(iam) as [Principal, { actions: string[]; managedPolicies: string[] }][]).flatMap(([principal, grant]) => [
    `  ${principal} (${PRINCIPALS[principal]})`,
    ...grant.actions.map(action => `    ${action}`),
    ...grant.managedPolicies.map(policy => `    AWS managed policy ${policy}`),
  ]);
  return [
    'Supplied resources', ...supplied.flatMap(({ field, name, grants }) => [
      `  ${field} ${name}`,
      ...grants.map(({ to, actions, on }) => `    grant ${to}: ${actions.join(' ')}${on ? ` on ${on}` : ''}`),
    ]),
    'Created resources', ...created.map(resource => `  ${resource}`),
    'Created at runtime', ...runtime.map(action => `  ${action}`),
    'IAM actions', ...roles,
    'Models', `  ${models}`,
    'Egress hosts', ...egressHosts.map(host => `  ${host}${egressFrom[host] ? ` (${egressFrom[host].join(', ')})` : ''}`),
    'TLS', ...tls.map(line => `  ${line}`),
    'Images', ...images.map(image => `  ${image}`),
    'Build images', ...buildImages.map(image => `  ${image}`),
    'Commands', ...commands.map(command => `  ${command}`),
  ].join('\n') + '\n';
}
