import { optionalPhysicalName } from './physical-name.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { App, CfnOutput, Stack, Tags } from 'aws-cdk-lib';
import { CfnBrowserCustom } from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { DeployIdentity } from './production-identity.js';
import type { SynthesizedConfig } from './parking-transition.js';
import { existingFilesRoleNames } from './files-role-names.js';
import { createProductionParking } from './production-parking-stack.js';
import { ContainerImage, Secret, type ContainerDefinition } from 'aws-cdk-lib/aws-ecs';
import { grantModelsEndpoint } from './models-endpoint.js';
import { grantSecretReads } from './secret-reads.js';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Secret as SecretsManagerSecret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { ApiHealthStack } from './api-health-stack.js';
import { ChatStorageStack } from './chat-storage-stack.js';
import { publishCredentialService, rawServiceHostname } from './credential-service-public-route.js';
import { addFilesLinks } from './files-links.js';
import { PreviewChatService } from './preview-chat-service.js';
import { PreviewOriginStack } from './preview-origin-stack.js';
import type { CredentialServiceImage } from './credential-audit-copy.js';
import { CREDENTIAL_SERVICE_ENV, PrivateCredentialService, type PrivateCredentialServiceProps } from './private-credential-service.js';
import { ownedEgress, type PrivateEgressStack } from './private-egress-stack.js';
import { nameTaskRoles } from './task-role-names.js';
import { WebLatencyStack } from './web-latency-stack.js';
import type { ModelsDeployment } from '../../../../config/seams.js' with { 'resolution-mode': 'import' };

import { cdkPackageRoot } from './project-dir.js';

const cubeRoot = path.resolve(cdkPackageRoot, '../../..');

/** The cheap foundation model that summarizes each finished Turn for the Activity: `MODEL_ID` in botcube/chat's `turn-summaries.ts`. */
const TURN_SUMMARY_MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0';

/** The environment names every bot's Chat Service reads its deploy inputs under. */
export const CHAT_SERVICE_ENV = {
  agentComputerPolicyBucket: 'BOTCUBE_AGENT_COMPUTER_POLICY_S3_BUCKET',
  agentComputerPolicyKey: 'BOTCUBE_AGENT_COMPUTER_POLICY_S3_KEY',
} as const;

/** Non-secret deploy inputs written by the bot's `deploy/ecs/prepare-origin.py`. */
interface OriginInput {
  cloudflareCidrs: string[];
  clientVersion: string;
  turnIdentityKeysVersion?: string;
  runtimeArn: string;
  filesWorkspace?: string;
}

/** The serving origin and BotCube's services in it, beside which a product adds resources of its own. */
export interface Serving {
  origin: PreviewOriginStack;
  chat: PreviewChatService;
  credentials: PrivateCredentialService;
  agentComputerBrowser: CfnBrowserCustom;
  /** The images the services run; a product's own task can run one of them. */
  images: { chat: ContainerImage; credential: CredentialServiceImage };
}

type CredentialOverrides = Partial<Omit<PrivateCredentialServiceProps, 'cluster' | 'chatNetwork' | 'agentNetwork' | 'image' | 'kmsKey' | 'executionRole' | 'permissionsBoundary' | 'subnets'>>;

