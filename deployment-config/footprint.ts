import type { DeploymentConfig } from './schema.js';

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
  readonly images?: readonly string[];
  readonly resources?: readonly string[];
}

export interface Footprint {
  readonly iam: Partial<Record<Principal, { actions: string[]; managedPolicies: string[] }>>;
  readonly egressHosts: string[];
  readonly images: string[];
  /** Resources a section's provider runs on, as `<CloudFormation type> <name>`. */
  readonly resources: string[];
}

/** The images BotCube deploys; a bot's own image is built FROM the Harness image and stands in for it. */
export const IMAGES = {
  chatService: 'botcube-chat-service',
  credentialService: 'botcube-credential-service',
  bot: 'bot (FROM the BotCube Harness image)',
  otelCollector: 'public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0',
} as const;

const CHAT_TABLE = ['BatchGetItem', 'BatchWriteItem', 'ConditionCheckItem', 'DeleteItem', 'DescribeTable', 'GetItem', 'GetRecords',
  'GetShardIterator', 'PutItem', 'Query', 'Scan', 'UpdateItem'].map(action => `dynamodb:${action}`);
const BROWSERS = ['ConnectBrowserAutomationStream', 'ConnectBrowserLiveViewStream', 'CreateBrowserProfile', 'DeleteBrowserProfile', 'GetBrowser',
  'GetBrowserSession', 'ListBrowserSessions', 'SaveBrowserSessionProfile', 'StartBrowserSession', 'StopBrowserSession', 'UpdateBrowserStream']
  .map(action => `bedrock-agentcore:${action}`);
const EFS_CLIENT = ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'];
const SCHEDULED_RUNS_CONSUMER = ['ChangeMessageVisibility', 'DeleteMessage', 'GetQueueAttributes', 'GetQueueUrl', 'ReceiveMessage'].map(action => `sqs:${action}`);
const aws = (...services: string[]) => services.map(service => `${service}.<region>.amazonaws.com`);

/** What BotCube's own services need under every Deployment Config. */
const BUILT_IN: Need = {
  iam: {
    chatService: { actions: [
      ...CHAT_TABLE, ...BROWSERS, ...EFS_CLIENT, ...SCHEDULED_RUNS_CONSUMER,
      // Files: the access-point pool, and the role each Turn's Files mount assumes.
      'elasticfilesystem:CreateAccessPoint', 'elasticfilesystem:DeleteAccessPoint', 'elasticfilesystem:DescribeAccessPoints', 'sts:AssumeRole',
      // The Agent Computer's Chrome policy.
      's3:GetBucket*', 's3:GetObject*', 's3:List*',
      'ecs:DescribeTasks', 'ssm:GetParameterHistory', 'xray:PutTelemetryRecords', 'xray:PutTraceSegments',
    ] },
    credentialService: { actions: [
      'bedrock-agentcore:ConnectBrowserAutomationStream', 'bedrock-agentcore:GetBrowserSession',
      'dynamodb:ConditionCheckItem', 'dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem',
      'kms:Decrypt', 'kms:DescribeKey', 'kms:GenerateDataKey', 'kms:GetPublicKey',
    ] },
    agentComputerBrowser: { actions: EFS_CLIENT },
    filesMount: { actions: EFS_CLIENT },
    filesLinks: { actions: EFS_CLIENT, managedPolicies: ['AWSLambdaBasicExecutionRole', 'AWSLambdaVPCAccessExecutionRole'] },
    harness: { actions: [
      'ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetAuthorizationToken', 'ecr:GetDownloadUrlForLayer', 'kms:Decrypt',
      'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:PutLogEvents',
      'xray:PutTelemetryRecords', 'xray:PutTraceSegments',
    ] },
    sessionApi: {
      actions: ['BatchUpdateMemoryRecords', 'CreateEvent', 'DeleteEvent', 'DeleteMemoryRecord', 'GetEvent', 'ListEvents', 'ListMemoryRecords', 'ListSessions']
        .map(action => `bedrock-agentcore:${action}`),
      managedPolicies: ['AWSLambdaBasicExecutionRole'],
    },
  },
  egressHosts: [
    ...aws('bedrock-agentcore', 'dynamodb', 'ecs', 'elasticfilesystem', 'kms', 'logs', 's3', 'sqs', 'ssm', 'sts', 'xray'),
    // Plan Usage, which the Credential Service reads with a User's OpenAI sign-in.
    'auth.openai.com', 'api.openai.com',
  ],
  images: Object.values(IMAGES),
};

/** The fields with no `kind`: the bot, and the plain parameters (existing resources, telemetry, proxy). */
type Section = Exclude<keyof DeploymentConfig, '$schema' | 'bot' | 'existing' | 'telemetry' | 'proxy'>;

