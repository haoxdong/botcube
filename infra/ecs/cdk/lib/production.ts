import * as fs from 'node:fs';
import * as path from 'node:path';
import { App, CfnOutput, Duration, Tags } from 'aws-cdk-lib';
import { CfnBrowserCustom } from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { ContainerImage, Secret } from 'aws-cdk-lib/aws-ecs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { CfnMountTarget } from 'aws-cdk-lib/aws-s3files';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { ApiHealthStack } from './api-health-stack.js';
import { ChatStorageStack } from './chat-storage-stack.js';
import { PreviewChatService } from './preview-chat-service.js';
import { PreviewOriginStack } from './preview-origin-stack.js';
import { PrivateCredentialService } from './private-credential-service.js';
import { PrivateEgressStack } from './private-egress-stack.js';
import { WebLatencyStack } from './web-latency-stack.js';

/** The cheap foundation model that summarizes each finished Turn for the Activity: `MODEL_ID` in botcube/chat's `turn-summaries.ts`. */
const TURN_SUMMARY_MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0';

/** Non-secret deploy inputs written by the Cartridge's `deploy/ecs/prepare-origin.py`. */
interface OriginInput {
  cloudflareCidrs: string[];
  clientVersion: string;
  runtimeArn?: string;
  memoryId: string;
}

interface Subnet {
  id: string;
  availabilityZone: string;
}

/** The fields of the Cartridge's `deploy/identity.json` the ECS app reads. */
interface DeployIdentity {
  aws: {
    account: string;
    region: string;
    agentCore: {
      runtimeNetworkParameter: string;
      sessionApiFunction: string;
      sessionApiAlias: string;
      /** The Agent Computer's own browser (ADR 0077); its profiles' names start with the prefix. */
      agentComputerBrowser: { name: string; profileNamePrefix: string };
      privateNatBrowser: {
        id: string;
        browserSecurityGroupId: string;
        extension: { bucket: string; prefix: string; versionId: string };
        subnets: Subnet[];
      };
    };
    credentialService: { vpcId: string; port: number };
    ecs: {
      alertsTopicName: string;
      apiHealth: { stackName: string; alarmName: string };
      webLatency: { stackName: string; appMonitorName: string };
      chatService: {
        planUsageOwnerAccountParameter: string;
        environmentKeys: {
          agentComputerCdpUrl: string; filesBucket: string; filesFileSystemArn: string;
          planUsageOwnerAccountId: string;
          agentComputerPolicyBucket: string; agentComputerPolicyKey: string; filesSyncRoleArn: string;
        };
      };
      cluster: string;
      credentialService: {
        tableName: string;
        legacyVault?: { tableName: string; mirrored: boolean };
        rpcPath: string;
        environmentKeys: { url: string; invocationToken: string; port: string; keyId: string; vaultTable: string; legacyVaultTable: string };
      };
      originPullCaCertificate: string;
      originPullClientSecretName: string;
      originTokenSecretName: string;
      parkedDnsTarget: string;
      previewOriginStackName: string;
      privateEgress: { stackName: string; natGateway: { name: string; publicSubnetId: string }; routeTableId: string };
      privateNamespace: string;
      publicSubnets: Subnet[];
    };
  };
  domains: { chatService: string; chatServicePreview: string; corsOrigins: string[] };
  artifacts: { chatService: { reaperCommand: string[] } };
  /** The repository's immutable GitHub OIDC subject prefix (`gh api repos/<repo>/actions/oidc/customization/sub`). */
  github: { oidcSubjectPrefix: string };
}

export interface ProductionOptions {
  originConfig?: Pick<import('./preview-origin-stack.js').PreviewOriginProps, 'providerTimeoutSeconds' | 'providerLogRetention' | 'connectionLogExpirationDays' | 'clientKeepAliveSeconds'>;
  apiHealth?: Pick<import('./api-health-stack.js').ApiHealthStackProps, 'requestIntervalSeconds' | 'failureThreshold' | 'evaluationPeriods'>;
  webLatency?: Partial<Pick<import('./web-latency-stack.js').WebLatencyStackProps, 'sessionSampleRate' | 'moments'>>;
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
  /** Parsed `identity.json` from the deploy directory. */
  identity: DeployIdentity;
  /** Production's operating state: Parked when true, Live when false. */
  parked: boolean;
  /** The serving stack; absent keeps storage and egress synthesizable without live prerequisites. */
  origin?: {
    input: OriginInput;
    images: { chat: ContainerImage; credential: ContainerImage };
    /** The checkout's commit, tagged on each task definition for `scripts/dev-status.sh`. */
    commit: string;
  } | undefined;
}