export interface ProductionOptions {
  /** Adds the product's own resources to the serving origin, such as its own login browser (ADR 0091). */
  serving?: (serving: Serving) => void;
  originConfig?: Pick<import('./preview-origin-stack.js').PreviewOriginProps,
    'providerTimeoutSeconds' | 'providerLogRetention' | 'connectionLogExpirationDays' | 'clientKeepAliveSeconds' |
    'securityGroupName' | 'connectionLogsBucketName' | 'existingConnectionLogsBucketName' | 'trustStoreName' | 'loadBalancerName' | 'providerNames'> & {
      agentNetworkSecurityGroupName?: string;
      agentComputerSecurityGroupName?: string;
      agentComputerBrowserRoleName?: string;
    };
  storage?: Omit<import('./chat-storage-stack.js').ChatStorageProps, keyof import('aws-cdk-lib').StackProps | 'corsOrigins'>;
  apiHealth?: Pick<import('./api-health-stack.js').ApiHealthStackProps, 'requestIntervalSeconds' | 'failureThreshold' | 'evaluationPeriods'>;
  /** The web latency monitor; its `readerSubject`, the workflow that reads its metrics, is the release tooling's to name. */
  webLatency?: Partial<Pick<import('./web-latency-stack.js').WebLatencyStackProps, 'sessionSampleRate' | 'moments' | 'identityPoolName' | 'guestRoleName' | 'readerRoleName' | 'readerSubject'>>;
  chatTableName?: string;
  executionRole?: iam.IRole;
  vpc?: ec2.IVpc;
  publicSubnets?: ec2.SubnetSelection;
  privateSubnets?: ec2.SubnetSelection;
  kmsKey?: kms.IKey;
  permissionsBoundary?: iam.IManagedPolicy;
  chat?: Partial<Omit<import('./preview-chat-service.js').PreviewChatServiceProps, 'chatTable' | 'image' | 'vpc' | 'subnets' | 'executionRole' | 'permissionsBoundary' | 'browserId'>> & {
    /** The chat image's BotCube Config path (BOTCUBE_CONFIG); absent, Chat Service defaults. */
    botcubeConfig?: string;
  };
  credentials?: CredentialOverrides;
  existingCredentialEndpoint?: { url: string; targetGroupArn: string; securityGroupId: string };
  /** The BotCube Config's non-Bedrock `models`, as botcube/config's `modelGatewayResources` gives them. */
  models?: ModelsDeployment;
  /** The BotCube Config's `tags`, on every stack. */
  tags?: Readonly<Record<string, string>>;
  /** The BotCube Config's `awsAccess.kind`; absent is the default, `web-identity`. */
  awsAccess?: 'web-identity' | 'assume-role';
  /** The secrets the Chat Service's credential sources read. */
  chatSecretIds?: readonly string[];
  repositoryRoot: string;
  /** The active deploy directory (`BOTCUBE_DEPLOY_ROOT`). */
  deployRoot: string;
  /** The deploy identity, as `deployIdentity` reads it. */
  identity: DeployIdentity;
  /** The BotCube Config the identity is built from, which the parking Transition bundles. */
  config: SynthesizedConfig;
  /** The BotCube Config's `domains.web` and `domains.webAliases`: the UI origins the parked Worker answers and web latency reports from. */
  corsOrigins: string[];
  /** The registry, mirroring ECR Public's paths, every image comes from. */
  imageRegistry?: string;
  /** The BotCube Config's `existing.vpc` brings its own egress (`network.natGateways` 0), in place of the identity's `privateEgress`. */
  existingNetwork?: boolean;
  /** The serving stack; absent keeps storage and egress synthesizable without live prerequisites. */
  origin?: {
    input: OriginInput;
    images: Serving['images'];
    /** The checkout's commit, tagged on each task definition for `scripts/dev-status.sh`. */
    commit: string;
  } | undefined;
}

/** The latency moments BotCube budgets, plus any the bot's own `latency-budgets.json` adds. */
function latencyMoments(deployRoot: string): string[] {
  const botBudgets = path.join(deployRoot, '..', 'latency-budgets.json');
  return Object.keys({
    ...JSON.parse(fs.readFileSync(path.join(cubeRoot, 'latency-budgets.json'), 'utf8')).moments,
    ...(fs.existsSync(botBudgets) ? JSON.parse(fs.readFileSync(botBudgets, 'utf8')).moments : {}),
  });
}


function addSmokePolicy(origin: PreviewOriginStack, identity: DeployIdentity, storage: ChatStorageStack, runtimeArn: string) {
  new iam.ManagedPolicy(origin, 'OriginSmokePolicy', {
    roles: [iam.Role.fromRoleName(origin, 'OriginSmokeDeployRole', identity.aws.ecs.deployRoleName)],
    statements: [
      ...(storage.chatTableExisting ? [] : [
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
          resources: [storage.chatTable.tableArn],
          conditions: {
            'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['PAID_EXECUTION#origin-smoke'] },
            Null: { 'dynamodb:LeadingKeys': 'false' },
          },
        }),
        new iam.PolicyStatement({
          actions: ['dynamodb:UpdateItem'], resources: [storage.chatTable.tableArn],
          conditions: {
            'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSIONS#acct_*'] },
            Null: { 'dynamodb:LeadingKeys': 'false' },
          },
        }),
      ]),
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:StopRuntimeSession'],
        resources: [runtimeArn, `${runtimeArn}/runtime-endpoint/DEFAULT`],
      }),
    ],
  });
}

