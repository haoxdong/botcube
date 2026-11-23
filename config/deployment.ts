import { z } from 'zod';
import { containerUri, serviceImages } from 'botcube-config/images';
import { fillName, DERIVED_NAMES } from './names.cjs';

/**
 * Each physical name `names` may override, as `<role><CloudFormation name property>`, and what it is absent: derived
 * from `name`, where `{name}` is it, `{snake}` it with `_` for `-`, and `{compact}` it without `-`; or, for `null`,
 * none, so CloudFormation generates it.
 */
export { DERIVED_NAMES } from './names.cjs';

const origin = z
  .url({ protocol: /^https?$/ })
  .refine((url) => new URL(url).origin === url, 'Expected a web origin: a scheme and host, no path (RFC 6454)');
// AWS tag rules: a key of 1 to 128 characters that does not start with aws:, a value of up to 256.
const tagKey = z.string().regex(/^(?!aws:)[A-Za-z0-9 _.:/=+@-]{1,128}$/, 'Expected a tag key of up to 128 letters, digits, spaces and _.:/=+-@, not starting with aws:');

/** The deployment's top-level keys, in the order a reader meets them. */
export const deploymentKeys = {
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, 'Expected lowercase letters, digits and hyphens, starting with a letter')
    .describe("The deployment's name, as CDK's stack name prefix: every physical name derives from it."),
  tags: z
    .record(tagKey, z.string().max(256))
    .optional()
    .describe('Tags, as CDK Tags, on every stack of both CDK apps; the AgentCore project also carries agentcore:project-name.'),
  names: z
    .strictObject(Object.fromEntries(Object.entries(DERIVED_NAMES).map(([key, template]) => [
      key, z.string().min(1).optional().describe(template === null ? 'Absent: CloudFormation generates it.' : `Absent: ${template}, from name.`),
    ])))
    .optional()
    .describe('Physical names that differ from the derived ones, each by its role and CloudFormation name property.'),
  env: z
    .strictObject({
      account: z.string().regex(/^\d{12}$/, 'Expected a 12-digit AWS account ID'),
      region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'Expected an AWS Region such as us-east-1'),
    })
    .describe('Where the deployment runs, as CDK Environment.'),
  domains: z
    .strictObject({
      web: origin.describe('The web UI origin.'),
      webAliases: z.array(origin).optional().describe("Further origins the web UI is served at, as Copilot's http.alias: CORS allows web and these."),
      chatService: origin.describe("The Chat Service's origin; its hostname, over https, issues the per-Turn JWT."),
      chatServicePreview: origin.optional().describe("BotCube-owned: the preview origin's Chat Service, which a deploy verifies before production moves to it."),
      credentialService: origin.optional().describe("The Credential Service's public origin, which the product's own pages call; absent, it is private."),
      productService: origin.optional().describe("The product's own service, which the Credential Service also serves at this origin; needs credentialService."),
    })
    .describe('Where the deployment is reached, each a web origin.'),
};

/** The deployment's keys inside the sections BotCube creates. */
export const agentCore = z
  .strictObject({
    runtime: z.strictObject({
      platformVersion: z.enum(['V1', 'V2']).optional().describe("BotCube-owned: the Runtime's platform generation; absent, V2."),
      containerUri: containerUri.optional(),
      maxLifetime: z.number().int().min(60).max(3600).optional()
        .describe('As LifecycleConfiguration.maxLifetime, in seconds; absent, 3600. Capped by ADR 0029.'),
      idleRuntimeSessionTimeout: z.number().int().min(60).max(900).optional()
        .describe('As LifecycleConfiguration.idleRuntimeSessionTimeout, in seconds; absent, 300.'),
      rollbackEndpoint: z.strictObject({
        agentRuntimeVersion: z.string().regex(/^[1-9][0-9]*$/, 'Expected a Runtime version number').describe('As CloudFormation RuntimeEndpoint.AgentRuntimeVersion.'),
      }).optional().describe('BotCube-owned: a V1_ROLLBACK endpoint on an earlier Runtime version, to move back to; absent, none.'),
    }).optional(),
    browsers: z.strictObject({
      link: z.strictObject({
        extension: z.strictObject({ bucket: z.string().min(1), key: z.string().min(1), versionId: z.string().min(1) })
          .describe("The link browser's extension, as CloudFormation's S3Location."),
      }).optional(),
    }).optional(),
  })
  .optional()
  .describe('The AgentCore resources BotCube creates.');

