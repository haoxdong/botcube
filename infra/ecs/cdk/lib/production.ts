import { optionalPhysicalName } from './physical-name.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { App, CfnOutput, Tags } from 'aws-cdk-lib';
import { CfnBrowserCustom } from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import type { DeployIdentity } from './production-identity.js';
import { createProductionParking } from './production-parking-stack.js';
import { ContainerImage, Secret } from 'aws-cdk-lib/aws-ecs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Secret as SecretsManagerSecret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { ApiHealthStack } from './api-health-stack.js';
import { ChatStorageStack } from './chat-storage-stack.js';
import { addFilesLinks } from './files-links.js';
import { PreviewChatService } from './preview-chat-service.js';
import { PreviewOriginStack } from './preview-origin-stack.js';
import { CREDENTIAL_SERVICE_ENV, PrivateCredentialService } from './private-credential-service.js';
import { PrivateEgressStack } from './private-egress-stack.js';
import { WebLatencyStack } from './web-latency-stack.js';

const projectDir = (dir: string): string => (fs.existsSync(path.join(dir, 'cdk.json')) ? dir : projectDir(path.dirname(dir)));
const cubeRoot = path.resolve(projectDir(__dirname), '../../..');

/** The cheap foundation model that summarizes each finished Turn for the Activity: `MODEL_ID` in botcube/chat's `turn-summaries.ts`. */
const TURN_SUMMARY_MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0';

/** The environment names every Cartridge's Chat Service reads its deploy inputs under. */
export const CHAT_SERVICE_ENV = {
  planUsageOwnerAccountId: 'BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID',
  agentComputerCdpUrl: 'BOTCUBE_AGENT_COMPUTER_CDP_URL',
  agentComputerPolicyBucket: 'BOTCUBE_AGENT_COMPUTER_POLICY_S3_BUCKET',
  agentComputerPolicyKey: 'BOTCUBE_AGENT_COMPUTER_POLICY_S3_KEY',
} as const;

/** Non-secret deploy inputs written by the Cartridge's `deploy/ecs/prepare-origin.py`. */
interface OriginInput {
  cloudflareCidrs: string[];
  clientVersion: string;
  runtimeArn?: string;
}

export interface ProductionOptions {
  originConfig?: Pick<import('./preview-origin-stack.js').PreviewOriginProps,
    'providerTimeoutSeconds' | 'providerLogRetention' | 'connectionLogExpirationDays' | 'clientKeepAliveSeconds' |
    'securityGroupName' | 'connectionLogsBucketName' | 'trustStoreName' | 'loadBalancerName' | 'providerNames'> & {
      agentNetworkSecurityGroupName?: string;
      agentComputerSecurityGroupName?: string;
      agentComputerBrowserRoleName?: string;
    };
  storage?: Omit<import('./chat-storage-stack.js').ChatStorageProps, keyof import('aws-cdk-lib').StackProps | 'corsOrigins'>;
  apiHealth?: Pick<import('./api-health-stack.js').ApiHealthStackProps, 'requestIntervalSeconds' | 'failureThreshold' | 'evaluationPeriods'>;
  webLatency?: Partial<Pick<import('./web-latency-stack.js').WebLatencyStackProps, 'sessionSampleRate' | 'moments' | 'identityPoolName' | 'guestRoleName' | 'readerRoleName'>>;
  chatTableName?: string;
  executionRole?: iam.IRole;
  vpc?: ec2.IVpc;
  publicSubnets?: ec2.SubnetSelection;
  privateSubnets?: ec2.SubnetSelection;
  kmsKey?: kms.IKey;
  permissionsBoundary?: iam.IManagedPolicy;
  chat?: Partial<Omit<import('./preview-chat-service.js').PreviewChatServiceProps, 'chatTable' | 'image' | 'vpc' | 'subnets' | 'executionRole' | 'permissionsBoundary' | 'browserId'>>;
  credentials?: Partial<Omit<import('./private-credential-service.js').PrivateCredentialServiceProps, 'cluster' | 'chatNetwork' | 'agentNetwork' | 'image' | 'kmsKey' | 'executionRole' | 'permissionsBoundary' | 'subnets'>>;
  turnSummaryModel?: string;
  repositoryRoot: string;
  /** The active Cartridge's deploy directory (`CARTRIDGE_DEPLOY_ROOT`). */
  deployRoot: string;
  /** The Cartridge's deploy identity, as `cartridgeIdentity` reads it. */
  identity: DeployIdentity;
  /** The serving stack; absent keeps storage and egress synthesizable without live prerequisites. */
  origin?: {
    input: OriginInput;
    images: { chat: ContainerImage; credential: ContainerImage };
    /** The checkout's commit, tagged on each task definition for `scripts/dev-status.sh`. */
    commit: string;
  } | undefined;
}