function runtimeMonitoring({ aws: { agentCore }, ssm }: DeployIdentity) {
  if (!agentCore.runtimeMonitoring) return {};
  if (!ssm.runtimeArn) throw new Error('agentCore.runtimeMonitoring needs ssm.runtimeArn, the parameter holding the Runtime ARN');
  return { runtime: { name: agentCore.runtime, arnParameter: ssm.runtimeArn, ...agentCore.runtimeMonitoring } };
}

/** Every stack of the ECS CDK app (ADR 0065), each tagged with the BotCube Config's `tags`. */
export function defineProduction(app: App, options: ProductionOptions) {
  const before = new Set(app.node.children);
  defineStacks(app, options);
  for (const stack of app.node.children.filter(child => !before.has(child) && Stack.isStack(child))) {
    for (const [key, value] of Object.entries(options.tags ?? {})) Tags.of(stack).add(key, value);
  }
}

function defineStacks(app: App, options: ProductionOptions) {
  const { identity } = options;
  const env = { account: identity.aws.account, region: identity.aws.region };
  const storage = createChatStorage(app, options);
  const egress = ownedEgress(app, identity, options.existingNetwork ?? false, options.permissionsBoundary);
  const health = new ApiHealthStack(app, 'ApiHealth', {
    env, stackName: identity.aws.ecs.apiHealth.stackName, alarmName: identity.aws.ecs.apiHealth.alarmName,
    hostname: new URL(identity.domains.chatService).hostname, alertsTopicName: identity.aws.ecs.alertsTopicName,
    ...runtimeMonitoring(identity),
    ...options.apiHealth,
  });
  const webLatency = new WebLatencyStack(app, 'WebLatency', {
    env, stackName: identity.aws.ecs.webLatency.stackName, appMonitorName: identity.aws.ecs.webLatency.appMonitorName,
    domains: options.corsOrigins.filter(origin => origin.startsWith('https://')).map(origin => new URL(origin).hostname),
    turnLogGroups: [`/${identity.aws.ecs.cluster}/chat-service-preview`, `/aws/bedrock-agentcore/runtimes/${identity.aws.agentCore.runtime}-*`],
    ...options.webLatency,
    moments: options.webLatency?.moments ?? latencyMoments(options.deployRoot),
  });
  if (options.permissionsBoundary) {
    for (const stack of [storage, health, webLatency]) iam.PermissionsBoundary.of(stack).apply(options.permissionsBoundary);
  }
  if (!options.origin) return;
  const { input, images, commit } = options.origin;
  const filesRoles = existingFilesRoleNames(storage, identity.aws.iam);
  const parking = createProductionParking(app, cubeRoot, storage.chatTable as ITable, storage.chatTableExisting, identity, options.config, options.imageRegistry);
  if (options.permissionsBoundary) iam.PermissionsBoundary.of(parking).apply(options.permissionsBoundary);
  const origin = createServingOrigin(app, options, input, health, egress, parking.wakeUrl);
  const chat = new PreviewChatService(origin, 'ChatService', {
    ...(options.vpc ? { vpc: options.vpc } : {}),
    ...(options.privateSubnets ? { subnets: options.privateSubnets } : {}),
    ...(options.executionRole ? { executionRole: options.executionRole } : {}),
    vpcId: identity.aws.credentialService.vpcId,
    privateSubnets: identity.aws.agentCore.privateNatBrowser.subnets,
    clusterName: identity.aws.ecs.cluster,
    alertsTopicName: identity.aws.ecs.alertsTopicName,
    hostnames: [identity.domains.chatServicePreview, identity.domains.chatService].map(url => new URL(url).hostname),
    runtimeArn: input.runtimeArn,
    sessionApiFunctionName: identity.aws.agentCore.sessionApiFunction,
    sessionApiAlias: identity.aws.agentCore.sessionApiAlias,
    // aws-cdk-lib's Table declares `T | undefined` getters where ITable declares `prop?: T`,
    // which exactOptionalPropertyTypes rejects; the construct is its interface.
    chatTable: storage.chatTable as ITable,
    chatTableExisting: storage.chatTableExisting,
    image: images.chat,
    ...withoutBotCubeConfig(options.chat),
  });
  addBotCubeConfig(chat.container, options.chat?.botcubeConfig);
  if (input.filesWorkspace) chat.container.addEnvironment('BOTCUBE_WORKSPACE', input.filesWorkspace);
  addSmokePolicy(origin, identity, storage, options.chat?.runtimeArn ?? input.runtimeArn);
  const agentNetwork = new ec2.SecurityGroup(origin, 'AgentNetwork', { vpc: chat.cluster.vpc, ...optionalPhysicalName('securityGroupName', options.originConfig?.agentNetworkSecurityGroupName) });
  new ssm.StringParameter(origin, 'AgentSecurityGroupParameter', {
    parameterName: identity.aws.agentCore.runtimeNetworkParameter, stringValue: agentNetwork.securityGroupId,
  });
  new CfnOutput(origin, 'AgentSecurityGroupId', { value: agentNetwork.securityGroupId });
  // The per-Turn JWT's issuer is the origin the AgentCore app registers as the Memory role's OIDC provider.
  chat.container.addEnvironment('BOTCUBE_PARK_STATE_PARAMETER', identity.ssm.parkState);
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameterHistory'], resources: [origin.formatArn({ service: 'ssm', resource: `parameter${identity.ssm.parkState}` })] }));
  const publicOrigin = `https://${new URL(identity.domains.chatService).hostname}`;
  chat.container.addEnvironment('BOTCUBE_PUBLIC_ORIGIN', publicOrigin);
  const turnIdentityKeys = SecretsManagerSecret.fromSecretNameV2(origin, 'TurnIdentityKeys', identity.aws.ecs.chatService.turnIdentityKeysSecretName);
  chat.container.addSecret('BOTCUBE_TURN_IDENTITY_KEYS', Secret.fromSecretsManager(turnIdentityKeys));
  if (options.awsAccess === 'assume-role') assumeUserMemoryRole(origin, chat, identity.aws.iam);
  nameTaskRoles(chat.task, filesRoles?.chatServiceTaskRole, undefined, undefined);
  grantSecretReads(chat, chat.task, options.chatSecretIds ?? []);
  const agentComputer = addAgentComputerBrowser(origin, chat, storage, browserConfiguration(options, chat.cluster.vpc), {
    ...options.originConfig, ...optionalPhysicalName('agentComputerBrowserRoleName', filesRoles?.agentComputerBrowserRole),
  });
  const credentialConfig = identity.aws.ecs.credentialService;
  const endpoint = options.existingCredentialEndpoint;
  const credentials = new PrivateCredentialService(origin, 'CredentialService', {
    ...(options.executionRole ? { executionRole: options.executionRole } : {}),
    ...(options.kmsKey ? { kmsKey: options.kmsKey } : {}),
    ...(options.privateSubnets ? { subnets: options.privateSubnets } : {}),
    cluster: chat.cluster, chatNetwork: chat.network, agentNetwork,
    tableName: credentialConfig.tableName, rpcPath: credentialConfig.rpcPath, namespaceName: identity.aws.ecs.privateNamespace,
    alertsTopicName: identity.aws.ecs.alertsTopicName, port: identity.aws.credentialService.port,
    image: images.credential, authBrowserId: identity.aws.agentCore.privateNatBrowser.id,
    agentComputerBrowserId: agentComputer.browser.attrBrowserId,
    ...options.credentials,
    ...(endpoint ? { existingEndpoint: {
      url: endpoint.url, targetGroupArn: endpoint.targetGroupArn,
      securityGroup: ec2.SecurityGroup.fromSecurityGroupId(origin, 'EndpointBalancer', endpoint.securityGroupId, { mutable: false }),
    } } : {}),
  });
  grantModelsEndpoint(credentials, options.models);
  // The product's service verifies BotCube's signed user tokens against this issuer's JWKS (ADR 0091).
  credentials.container.addEnvironment('BOTCUBE_PUBLIC_ORIGIN', publicOrigin);
  const rawHostname = rawServiceHostname(identity);
  if (credentialConfig.publicHostname !== undefined) publishCredentialService(origin, credentials, {
    hostname: credentialConfig.publicHostname, rpcPath: credentialConfig.rpcPath, port: identity.aws.credentialService.port,
    paths: publicPaths(credentialConfig),
    chatTableKeyPrefixes: credentialConfig.chatTableKeyPrefixes ?? [], rawHostname,
    chatTable: storage.chatTable as ITable, chatTableExisting: storage.chatTableExisting,
  });
  // A tag changes a task definition in place, so a draining task keeps its own revision's commit.
  for (const task of [chat.task, credentials.task]) {
    Tags.of(task).add('commit', commit, { includeResourceTypes: ['AWS::ECS::TaskDefinition'] });
  }
  addFilesPolicy(origin, chat);
  addFilesLinks(origin, chat, storage, agentComputer, cubeRoot, [agentNetwork, agentComputer.network], filesRoles?.filesMountRole);
  // The agent reaches its Agent Computer only through the Chat Service's CDP filter (ADR 0075 decision 5).
  chat.network.connections.allowFrom(agentNetwork, ec2.Port.tcp(options.chat?.port ?? 8123), 'Harness Agent Computer CDP');
  chat.container.addEnvironment(CREDENTIAL_SERVICE_ENV.url, credentials.url);
  // aws-cdk-lib's Secret declares `T | undefined` getters where ISecret declares `prop?: T`,
  // which exactOptionalPropertyTypes rejects; the construct is its interface.
  chat.container.addSecret(CREDENTIAL_SERVICE_ENV.invocationToken, Secret.fromSecretsManager(credentials.invocationSecret as ISecret));
  // The product's own resources beside BotCube's, such as a login browser of its own (ADR 0091).
  options.serving?.({ origin, chat, credentials, agentComputerBrowser: agentComputer.browser, images });
  // Agent Computers run in their own browser.
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock-agentcore:GetBrowser', 'bedrock-agentcore:StartBrowserSession',
      'bedrock-agentcore:ListBrowserSessions', 'bedrock-agentcore:GetBrowserSession',
      'bedrock-agentcore:StopBrowserSession', 'bedrock-agentcore:UpdateBrowserStream',
      'bedrock-agentcore:ConnectBrowserAutomationStream', 'bedrock-agentcore:ConnectBrowserLiveViewStream'],
    resources: [agentComputer.browser.attrBrowserArn],
  }));
  // Agent Computer browsers wake from, and sleep into, their account's browser profile (ADR 0077); account deletion deletes it.
  // CreateBrowserProfile has no resource type; IAM requires the literal wildcard.
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock-agentcore:CreateBrowserProfile'],
    resources: ['*'],
  }));
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock-agentcore:SaveBrowserSessionProfile', 'bedrock-agentcore:StartBrowserSession', 'bedrock-agentcore:DeleteBrowserProfile'],
    resources: [
      origin.formatArn({ service: 'bedrock-agentcore', resource: 'browser-profile', resourceName: `${identity.aws.agentCore.agentComputerBrowser.profileNamePrefix}*` }),
      agentComputer.browser.attrBrowserArn,
    ],
  }));
  addTurnSummaryModel(origin, chat, options);
}