/** The private subnets natGateways 1 must route to the NAT but names no route table for. */
export function natRouteTables({ network, existing }: { network: { natGateways?: 0 | 1 | undefined }; existing?: { vpc?: { privateSubnets: { routeTableId?: string | undefined }[] } | undefined } | undefined }): (string | number)[][] {
  if (!network.natGateways) return [];
  return (existing?.vpc?.privateSubnets ?? []).flatMap(({ routeTableId }, index) => (routeTableId ? [] : [['existing', 'vpc', 'privateSubnets', index, 'routeTableId']]));
}

export const natGateways = z
  .union([z.literal(0), z.literal(1)])
  .optional()
  .describe('As CDK VpcProps.natGateways: 1, BotCube creates and parks a NAT in existing.vpc; 0 or absent, the VPC brings its own egress.');

export const publicIp = z
  .ipv4()
  .optional()
  .describe("As AWS::EC2::EIP PublicIp: the Elastic IP BotCube's NAT egress leaves through, which the egress stack owns once imported; with natGateways 1.");

export const cloudflare = z
  .strictObject({
    zone: z.string().min(1).describe('BotCube-owned: the Cloudflare zone the origins are records in.'),
    originPull: z.strictObject({
      caCertificate: z.strictObject({ bucket: z.string().min(1), key: z.string().min(1), versionId: z.string().min(1).optional() })
        .describe('The authenticated origin-pull CA bundle, as ElasticLoadBalancingV2 TrustStore S3 bucket, key and optional object version.'),
      organization: z.string().min(1).optional().describe("BotCube-owned: the Organization (O) of the origin pull client certificate's subject; absent, name."),
    }),
  })
  .optional()
  .describe('The Cloudflare records BotCube creates in front of the origins.');

export const services = z
  .strictObject({
    chatService: z.strictObject({ image: serviceImages.chatService.optional() }).optional(),
    credentialService: z.strictObject({
      image: serviceImages.credentialService.optional(),
      http: z.strictObject({
        path: z.string().regex(/^(\/[A-Za-z0-9._~-]+)+$/, 'Expected a path such as /product, with no trailing /').optional()
          .describe('BotCube-owned: the prefix the Credential Service serves its RPC under, which its listener rule and the service read alike; absent, none.'),
        publicPaths: z.array(z.string().startsWith('/', 'Expected a path starting with /')).min(1).optional()
          .describe("BotCube-owned: the paths under path the User's browser may reach at domains.credentialService; required with it."),
      }).optional(),
      leadingKeyPrefixes: z.array(z.string().min(1)).optional()
        .describe("As DynamoDB's dynamodb:LeadingKeys condition: the partition-key prefixes of the Chat table rows the product's service reads and writes."),
    }).optional(),
  })
  .optional()
  .describe('The services BotCube creates, where one serves differently from its default.');

export const alarms = z
  .strictObject({
    runtime: z.strictObject({
      metricNamespace: z.string().min(1).describe("As CloudWatch MetricTransformation.MetricNamespace: the Runtime's log-error metric."),
    }).optional().describe("BotCube-owned: alarms on the Runtime's errors, to the alerts topic; absent, none."),
  })
  .optional()
  .describe('The alarms BotCube creates beside its default ones.');

export const parking = z
  .strictObject({
    automationUserAgents: z.array(z.string().min(1))
      .describe("BotCube-owned: User-Agent substrings marking automation, which doesn't wake a parked deployment."),
    autoPark: z.boolean().optional().describe('BotCube-owned: whether an idle deployment parks itself; absent, it does not.'),
  })
  .optional()
  .describe('Parking, which stops an idle deployment and wakes it on a request.');

/** Each physical name a deployment called `name` gives its resources: `names`' override, or the one derived from `name`. */
export function physicalNames(name: string, names: Partial<Record<string, string>> = {}): Partial<Record<keyof typeof DERIVED_NAMES, string>> {
  return Object.fromEntries(Object.entries(DERIVED_NAMES).flatMap(([key, template]): [string, string][] => {
    const given = names[key] ?? (template === null ? undefined : fillName(template, name));
    return given === undefined ? [] : [[key, given]];
  }));
}

/** A Source of a retired deploy-root file's field: where in the BotCube Config it comes from. */
export type Source =
  | { path: string; default?: unknown; when?: string; as?: 'hostname' | 'list' }
  | { path: string; each: Record<string, string>; when?: string }
  | { path: string; spread: true }
  | { derived: string; when?: string }
  | { value: unknown }
  | { file: string };

const at = (path: string, extra: { default?: unknown; when?: string; as?: 'hostname' | 'list' } = {}): Source => ({ path, ...extra });
const named = (key: keyof typeof DERIVED_NAMES, when?: string): Source =>
  at(`names.${key}`, { ...(DERIVED_NAMES[key] === null ? {} : { default: DERIVED_NAMES[key] }), ...(when ? { when } : {}) });