/**
 * The `parked` CDK context flag, passed as `-c parked=true|false`. CLI context
 * arrives as a string, so `'false'` must not be read as truthy.
 */
export function parkedContext(value: unknown): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Context parked must be true or false, got ${JSON.stringify(value)}`);
}

/** Every stack of the ECS CDK app (ADR 0065). */
export function defineProduction(app: App, options: ProductionOptions) {
  const { identity } = options;
  const env = { account: identity.aws.account, region: identity.aws.region };
  const storage = new ChatStorageStack(app, 'ChatStorage', { env, corsOrigins: identity.domains.corsOrigins, ...(options.chatTableName ? { tableName: options.chatTableName } : {}) });
  const egressConfig = identity.aws.ecs.privateEgress;
  const egress = new PrivateEgressStack(app, 'PrivateEgress', {
    env, stackName: egressConfig.stackName, natGateway: egressConfig.natGateway, routeTableId: egressConfig.routeTableId,
    parked: options.parked,
  });
  const health = new ApiHealthStack(app, 'ApiHealth', {
    env, stackName: identity.aws.ecs.apiHealth.stackName, alarmName: identity.aws.ecs.apiHealth.alarmName,
    hostname: new URL(identity.domains.chatService).hostname, alertsTopicName: identity.aws.ecs.alertsTopicName,
    parked: options.parked,
    ...options.apiHealth,
  });
  const webLatency = new WebLatencyStack(app, 'WebLatency', {
    env, stackName: identity.aws.ecs.webLatency.stackName, appMonitorName: identity.aws.ecs.webLatency.appMonitorName,
    // The web and its Dev environment: every https origin the Chat Service serves.
    domains: identity.domains.corsOrigins.filter(origin => origin.startsWith('https://')).map(origin => new URL(origin).hostname),
    readerSubject: `${identity.github.oidcSubjectPrefix}:ref:refs/heads/main`,
    ...options.webLatency,
    moments: options.webLatency?.moments ?? Object.keys(JSON.parse(fs.readFileSync(path.join(options.deployRoot, '..', 'latency-budgets.json'), 'utf8')).moments),
  });
  if (options.permissionsBoundary) {
    for (const stack of [storage, egress, health, webLatency]) iam.PermissionsBoundary.of(stack).apply(options.permissionsBoundary);
  }
  if (!options.origin) return;
  const { input, images, commit } = options.origin;
  const origin = createServingOrigin(app, options, input, health, egress);
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
    memoryId: input.memoryId,
    sessionApiFunctionName: identity.aws.agentCore.sessionApiFunction,
    sessionApiAlias: identity.aws.agentCore.sessionApiAlias,
    reaperCommand: identity.artifacts.chatService.reaperCommand,
    authBrowserId: identity.aws.agentCore.privateNatBrowser.id,
    // aws-cdk-lib's Table declares `T | undefined` getters where ITable declares `prop?: T`,
    // which exactOptionalPropertyTypes rejects; the construct is its interface.
    chatTable: storage.chatTable as ITable,
    image: images.chat,
    ...options.chat,
    parked: options.parked,
  });
  const agentNetwork = new ec2.SecurityGroup(origin, 'AgentNetwork', { vpc: chat.cluster.vpc });
  new ssm.StringParameter(origin, 'AgentSecurityGroupParameter', {
    parameterName: identity.aws.agentCore.runtimeNetworkParameter, stringValue: agentNetwork.securityGroupId,
  });
  new CfnOutput(origin, 'AgentSecurityGroupId', { value: agentNetwork.securityGroupId });
  const chatKeys = identity.aws.ecs.chatService.environmentKeys;
  const planUsageOwner = ssm.StringParameter.valueForStringParameter(origin, identity.aws.ecs.chatService.planUsageOwnerAccountParameter);
  chat.container.addEnvironment(chatKeys.planUsageOwnerAccountId, planUsageOwner);
  const agentComputer = addAgentComputerBrowser(origin, chat, storage, browserConfiguration(options, chat.cluster.vpc), options.deployRoot);
  const credentialConfig = identity.aws.ecs.credentialService;
  const credentials = new PrivateCredentialService(origin, 'CredentialService', {
    ...(options.executionRole ? { executionRole: options.executionRole } : {}),
    ...(options.kmsKey ? { kmsKey: options.kmsKey } : {}),
    ...(options.privateSubnets ? { subnets: options.privateSubnets } : {}),
    cluster: chat.cluster, chatNetwork: chat.network, agentNetwork,
    tableName: credentialConfig.tableName, ...(credentialConfig.legacyVault ? { legacyVault: credentialConfig.legacyVault } : {}), rpcPath: credentialConfig.rpcPath, environmentKeys: credentialConfig.environmentKeys, namespaceName: identity.aws.ecs.privateNamespace,
    alertsTopicName: identity.aws.ecs.alertsTopicName, port: identity.aws.credentialService.port,
    image: images.credential, authBrowserId: identity.aws.agentCore.privateNatBrowser.id,
    agentComputerBrowserId: agentComputer.browser.attrBrowserId,
    ...options.credentials,
    parked: options.parked,
  });
  credentials.container.addEnvironment(chatKeys.planUsageOwnerAccountId, planUsageOwner);
  // A tag changes a task definition in place, so a draining task keeps its own revision's commit.
  for (const task of [chat.task, credentials.task]) {
    Tags.of(task).add('commit', commit, { includeResourceTypes: ['AWS::ECS::TaskDefinition'] });
  }
  addFiles(origin, chat, storage, agentComputer, chatKeys, options.deployRoot);
  // The agent reaches its Agent Computer only through the Chat Service's CDP filter (ADR 0075 decision 5).
  chat.network.connections.allowFrom(agentNetwork, ec2.Port.tcp(options.chat?.port ?? 8123), 'Harness Agent Computer CDP');
  // The Chat Service puts its own task address in for the host, so each Turn reaches the task holding its Agent Computer.
  chat.container.addEnvironment(chatKeys.agentComputerCdpUrl, `ws://task-address:${options.chat?.port ?? 8123}/agent-computer/cdp`);
  chat.container.addEnvironment(credentialConfig.environmentKeys.url, credentials.url);
  // aws-cdk-lib's Secret declares `T | undefined` getters where ISecret declares `prop?: T`,
  // which exactOptionalPropertyTypes rejects; the construct is its interface.
  chat.container.addSecret(credentialConfig.environmentKeys.invocationToken, Secret.fromSecretsManager(credentials.invocationSecret as ISecret));
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