/** Where Turn summaries run: the BotCube Config's OpenAI-compatible Endpoint, or Bedrock. */
function addTurnSummaryModel(origin: PreviewOriginStack, chat: PreviewChatService, options: ProductionOptions) {
  if (grantModelsEndpoint(chat, options.models)) return;
  // The Turn summary model runs on a US cross-region inference profile, which routes to US Regions.
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [
      origin.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: `us.${TURN_SUMMARY_MODEL}` }),
      `arn:aws:bedrock:*::foundation-model/${TURN_SUMMARY_MODEL}`,
    ],
  }));
}

function createServingOrigin(app: App, options: ProductionOptions, input: OriginInput, health: ApiHealthStack, egress: PrivateEgressStack | undefined, wakeUrl: string) {
  const { identity, repositoryRoot } = options;
  const env = { account: identity.aws.account, region: identity.aws.region };
  const origin = new PreviewOriginStack(app, 'PreviewOrigin', {
    env,
    ...(options.vpc ? { vpc: options.vpc } : {}),
    ...(options.publicSubnets ? { subnets: options.publicSubnets } : {}),
    stackName: identity.aws.ecs.previewOriginStackName,
    hostname: new URL(identity.domains.chatServicePreview).hostname,
    production: { hostname: new URL(identity.domains.chatService).hostname },
    ...(identity.aws.ecs.credentialService.publicHostname ? { service: { hostname: identity.aws.ecs.credentialService.publicHostname } } : {}),
    additionalHostnames: (identity.domains.rawServiceOrigins ?? []).map(url => new URL(url).hostname),
    repositoryRoot, originProviderPath: path.join(cubeRoot, 'infra/ecs/origin-provider'),
    vpcId: identity.aws.credentialService.vpcId,
    publicSubnets: identity.aws.ecs.publicSubnets,
    cloudflareCidrs: input.cloudflareCidrs, clientVersion: input.clientVersion,
    turnIdentityKeysSecretName: identity.aws.ecs.chatService.turnIdentityKeysSecretName,
    ...(input.turnIdentityKeysVersion ? { turnIdentityKeysVersion: input.turnIdentityKeysVersion } : {}),
    tokenSecretName: identity.aws.ecs.originTokenSecretName,
    originOwnership: identity.aws.ecs.originOwnership,
    parkedWorkerName: identity.aws.ecs.parkedWorkerName,
    originZone: identity.aws.ecs.originZone,
    clientSecretName: identity.aws.ecs.originPullClientSecretName,
    caCertificate: identity.aws.ecs.originPullCaCertificate,
    corsOrigins: options.corsOrigins,
    parkedDnsTarget: identity.aws.ecs.parkedDnsTarget, wakeUrl,
    ...options.originConfig,
  });
  if (options.permissionsBoundary) iam.PermissionsBoundary.of(origin).apply(options.permissionsBoundary);
  if (egress) origin.addDependency(egress);
  health.addDependency(origin);
  return origin;
}