const POOL = 'integrations.signIn.userPool';
const CREDENTIALS = 'services.credentialService';
const LINK = 'existing.browsers.link';
const NAT = 'network.natGateways';

export const RETIRED_FILES: Readonly<Record<string, Readonly<Record<string, Source>>>> = {
  'identity.json': {
    'aws.account': at('env.account'),
    'aws.region': at('env.region'),
    'aws.cloudFormation.stackFamily': at('name'),
    'aws.agentCore.runtime': named('runtimeAgentRuntimeName'),
    'aws.agentCore.runtimeMonitoring.alarmPrefix': named('runtimeAlarmNamePrefix', 'alarms.runtime'),
    'aws.agentCore.runtimeMonitoring.filterName': named('runtimeErrorsFilterName', 'alarms.runtime'),
    'aws.agentCore.runtimeMonitoring.metricNamespace': at('alarms.runtime.metricNamespace'),
    'aws.agentCore.platformVersion': at('agentCore.runtime.platformVersion'),
    'aws.agentCore.maxLifetime': at('agentCore.runtime.maxLifetime'),
    'aws.agentCore.idleRuntimeSessionTimeout': at('agentCore.runtime.idleRuntimeSessionTimeout'),
    'aws.agentCore.runtimeNetworkParameter': { derived: '/{name}/agentcore/security-group-id', when: LINK },
    'aws.agentCore.memory': named('memoryName'),
    'aws.agentCore.sessionApiFunction': named('sessionApiFunctionName'),
    'aws.agentCore.agentComputerBrowser.name': named('agentComputerBrowserName'),
    'aws.agentCore.agentComputerBrowser.profileNamePrefix': named('agentComputerBrowserProfileNamePrefix'),
    'aws.agentCore.privateNatBrowser.name': named('linkBrowserName', LINK),
    'aws.agentCore.privateNatBrowser.id': at(`${LINK}.browserId`),
    'aws.agentCore.privateNatBrowser.vpcId': at('existing.vpc.vpcId', { when: LINK }),
    'aws.agentCore.privateNatBrowser.browserSecurityGroupId': at(`${LINK}.securityGroupId`),
    'aws.agentCore.privateNatBrowser.extension.bucket': at('agentCore.browsers.link.extension.bucket', { when: LINK }),
    'aws.agentCore.privateNatBrowser.extension.prefix': at('agentCore.browsers.link.extension.key', { when: LINK }),
    'aws.agentCore.privateNatBrowser.extension.versionId': at('agentCore.browsers.link.extension.versionId', { when: LINK }),
    'aws.agentCore.privateNatBrowser.subnets': { path: 'existing.vpc.privateSubnets', each: { id: 'subnetId', availabilityZone: 'availabilityZone', cidrBlock: 'ipv4CidrBlock' }, when: LINK },
    'aws.agentCore.rollbackVersion': at('agentCore.runtime.rollbackEndpoint.agentRuntimeVersion'),
    'aws.credentialService.vpcId': at('existing.vpc.vpcId'),
    'aws.signInPool.name': at(`${POOL}.userPoolName`),
    'aws.signInPool.domainPrefix': at(`${POOL}.domain`),
    'aws.signInPool.customDomain.name': at(`${POOL}.customDomain.domain`),
    'aws.signInPool.customDomain.certificateArn': at(`${POOL}.customDomain.certificateArn`),
    'aws.signInPool.callbackUrls': at(`${POOL}.callbackUrls`),
    'aws.signInPool.logoutUrls': at(`${POOL}.logoutUrls`),
    'aws.signInPool.email.domain': at(`${POOL}.email.sesVerifiedDomain`),
    'aws.signInPool.email.from': at(`${POOL}.email.fromEmail`),
    'aws.signInPool.email.fromName': at(`${POOL}.email.fromName`),
    'aws.signInPool.email.sesVerified': at(`${POOL}.email.sesVerified`),
    'aws.signInPool.google.secretName': at(`${POOL}.google.credential.secretId`),
    'aws.signInPool.login': at(`${POOL}.login`),
    'aws.ecs.privateNamespace': { derived: '{name}.internal' },
    'aws.ecs.credentialService.rpcPath': at(`${CREDENTIALS}.http.path`, { default: '' }),
    'aws.ecs.credentialService.publicHostname': at('domains.credentialService', { as: 'hostname' }),
    'aws.ecs.credentialService.publicPaths': at(`${CREDENTIALS}.http.publicPaths`),
    'aws.ecs.credentialService.chatTableKeyPrefixes': at(`${CREDENTIALS}.leadingKeyPrefixes`),
    'aws.ecs.chatService.turnIdentityKeysSecretName': { derived: '/{name}/chat-service/turn-identity-keys' },
    'aws.ecs.cluster': named('clusterName'),
    'aws.ecs.deployRoleName': named('deployRoleName'),
    'aws.ecs.originPullCaCertificate': at('cloudflare.originPull.caCertificate'),
    'aws.ecs.originPullClientSecretName': { derived: '/{name}/cloudflare/origin-pull-client' },
    'aws.ecs.originTokenSecretName': { derived: '/{name}/cloudflare/origin-api-token' },
    'aws.ecs.previewOriginStackName': named('previewOriginStackName'),
    'aws.ecs.privateEgress.stackName': named('privateEgressStackName', NAT),
    'aws.ecs.privateEgress.publicIp': at('network.publicIp', { when: NAT }),
    'aws.ecs.privateEgress.routeTableId': at('existing.vpc.privateSubnets.0.routeTableId', { when: NAT }),
    'aws.ecs.privateEgress.natGateway.name': named('natGatewayName', NAT),
    'aws.ecs.privateEgress.natGateway.publicSubnetId': at('existing.vpc.publicSubnets.0.subnetId', { when: NAT }),
    'aws.ecs.apiHealth.stackName': named('apiHealthStackName'),
    'aws.ecs.apiHealth.alarmName': named('apiHealthAlarmName'),
    'aws.ecs.webLatency.stackName': named('webLatencyStackName'),
    'aws.ecs.webLatency.appMonitorName': named('webAppMonitorName'),
    'aws.ecs.alertsTopicName': named('alertsTopicName'),
    'aws.ecs.publicSubnets': { path: 'existing.vpc.publicSubnets', each: { id: 'subnetId', availabilityZone: 'availabilityZone' } },
    'aws.ecs.originOwnership': { derived: '{name}:preview-origin' },
    'aws.ecs.parkedWorkerName': { derived: '{name}-parked' },
    'aws.ecs.parking.autoPark': at('parking.autoPark', { default: false }),
    'aws.ecs.parking.functionName': named('parkingFunctionName'),
    'aws.ecs.parking.slotBucket': at('existing.buckets.slots.bucketName'),
    'aws.ecs.parking.originSlotKey': { value: 'dev-slots/DEV_SLOT_ORIGIN' },
    'aws.ecs.originZone': at('cloudflare.zone'),
    'aws.ecs.originPullOrganization': at('cloudflare.originPull.organization', { default: '{name}' }),
    'aws.ecs.deployPolicyName': named('deployPolicyName'),
    'aws.ecs.rollbackTaskFamilyPrefix': { derived: '{name}-preview-rollback-' },
    'aws.ecs.rollbackPolicyName': { derived: '{name}-preview-rollback' },
    'aws.ecr.repository': named('repositoryName'),
    'aws.codeBuild.project': named('buildProjectName'),
    'aws.lambda.family': named('buildFunctionName'),
    'aws.cloudWatch.logGroup': named('buildLogGroupName'),
    'aws.iam.deployUser': named('deployUserName'),
    'aws.iam.runtimeRole': named('runtimeRoleName'),
    'aws.iam.memoryRole': named('memoryRoleName'),
    'aws.iam.userMemoryRole': named('userMemoryRoleName'),
    'aws.iam.chatServiceTaskRole': named('chatServiceTaskRoleName'),
    'aws.iam.filesMountRole': named('filesMountRoleName'),
    'aws.iam.filesLinksRole': named('filesLinksRoleName'),
    'aws.iam.agentComputerBrowserRole': named('agentComputerBrowserRoleName'),
    'aws.iam.lambdaRole': named('buildFunctionRoleName'),
    'aws.iam.codeBuildRole': named('buildRoleName'),
    'aws.iam.sessionApiRole': named('sessionApiRoleName'),
    'aws.iam.invokePolicyFamily': named('invokePolicyNamePrefix'),
    'ssm.runtimeArn': { derived: '/{name}/agentcore/runtime-arn' },
    'ssm.parkState': { derived: '/{name}/production/park-state' },
    'domains.web': at('domains.web'),
    'domains.chatService': at('domains.chatService'),
    'domains.chatServicePreview': at('domains.chatServicePreview'),
    'domains.rawServiceOrigins': at('domains.productService', { as: 'list', default: [] }),
  },
  'agentcore/agentcore.json': {
    name: { derived: '{compact}' },
    'tags.agentcore:project-name': at('name'),
    tags: { path: 'tags', spread: true },
    'runtimes.0.name': { derived: '{snake}' },
    'runtimes.0.dockerfile': { value: 'Dockerfile' },
    'memories.0.name': { derived: '{snake}' },
  },
  'agentcore/aws-targets.json': {
    '0.name': named('agentCoreTargetName'),
    '0.account': at('env.account'),
    '0.region': at('env.region'),
  },
};