/** An adapter's need: fixed, or read from its section, such as the host it names. */
type AdapterNeed<Config> = Need | ((config: Config) => Need);

/** Each section's adapters by `kind`: a kind the schema adds without an entry here fails to type-check. */
const ADAPTERS: { readonly [S in Section]: { readonly [K in DeploymentConfig[S]['kind']]: AdapterNeed<Extract<DeploymentConfig[S], { kind: K }>> } } = {
  identity: {
    // Accounts live in the chat table the Chat Service already holds.
    'botcube-accounts': {},
    // The Chat Service discovers the provider and redeems sign-in codes; the deploy reads the client secret.
    oidc: ({ issuer, resources }) => ({ egressHosts: [new URL(issuer).host], resources: (resources ?? []).map(({ type, name }) => `${type} ${name}`) }),
  },
  models: {
    bedrock: {
      iam: {
        chatService: { actions: ['bedrock:InvokeModel'] },
        harness: { actions: ['bedrock:CountTokens', 'bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'] },
      },
      egressHosts: aws('bedrock-runtime'),
    },
    // Both read the endpoint's API key from its secret, the Harness for the agent and the Chat Service for turn summaries.
    'openai-compatible': ({ baseUrl }) => ({
      iam: {
        chatService: { actions: ['secretsmanager:GetSecretValue'] },
        harness: { actions: ['secretsmanager:GetSecretValue'] },
      },
      egressHosts: [...aws('secretsmanager'), new URL(baseUrl).host],
    }),
  },
  harnessAuth: {
    sigv4: {
      iam: { chatService: { actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession', 'lambda:InvokeFunction'] } },
      egressHosts: aws('bedrock-agentcore', 'lambda'),
    },
    // Chat signs the Runtime's bearer token with its Turn identity keys, so it holds no Runtime grant; the AgentCore
    // Runtime fetches the keys from the Chat Service's public origin. The session API is still a SigV4 Lambda call.
    'jwt-bearer': {
      iam: { chatService: { actions: ['lambda:InvokeFunction'] } },
      egressHosts: aws('bedrock-agentcore', 'lambda'),
    },
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
  },
};

/** The IAM actions, egress hosts, images and provider resources this Deployment Config needs. */
export function footprint(config: DeploymentConfig): Footprint {
  const needs = [BUILT_IN, ...(Object.keys(ADAPTERS) as Section[]).map(section => adapter(section, config[section])), plainParameters(config)];
  const iam: Footprint['iam'] = {};
  for (const principal of Object.keys(PRINCIPALS) as Principal[]) {
    const grants = needs.flatMap(need => need.iam?.[principal] ?? []);
    if (grants.length) iam[principal] = {
      actions: sorted(grants.flatMap(grant => grant.actions)),
      managedPolicies: sorted(grants.flatMap(grant => grant.managedPolicies ?? [])),
    };
  }
  return {
    iam,
    egressHosts: sorted(needs.flatMap(need => need.egressHosts ?? [])),
    images: sorted(needs.flatMap(need => need.images ?? [])),
    resources: sorted(needs.flatMap(need => need.resources ?? [])),
  };
}

/** The collector and the proxy are hosts the services reach; imported resources need what created ones would. */
function plainParameters({ telemetry, proxy }: DeploymentConfig): Need {
  return { egressHosts: [telemetry?.otlpEndpoint, proxy?.url].flatMap(url => (url ? [new URL(url).host] : [])) };
}

function adapter(section: Section, config: { kind: string }): Need {
  const need = (ADAPTERS[section] as Partial<Record<string, AdapterNeed<typeof config>>>)[config.kind];
  if (!need) throw new Error(`${section}.kind: no footprint for adapter "${config.kind}"`);
  return typeof need === 'function' ? need(config) : need;
}

const sorted = (values: readonly string[]) => [...new Set(values)].sort();

/** The footprint as a security reviewer reads it. */
export function formatFootprint({ iam, egressHosts, images, resources }: Footprint): string {
  const roles = (Object.entries(iam) as [Principal, { actions: string[]; managedPolicies: string[] }][]).flatMap(([principal, grant]) => [
    `  ${principal} (${PRINCIPALS[principal]})`,
    ...grant.actions.map(action => `    ${action}`),
    ...grant.managedPolicies.map(policy => `    AWS managed policy ${policy}`),
  ]);
  return [
    'IAM actions', ...roles,
    'Egress hosts', ...egressHosts.map(host => `  ${host}`),
    'Images', ...images.map(image => `  ${image}`),
    'Resources', ...resources.map(resource => `  ${resource}`),
  ].join('\n') + '\n';
}