function browserConfiguration(options: ProductionOptions, vpc: ec2.IVpc): DeployIdentity['aws']['agentCore'] {
  const agentCore = options.identity.aws.agentCore;
  if (!options.vpc && !options.privateSubnets) return agentCore;
  const subnets = vpc.selectSubnets(options.privateSubnets ?? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnets;
  return {
    ...agentCore,
    privateNatBrowser: { ...agentCore.privateNatBrowser, subnets: subnets.map(subnet => ({ id: subnet.subnetId, availabilityZone: subnet.availabilityZone })) },
  };
}

/**
 * The Agent Computer's own browser (ADR 0077): in the login browser's subnets, so it
 * egresses through the same fixed NAT address, with an execution role that may mount
 * only Files access points. The Runtime role, which the agent's shell can use, gets neither.
 * Its managed Chrome policy keeps Chromium's own sign-in and promotions out of every session;
 * Chrome takes those policies only as managed ones, which only the browser itself can carry.
 */
function addAgentComputerBrowser(
  origin: PreviewOriginStack,
  chat: PreviewChatService,
  storage: ChatStorageStack,
  agentCore: DeployIdentity['aws']['agentCore'],
  names?: ProductionOptions['originConfig'],
) {
  const network = new ec2.SecurityGroup(origin, 'AgentComputerBrowsers', { vpc: chat.cluster.vpc, ...optionalPhysicalName('securityGroupName', names?.agentComputerSecurityGroupName) });
  const role = new iam.Role(origin, 'AgentComputerBrowserRole', {
    ...optionalPhysicalName('roleName', names?.agentComputerBrowserRoleName),
    assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': origin.account } } }),
  });
  if (!storage.existingFiles) role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
    resources: [storage.filesEfs.attrArn],
    conditions: { ArnLike: { 'elasticfilesystem:AccessPointArn': origin.formatArn({ service: 'elasticfilesystem', resource: 'access-point', resourceName: '*' }) } },
  }));
  const { subnets } = agentCore.privateNatBrowser;
  const managedPolicy = new Asset(origin, 'AgentComputerChromeManagedPolicy', {
    path: path.join(cubeRoot, 'infra/agent-computer/chrome-managed-policy.json'),
  });
  const browser = new CfnBrowserCustom(origin, 'AgentComputerBrowser', {
    name: agentCore.agentComputerBrowser.name,
    executionRoleArn: role.roleArn,
    networkConfiguration: {
      networkMode: 'VPC',
      vpcConfig: { subnets: subnets.map(subnet => subnet.id), securityGroups: [network.securityGroupId] },
    },
    enterprisePolicies: [{ type: 'MANAGED', location: { bucket: managedPolicy.s3BucketName, prefix: managedPolicy.s3ObjectKey } }],
  });
  // The browser assumes its role when a session starts; the role's policy must exist by then.
  browser.node.addDependency(role);
  chat.container.addEnvironment('AGENTCORE_AGENT_COMPUTER_BROWSER_ID', browser.attrBrowserId);
  return { browser, network, subnets };
}