/** Every stack of the ECS CDK app (ADR 0065). */
export function defineProduction(app: App, options: ProductionOptions) {
  const { identity } = options;
  const env = { account: identity.aws.account, region: identity.aws.region };
  const storage = createChatStorage(app, options);
  const egressConfig = identity.aws.ecs.privateEgress;
  const egress = new PrivateEgressStack(app, 'PrivateEgress', {
    env, stackName: egressConfig.stackName, natGateway: egressConfig.natGateway, routeTableId: egressConfig.routeTableId,
  });
  const health = new ApiHealthStack(app, 'ApiHealth', {
    env, stackName: identity.aws.ecs.apiHealth.stackName, alarmName: identity.aws.ecs.apiHealth.alarmName,
    hostname: new URL(identity.domains.chatService).hostname, alertsTopicName: identity.aws.ecs.alertsTopicName,
    ...options.apiHealth,
  });
  const webLatency = new WebLatencyStack(app, 'WebLatency', {
    env, stackName: identity.aws.ecs.webLatency.stackName, appMonitorName: identity.aws.ecs.webLatency.appMonitorName,
    domains: identity.domains.corsOrigins.filter(origin => origin.startsWith('https://')).map(origin => new URL(origin).hostname),
    readerSubject: `${identity.github.oidcSubjectPrefix}:ref:refs/heads/main`,
    turnLogGroups: [`/${identity.aws.ecs.cluster}/chat-service-preview`, `/aws/bedrock-agentcore/runtimes/${identity.aws.agentCore.runtime}-*`],
    ...options.webLatency,
    moments: options.webLatency?.moments ?? Object.keys({
      ...JSON.parse(fs.readFileSync(path.join(cubeRoot, 'latency-budgets.json'), 'utf8')).moments,
      ...(fs.existsSync(path.join(options.deployRoot, '..', 'latency-budgets.json'))
        ? JSON.parse(fs.readFileSync(path.join(options.deployRoot, '..', 'latency-budgets.json'), 'utf8')).moments : {}),
    }),
  });
  if (options.permissionsBoundary) {
    for (const stack of [storage, egress, health, webLatency]) iam.PermissionsBoundary.of(stack).apply(options.permissionsBoundary);
  }
  if (!options.origin) return;
  const { input, images, commit } = options.origin;
  const parking = createProductionParking(app, cubeRoot, storage.chatTable as ITable, identity);
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
    corsOrigins: identity.domains.corsOrigins,
    ...(input.runtimeArn ? { runtimeArn: input.runtimeArn } : {}),
    sessionApiFunctionName: identity.aws.agentCore.sessionApiFunction,
    sessionApiAlias: identity.aws.agentCore.sessionApiAlias,
    reaperCommand: identity.artifacts.chatService.reaperCommand,
    authBrowserId: identity.aws.agentCore.privateNatBrowser.id,
    // aws-cdk-lib's Table declares `T | undefined` getters where ITable declares `prop?: T`,
    // which exactOptionalPropertyTypes rejects; the construct is its interface.
    chatTable: storage.chatTable as ITable,
    image: images.chat,
    ...options.chat,
  });
  const agentNetwork = new ec2.SecurityGroup(origin, 'AgentNetwork', { vpc: chat.cluster.vpc, ...optionalPhysicalName('securityGroupName', options.originConfig?.agentNetworkSecurityGroupName) });
  new ssm.StringParameter(origin, 'AgentSecurityGroupParameter', {
    parameterName: identity.aws.agentCore.runtimeNetworkParameter, stringValue: agentNetwork.securityGroupId,
  });
  new CfnOutput(origin, 'AgentSecurityGroupId', { value: agentNetwork.securityGroupId });
  // The per-Turn JWT's issuer is the origin the AgentCore app registers as the Memory role's OIDC provider.
  chat.container.addEnvironment('BOTCUBE_PARK_STATE_PARAMETER', identity.ssm.parkState);
  chat.container.addEnvironment('BOTCUBE_PRODUCT_NAME', identity.product.name);
  chat.container.addEnvironment('BOTCUBE_REPORT_ACTIVITY', 'true');
  chat.container.addEnvironment('BOTCUBE_ARTIFACTS', '1');
  chat.container.addEnvironment('BOTCUBE_AUTOMATION_USER_AGENTS', identity.aws.ecs.parking.automationUserAgents.join(','));
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameterHistory'], resources: [origin.formatArn({ service: 'ssm', resource: `parameter${identity.ssm.parkState}` })] }));
  chat.container.addEnvironment('BOTCUBE_PUBLIC_ORIGIN', `https://${new URL(identity.domains.chatService).hostname}`);
  const turnIdentityKeys = SecretsManagerSecret.fromSecretNameV2(origin, 'TurnIdentityKeys', identity.aws.ecs.chatService.turnIdentityKeysSecretName);
  chat.container.addSecret('BOTCUBE_TURN_IDENTITY_KEYS', Secret.fromSecretsManager(turnIdentityKeys));
  const planUsageOwner = ssm.StringParameter.valueForStringParameter(origin, identity.aws.ecs.chatService.planUsageOwnerAccountParameter);
  chat.container.addEnvironment(CHAT_SERVICE_ENV.planUsageOwnerAccountId, planUsageOwner);
  const agentComputer = addAgentComputerBrowser(origin, chat, storage, browserConfiguration(options, chat.cluster.vpc), options.originConfig);
  const credentialConfig = identity.aws.ecs.credentialService;
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
  });
  credentials.container.addEnvironment(CHAT_SERVICE_ENV.planUsageOwnerAccountId, planUsageOwner);
  // A tag changes a task definition in place, so a draining task keeps its own revision's commit.
  for (const task of [chat.task, credentials.task]) {
    Tags.of(task).add('commit', commit, { includeResourceTypes: ['AWS::ECS::TaskDefinition'] });
  }
  addFilesPolicy(origin, chat);
  addFilesLinks(origin, chat, storage, agentComputer, cubeRoot, identity.domains.corsOrigins, [agentNetwork, agentComputer.network]);
  // The agent reaches its Agent Computer only through the Chat Service's CDP filter (ADR 0075 decision 5).
  chat.network.connections.allowFrom(agentNetwork, ec2.Port.tcp(options.chat?.port ?? 8123), 'Harness Agent Computer CDP');
  // The Chat Service puts its own task address in for the host, so each Turn reaches the task holding its Agent Computer.
  chat.container.addEnvironment(CHAT_SERVICE_ENV.agentComputerCdpUrl, `ws://task-address:${options.chat?.port ?? 8123}/agent-computer/cdp`);
  chat.container.addEnvironment(CREDENTIAL_SERVICE_ENV.url, credentials.url);
  // aws-cdk-lib's Secret declares `T | undefined` getters where ISecret declares `prop?: T`,
  // which exactOptionalPropertyTypes rejects; the construct is its interface.
  chat.container.addSecret(CREDENTIAL_SERVICE_ENV.invocationToken, Secret.fromSecretsManager(credentials.invocationSecret as ISecret));
  const browser = identity.aws.agentCore.privateNatBrowser;
  chat.container.addEnvironment('AGENTCORE_BROWSER_ID', browser.id);
  chat.container.addEnvironment('AGENTCORE_BROWSER_EXTENSION_S3_BUCKET', browser.extension.bucket);
  chat.container.addEnvironment('AGENTCORE_BROWSER_EXTENSION_S3_PREFIX', browser.extension.prefix);
  chat.container.addEnvironment('AGENTCORE_BROWSER_EXTENSION_S3_VERSION_ID', browser.extension.versionId);
  // Credential links run in the login browser; Agent Computers in their own browser.
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock-agentcore:GetBrowser', 'bedrock-agentcore:StartBrowserSession',
      'bedrock-agentcore:ListBrowserSessions', 'bedrock-agentcore:GetBrowserSession',
      'bedrock-agentcore:StopBrowserSession', 'bedrock-agentcore:UpdateBrowserStream',
      'bedrock-agentcore:ConnectBrowserAutomationStream', 'bedrock-agentcore:ConnectBrowserLiveViewStream'],
    resources: [origin.formatArn({ service: 'bedrock-agentcore', resource: 'browser-custom', resourceName: browser.id }), agentComputer.browser.attrBrowserArn],
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
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:GetObjectVersion'],
    resources: [`arn:aws:s3:::${browser.extension.bucket}/${browser.extension.prefix}`],
  }));
  const summaryModel = options.turnSummaryModel ?? TURN_SUMMARY_MODEL;
  if (options.turnSummaryModel) chat.container.addEnvironment('BOTCUBE_TURN_SUMMARY_MODEL', `us.${options.turnSummaryModel}`);
  // The Turn summary model runs on a US cross-region inference profile, which routes to US Regions.
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['bedrock:InvokeModel'],
    resources: [
      origin.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: `us.${summaryModel}` }),
      `arn:aws:bedrock:*::foundation-model/${summaryModel}`,
    ],
  }));
}