function createServingOrigin(app: App, options: ProductionOptions, input: OriginInput, health: ApiHealthStack, egress: PrivateEgressStack) {
  const { identity, repositoryRoot } = options;
  const env = { account: identity.aws.account, region: identity.aws.region };
  const origin = new PreviewOriginStack(app, 'PreviewOrigin', {
    env,
    ...(options.vpc ? { vpc: options.vpc } : {}),
    ...(options.publicSubnets ? { subnets: options.publicSubnets } : {}),
    stackName: identity.aws.ecs.previewOriginStackName,
    hostname: new URL(identity.domains.chatServicePreview).hostname,
    production: { hostname: new URL(identity.domains.chatService).hostname },
    repositoryRoot, originProviderPath: path.join(options.deployRoot, 'ecs', 'origin-provider'),
    vpcId: identity.aws.credentialService.vpcId,
    publicSubnets: identity.aws.ecs.publicSubnets,
    cloudflareCidrs: input.cloudflareCidrs, clientVersion: input.clientVersion,
    tokenSecretName: identity.aws.ecs.originTokenSecretName,
    clientSecretName: identity.aws.ecs.originPullClientSecretName,
    caPath: identity.aws.ecs.originPullCaCertificate,
    corsOrigins: identity.domains.corsOrigins,
    parked: options.parked, parkedDnsTarget: identity.aws.ecs.parkedDnsTarget,
    ...options.originConfig,
  });
  if (options.permissionsBoundary) iam.PermissionsBoundary.of(origin).apply(options.permissionsBoundary);
  // Monitoring is off whenever the origin is not serving: park silences it
  // first, unpark restores it last, so neither transition raises an alert.
  if (options.parked) origin.addDependency(health);
  else health.addDependency(origin);
  // Unpark creates the NAT Gateway and default route before the services start;
  // park removes them only after the services have parked, so a failed park
  // rolls back to Live services that still have egress.
  if (options.parked) egress.addDependency(origin);
  else origin.addDependency(egress);
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
  deployRoot: string,
) {
  const network = new ec2.SecurityGroup(origin, 'AgentComputerBrowsers', { vpc: chat.cluster.vpc });
  const role = new iam.Role(origin, 'AgentComputerBrowserRole', {
    assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': origin.account } } }),
  });
  const fileSystemArn = storage.filesFileSystem.attrFileSystemArn;
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3files:ClientMount', 's3files:ClientWrite', 's3files:GetAccessPoint'],
    resources: [fileSystemArn],
    conditions: { ArnLike: { 's3files:AccessPointArn': `${fileSystemArn}/access-point/*` } },
  }));
  const { subnets } = agentCore.privateNatBrowser;
  const managedPolicy = new Asset(origin, 'AgentComputerChromeManagedPolicy', {
    path: path.join(deployRoot, 'agent-computer', 'chrome-managed-policy.json'),
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
 * Every account's Files (ADR 0077 decision 2): the file system's mount targets
 * in the browser subnets, the Chrome policy that downloads into the mount, and
 * the Chat Service's access to create each account's access point and to
 * presign transfers inside `accounts/`.
 */
function addFiles(
  origin: PreviewOriginStack,
  chat: PreviewChatService,
  storage: ChatStorageStack,
  browsers: { network: ec2.ISecurityGroup; subnets: Subnet[] },
  keys: DeployIdentity['aws']['ecs']['chatService']['environmentKeys'],
  deployRoot: string,
) {
  const mountTargets = new ec2.SecurityGroup(origin, 'FilesMountTargets', { vpc: chat.cluster.vpc, allowAllOutbound: false });
  mountTargets.addIngressRule(browsers.network, ec2.Port.tcp(2049), 'Agent Computer browsers mount Files');
  browsers.subnets.forEach((subnet, index) => new CfnMountTarget(origin, `FilesMountTarget${index}`, {
    fileSystemId: storage.filesFileSystem.attrFileSystemId, subnetId: subnet.id, securityGroups: [mountTargets.securityGroupId],
  }));
  const policy = new Asset(origin, 'AgentComputerChromePolicy', { path: path.join(deployRoot, 'agent-computer', 'chrome-policy.json') });
  policy.grantRead(chat.task.taskRole);
  const fileSystemArn = storage.filesFileSystem.attrFileSystemArn;
  chat.container.addEnvironment(keys.filesBucket, storage.filesBucket.bucketName);
  chat.container.addEnvironment(keys.filesFileSystemArn, fileSystemArn);
  chat.container.addEnvironment(keys.agentComputerPolicyBucket, policy.s3BucketName);
  chat.container.addEnvironment(keys.agentComputerPolicyKey, policy.s3ObjectKey);
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['s3files:CreateAccessPoint', 's3files:GetAccessPoint', 's3files:DeleteAccessPoint'],
    resources: [fileSystemArn, `${fileSystemArn}/access-point/*`],
  }));
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket'],
    resources: [storage.filesBucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': 'accounts/*' } },
  }));
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
    resources: [storage.filesBucket.arnForObjects('accounts/*')],
  }));
  // An Account Claim moves the anonymous account's files out of its directory.
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['s3:DeleteObject'],
    resources: [storage.filesBucket.arnForObjects('accounts/*')],
  }));
  // Account deletion removes every version of the account's files from the versioned bucket.
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucketVersions'],
    resources: [storage.filesBucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': 'accounts/*' } },
  }));
  chat.task.addToTaskRolePolicy(new iam.PolicyStatement({
    actions: ['s3:DeleteObjectVersion'],
    resources: [storage.filesBucket.arnForObjects('accounts/*')],
  }));
  // The agent's workspace syncs through this role, which the Chat Service assumes per Turn with a
  // session policy narrowed to one account's directory; the Runtime's own role reaches no Files.
  const sync = new iam.Role(origin, 'FilesSyncRole', { assumedBy: chat.task.taskRole, maxSessionDuration: Duration.hours(1) });
  sync.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket'],
    resources: [storage.filesBucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': 'accounts/*' } },
  }));
  sync.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject'],
    resources: [storage.filesBucket.arnForObjects('accounts/*')],
  }));
  chat.container.addEnvironment(keys.filesSyncRoleArn, sync.roleArn);
}