/**
 * The `assume-role` Turn credentials adapter: the Chat Service assumes the AgentCore stack's Memory role, by name, for
 * each Turn. Its task role takes the name that role trusts.
 */
function assumeUserMemoryRole(origin: PreviewOriginStack, chat: PreviewChatService, { userMemoryRole, chatServiceTaskRole }: DeployIdentity['aws']['iam']) {
  if (!chatServiceTaskRole) throw new Error('Deploy identity aws.iam.chatServiceTaskRole: required with awsAccess assume-role');
  nameTaskRoles(chat.task, chatServiceTaskRole, undefined, undefined);
  const roleArn = origin.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: userMemoryRole });
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [roleArn] }));
  chat.container.addEnvironment('BOTCUBE_USER_MEMORY_ROLE_ARN', roleArn);
}

function publicPaths({ publicPaths: paths }: DeployIdentity['aws']['ecs']['credentialService']): string[] {
  if (!paths?.length) throw new Error('Deploy identity aws.ecs.credentialService.publicPaths: required with publicHostname');
  return paths;
}

function addFilesPolicy(origin: PreviewOriginStack, chat: PreviewChatService) {
  const policy = new Asset(origin, 'AgentComputerChromePolicy', { path: path.join(cubeRoot, 'infra/agent-computer/chrome-policy.json') });
  policy.grantRead(chat.task.taskRole);
  chat.container.addEnvironment(CHAT_SERVICE_ENV.agentComputerPolicyBucket, policy.s3BucketName);
  chat.container.addEnvironment(CHAT_SERVICE_ENV.agentComputerPolicyKey, policy.s3ObjectKey);
}

function createChatStorage(app: App, options: ProductionOptions): ChatStorageStack {
  const { identity } = options;
  const env = { account: identity.aws.account, region: identity.aws.region };
  if (options.chatTableName !== undefined && options.storage?.tableName !== undefined) throw new Error('Choose chatTableName or storage.tableName, not both');
  return new ChatStorageStack(app, 'ChatStorage', { env, ...options.storage, ...(options.chatTableName ? { tableName: options.chatTableName } : {}) });
}

/** The Chat Service's props, without the BotCube Config path that addBotCubeConfig sets. */
function withoutBotCubeConfig({ botcubeConfig: _path, ...chat }: NonNullable<ProductionOptions['chat']> = {}) {
  return chat;
}

/** Point the Chat Service at the BotCube Config its image ships; absent, it keeps its defaults. */
function addBotCubeConfig(container: ContainerDefinition, botcubeConfig: string | undefined) {
  if (botcubeConfig) container.addEnvironment('BOTCUBE_CONFIG', botcubeConfig);
}