function createServingOrigin(app: App, options: ProductionOptions, input: OriginInput, health: ApiHealthStack, egress: PrivateEgressStack, wakeUrl: string) {
  const { identity, repositoryRoot } = options;
  const env = { account: identity.aws.account, region: identity.aws.region };
  const origin = new PreviewOriginStack(app, 'PreviewOrigin', {
    env,
    ...(options.vpc ? { vpc: options.vpc } : {}),
    ...(options.publicSubnets ? { subnets: options.publicSubnets } : {}),
    stackName: identity.aws.ecs.previewOriginStackName,
    hostname: new URL(identity.domains.chatServicePreview).hostname,
    production: { hostname: new URL(identity.domains.chatService).hostname },
    repositoryRoot, originProviderPath: path.join(cubeRoot, 'infra/ecs/origin-provider'),
    vpcId: identity.aws.credentialService.vpcId,
    publicSubnets: identity.aws.ecs.publicSubnets,
    cloudflareCidrs: input.cloudflareCidrs, clientVersion: input.clientVersion,
    tokenSecretName: identity.aws.ecs.originTokenSecretName,
    originOwnership: identity.aws.ecs.originOwnership,
    parkedWorkerName: identity.aws.ecs.parkedWorkerName,
    originZone: identity.aws.ecs.originZone,
    clientSecretName: identity.aws.ecs.originPullClientSecretName,
    caPath: identity.aws.ecs.originPullCaCertificate,
    corsOrigins: identity.domains.corsOrigins,
    parkedDnsTarget: identity.aws.ecs.parkedDnsTarget, wakeUrl,
    ...options.originConfig,
  });
  if (options.permissionsBoundary) iam.PermissionsBoundary.of(origin).apply(options.permissionsBoundary);
  origin.addDependency(egress);
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
  const fileSystemArn = storage.filesEfs.attrArn;
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
    resources: [fileSystemArn],
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
