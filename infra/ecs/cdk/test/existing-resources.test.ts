// Test seam 2 (ADR 0091): the enterprise example deploys into the network, keys, tables and buckets its BotCube Config
// supplies, granting nothing on them, pulls every image from its mirror, exports traces to its collector and reaches the
// internet through its proxy; the expected values are its file's.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { App, Stack } from 'aws-cdk-lib';
import { AssetManifestArtifact } from 'aws-cdk-lib/cx-api';
import { Template } from 'aws-cdk-lib/assertions';
import { deployIdentity } from '../lib/deploy-root.js';
import type { DeployIdentity } from '../lib/production-identity.js';
import { footprint } from '../../../../config/footprint.js';
import { registryHost } from '../../../../config/images.js';
import { loadConfig } from '../../../../config/load.js';
import { botcubeConfigPath, synthesizeExample } from './example-fixture.js';

interface Resource { Type: string; Properties: Record<string, unknown> }
interface Container { Name: string; Image: string; Environment?: { Name: string; Value: unknown }[] }

interface StackTemplate { Resources: Record<string, Resource>; Parameters?: Record<string, unknown> }

let templates: StackTemplate[];
let resources: Resource[];
let app: App;
let pooled: App;
beforeAll(async () => {
  app = await synthesizeExample('enterprise');
  pooled = await synthesizeExample('enterprise', undefined, { filesAccessPointMode: 'pool' });
  templates = app.node.children.filter((child): child is Stack => child instanceof Stack).map(stack => Template.fromStack(stack).toJSON() as StackTemplate);
  resources = templates.flatMap(template => Object.values(template.Resources)).map(resource => ({ Properties: {}, ...resource }));
}, 180_000);

/** The logical IDs a value refers to with `Ref` or `Fn::GetAtt`, pseudo parameters aside. */
function references(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const own = 'Ref' in value && typeof value.Ref === 'string' && !value.Ref.startsWith('AWS::') ? [value.Ref]
    : 'Fn::GetAtt' in value && Array.isArray(value['Fn::GetAtt']) ? [String(value['Fn::GetAtt'][0])] : [];
  return [...own, ...Object.values(value).flatMap(references)];
}

const ofType = (type: string) => resources.filter(resource => resource.Type === type);
const containers = (): Container[] => ofType('AWS::ECS::TaskDefinition').flatMap(({ Properties }) => Properties.ContainerDefinitions as Container[]);
function environment(name: string): Record<string, unknown> {
  const matching = containers().filter(container => container.Name === name);
  expect(matching).toHaveLength(1);
  return Object.fromEntries((matching[0]?.Environment ?? []).map(variable => [variable.Name, variable.Value]));
}

const PRIVATE_SUBNETS = ['subnet-fixtureprivatea', 'subnet-fixtureprivateb'];
test('creates only the two config buckets alongside the supplied infrastructure', () => {
  const created = ['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::KMS::Key', 'AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable', 'AWS::S3::Bucket'];
  expect(resources.filter(({ Type }) => created.includes(Type))).toEqual([
    expect.objectContaining({ Type: 'AWS::S3::Bucket', Properties: expect.objectContaining({ BucketName: expect.stringMatching(/^botcube-config-/) }) }),
    expect.objectContaining({ Type: 'AWS::S3::Bucket', Properties: expect.objectContaining({ BucketName: expect.stringMatching(/^botcube-config-/) }) }),
  ]);
});

/** Each existing resource as the enterprise example's file names it. */
const EXISTING = [
  'corp-botcube-chat', 'corp-botcube-vault', 'corp-botcube-connection-logs', 'corp-botcube-sign-in-sheet',
  'fs-0fea7e5f11e5', 'fsap-0acc0047', 'fsap-0a1', 'fsap-0a2',
  ...['11111111-aaaa-4aaa-8aaa-111111111111', '33333333-cccc-4ccc-8ccc-333333333333', '44444444-dddd-4ddd-8ddd-444444444444',
    '55555555-eeee-4eee-8eee-555555555555', '66666666-ffff-4fff-8fff-666666666666'],
];
const POLICY_TYPES = ['AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy', 'AWS::KMS::Key', 'AWS::S3::BucketPolicy', 'AWS::DynamoDB::ResourcePolicy'];

test('grants the Turn role its Memory key and leaves the other existing resource grants to the operator', () => {
  const granting = templates.flatMap(template => Object.entries(template.Resources)
    .filter(([, { Type }]) => POLICY_TYPES.includes(Type))
    .flatMap(([logicalId, resource]) => EXISTING.filter(name => JSON.stringify(resource).includes(name)).map(name => `${logicalId} ${name}`)));
  expect(granting).toEqual(['UserMemoryRoleDefaultPolicy24C09E37 33333333-cccc-4ccc-8ccc-333333333333']);
});

test("places every Lambda function in the existing network's private subnets", () => {
  const functions = templates.flatMap(template => Object.entries(template.Resources).filter(([, { Type }]) => Type === 'AWS::Lambda::Function'));
  expect(functions.length).toBeGreaterThan(0);
  const outside = functions.filter(([, { Properties }]) => JSON.stringify((Properties.VpcConfig as { SubnetIds?: unknown } | undefined)?.SubnetIds) !== JSON.stringify(PRIVATE_SUBNETS));
  expect(outside.map(([logicalId]) => logicalId)).toEqual([]);
});

test("runs the Credential Service's audit copy from its image, in the private subnets, its environment under the existing key", () => {
  const copies = templates.flatMap(template => Object.entries(template.Resources))
    .filter(([logicalId, { Type }]) => Type === 'AWS::Lambda::Function' && logicalId.includes('CredentialServiceAuditCopy'));
  expect(copies.map(([, { Properties }]) => ({
    image: (Properties.Code as { ImageUri?: unknown }).ImageUri,
    subnets: (Properties.VpcConfig as { SubnetIds?: unknown } | undefined)?.SubnetIds,
    key: Properties.KmsKeyArn,
  }))).toEqual([{ image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/bot-cube/credential:release', subnets: PRIVATE_SUBNETS, key: 'arn:aws:kms:us-east-1:000000000000:key/55555555-eeee-4eee-8eee-555555555555' }]);
});

/** Whether the role `roleId` may create network interfaces by an inline grant scoped to the existing subnets. */
function attaches(template: StackTemplate, roleId: string): boolean {
  return Object.values(template.Resources)
    .filter(({ Type, Properties }) => Type === 'AWS::IAM::Policy' && references(Properties.Roles).includes(roleId))
    .flatMap(({ Properties }) => (Properties.PolicyDocument as { Statement: { Action: string | string[]; Resource: unknown }[] }).Statement)
    .some(({ Action, Resource }) => [Action].flat().includes('ec2:CreateNetworkInterface')
      && PRIVATE_SUBNETS.every(subnet => JSON.stringify(Resource).includes(`subnet/${subnet}`)));
}

test('lets each Lambda function attach to the existing network by an inline grant scoped to its subnets', () => {
  const withoutAccess = templates.flatMap(template => Object.entries(template.Resources)
    .filter(([, { Type }]) => Type === 'AWS::Lambda::Function')
    .filter(([, { Properties }]) => !references(Properties.Role).some(roleId => attaches(template, roleId)))
    .map(([logicalId]) => logicalId));
  expect(withoutAccess).toEqual([]);
});

test('refers only to what each stack defines, once the created resources are gone', () => {
  const dangling = templates.flatMap(template => references(template.Resources)
    .filter(id => !(id in template.Resources) && !(id in (template.Parameters ?? {}))));
  expect(dangling).toEqual([]);
});

const EXAMPLE_EGRESS = deployIdentity(path.resolve(__dirname, '../../../../examples/public/deploy')).aws.ecs.privateEgress;

test("leaves egress to the existing network: no NAT, route or Elastic IP, and none of the example's NAT subnet or route table", () => {
  const egress = ['AWS::EC2::NatGateway', 'AWS::EC2::Route', 'AWS::EC2::EIP'];
  expect(resources.filter(({ Type }) => egress.includes(Type)).map(({ Type }) => Type)).toEqual([]);
  const named = JSON.stringify(templates);
  expect([EXAMPLE_EGRESS?.natGateway.publicSubnetId, EXAMPLE_EGRESS?.routeTableId].filter(id => !id || named.includes(id))).toEqual([]);
});

test('fails when its deploy identity also names a NAT, naming both fields', async () => {
  const withNat = (identity: DeployIdentity) => ({ ...identity, aws: { ...identity.aws, ecs: { ...identity.aws.ecs, privateEgress: EXAMPLE_EGRESS } } });
  await expect(synthesizeExample('enterprise', withNat)).rejects.toThrow('network.natGateways, aws.ecs.privateEgress: ');
});

test('without a existing network, fails when its deploy identity names no NAT, naming both fields', async () => {
  const withoutNat = ({ aws: { ecs: { privateEgress: _, ...ecs }, ...aws }, ...identity }: DeployIdentity) => ({ ...identity, aws: { ...aws, ecs } });
  await expect(synthesizeExample('public', withoutNat)).rejects.toThrow('network.natGateways, aws.ecs.privateEgress: ');
});

test('runs in the existing network', () => {
  const vpcs = new Set(ofType('AWS::EC2::SecurityGroup').map(({ Properties }) => Properties.VpcId));
  expect(vpcs).toEqual(new Set(['vpc-fixtureenterprise']));
  const services = ofType('AWS::ECS::Service').map(({ Properties }) =>
    (Properties.NetworkConfiguration as { AwsvpcConfiguration: { Subnets: string[] } }).AwsvpcConfiguration.Subnets);
  expect(services).toEqual([PRIVATE_SUBNETS, PRIVATE_SUBNETS]);
  const [runtime] = ofType('AWS::BedrockAgentCore::Runtime');
  expect(runtime.Properties.NetworkConfiguration).toMatchObject({ NetworkModeConfig: { Subnets: PRIVATE_SUBNETS } });
  expect(ofType('AWS::ElasticLoadBalancingV2::LoadBalancer').map(({ Properties }) => Properties.Subnets))
    .toEqual([['subnet-fixturepublica', 'subnet-fixturepublicb']]);
});

test('names each role that mounts the existing Files from its deploy identity, so the operator can grant it before the first deploy', () => {
  const roleNames = templates.flatMap(template => Object.entries(template.Resources))
    .filter(([, { Type }]) => Type === 'AWS::IAM::Role')
    .flatMap(([logicalId, { Properties }]) => {
      const role = ['ChatServiceTaskTaskRole', 'FilesMountRole', 'AgentComputerBrowserRole'].find(prefix => logicalId.startsWith(prefix));
      return role ? [[role, Properties.RoleName]] : [];
    });
  expect(Object.fromEntries(roleNames)).toEqual({
    ChatServiceTaskTaskRole: 'bot-cube-chat-service',
    FilesMountRole: 'bot-cube-files-mount',
    AgentComputerBrowserRole: 'bot-cube-agent-computer-browser',
  });
});

test('fails when its deploy identity leaves a role that mounts the existing Files unnamed, naming the field', async () => {
  const unnamed = ({ aws: { iam: { filesMountRole: _, ...iam }, ...aws }, ...identity }: DeployIdentity) => ({ ...identity, aws: { ...aws, iam } });
  await expect(synthesizeExample('enterprise', unnamed)).rejects.toThrow('Deploy identity aws.iam.filesMountRole: required with existing.files');
});

test('creates no Files file system, mount target or access point, nor the access-point pool that would fill it', () => {
  const files = ['AWS::EFS::FileSystem', 'AWS::EFS::MountTarget', 'AWS::EFS::AccessPoint'];
  expect(resources.filter(({ Type }) => files.includes(Type)).map(({ Type }) => Type)).toEqual([]);
  const pool = templates.flatMap(template => Object.entries(template.Resources).filter(([logicalId]) => logicalId.startsWith('FilesPool')).map(([, { Type }]) => Type));
  expect(pool.sort()).toEqual(['AWS::CloudWatch::Alarm', 'AWS::Logs::MetricFilter']);
  expect(ofType('AWS::CloudWatch::Alarm').filter(({ Properties }) => String(Properties.AlarmDescription).includes('existing.files.accessPoints'))
    .map(({ Properties }) => Properties.Threshold)).toEqual([2]);
});

test('creates no Files pool, file system or access point in pool mode either: it leases only the existing access points', () => {
  const created = pooled.node.children.filter((child): child is Stack => child instanceof Stack)
    .flatMap(stack => Object.entries((Template.fromStack(stack).toJSON() as StackTemplate).Resources))
    .filter(([logicalId, { Type }]) => Type.startsWith('AWS::EFS::') || (Type === 'AWS::S3::Bucket' && !logicalId.startsWith('BotCubeConfig'))
      || (logicalId.startsWith('FilesPool') && !['AWS::CloudWatch::Alarm', 'AWS::Logs::MetricFilter'].includes(Type)))
    .map(([logicalId, { Type }]) => `${logicalId} ${Type}`);
  expect(created).toEqual([]);
});

test("serves Files from the existing file system, leasing Users' access points from the BotCube Config", () => {
  const chat = environment('chat-service');
  expect(JSON.stringify(chat.BOTCUBE_FILES_EFS_ARN)).toContain(':elasticfilesystem:us-east-1:000000000000:file-system/fs-0fea7e5f11e5');
  expect(Object.keys(chat)).not.toContain('BOTCUBE_FILES_POOL_MANIFEST');
  const volumes = ofType('AWS::ECS::TaskDefinition').flatMap(({ Properties }) => (Properties.Volumes as { EFSVolumeConfiguration?: unknown }[] | undefined) ?? [])
    .map(volume => volume.EFSVolumeConfiguration);
  expect(volumes).toEqual([{ FilesystemId: 'fs-0fea7e5f11e5', TransitEncryption: 'ENABLED', AuthorizationConfig: { AccessPointId: 'fsap-0acc0047', IAM: 'ENABLED' } }]);
  expect(ofType('AWS::Lambda::Function').filter(({ Properties }) => Properties.FileSystemConfigs)).toEqual([]);
});

test('looks up the existing Files mount address in the first runtime subnet AZ', () => {
  const address = environment('chat-service').BOTCUBE_FILES_MOUNT_TARGET_IP;
  const [read] = references(address);
  expect(address).toEqual({ 'Fn::GetAtt': [read, 'IpAddress'] });
  const lookup = templates.flatMap(template => Object.entries(template.Resources)).find(([logicalId]) => logicalId === read)?.[1];
  expect(lookup?.Properties).toMatchObject({
    FileSystemId: 'fs-0fea7e5f11e5', AvailabilityZone: 'us-east-1a',
  });
});

test('selects an available EFS target by AZ across pages and fails when that AZ has none', async () => {
  const [lookup] = ofType('AWS::Lambda::Function').filter(({ Properties }) => JSON.stringify(Properties.Code).includes('paginateDescribeMountTargets'));
  const code = lookup.Properties.Code as { ZipFile: string };
  const sdk = {
    EFSClient: class {},
    paginateDescribeMountTargets: async function* () {
      yield { MountTargets: [{ AvailabilityZoneName: 'us-east-1b', LifeCycleState: 'available', IpAddress: '192.0.2.2' }] };
      yield { MountTargets: [{ AvailabilityZoneName: 'us-east-1a', LifeCycleState: 'available', IpAddress: '192.0.2.1' }] };
    },
  };
  const exports = {} as { handler(event: { RequestType: string; ResourceProperties: { FileSystemId: string; AvailabilityZone: string } }): Promise<unknown> };
  runInNewContext(code.ZipFile, { exports, require: () => sdk });
  const request = (AvailabilityZone: string) => exports.handler({ RequestType: 'Create', ResourceProperties: { FileSystemId: 'fs-0fea7e5f11e5', AvailabilityZone } });
  await expect(request('us-east-1a')).resolves.toEqual({ PhysicalResourceId: 'fs-0fea7e5f11e5:us-east-1a', Data: { IpAddress: '192.0.2.1' } });
  await expect(request('us-east-1c')).rejects.toThrow('No available IPv4 EFS mount target for fs-0fea7e5f11e5 in us-east-1c');
});

test('uses the existing tables and their stream', () => {
  expect(environment('chat-service')).toMatchObject({ BOTCUBE_CHAT_TABLE: 'corp-botcube-chat' });
  expect(environment('credential-service')).toMatchObject({ BOTCUBE_VAULT_TABLE: 'corp-botcube-vault' });
  expect(ofType('AWS::Lambda::EventSourceMapping').map(({ Properties }) => Properties.EventSourceArn))
    .toContain('arn:aws:dynamodb:us-east-1:000000000000:table/corp-botcube-chat/stream/2026-01-01T00:00:00.000');
});

test('encrypts with the existing KMS keys', () => {
  expect(environment('credential-service')).toMatchObject({
    BOTCUBE_VAULT_KMS_KEY_ID: 'arn:aws:kms:us-east-1:000000000000:key/11111111-aaaa-4aaa-8aaa-111111111111',
    BOTCUBE_SHEET_KMS_ALIAS: 'arn:aws:kms:us-east-1:000000000000:alias/corp-botcube-sign-in-sheet',
  });
  expect(ofType('AWS::BedrockAgentCore::Memory').map(({ Properties }) => Properties.EncryptionKeyArn))
    .toEqual(['arn:aws:kms:us-east-1:000000000000:key/33333333-cccc-4ccc-8ccc-333333333333']);
  expect(ofType('AWS::ECR::Repository')).toEqual([]);
});

test('reaches the Credential Service at the existing Endpoint, with no Cloud Map namespace or service', () => {
  expect(ofType('AWS::ServiceDiscovery::PrivateDnsNamespace')).toEqual([]);
  expect(ofType('AWS::ServiceDiscovery::Service')).toEqual([]);
  expect(environment('chat-service')).toMatchObject({ BOTCUBE_CREDENTIAL_SERVICE_URL: 'http://credentials.example.com' });
  expect(ofType('AWS::ECS::Service').flatMap(({ Properties }) => (Properties.LoadBalancers as { TargetGroupArn: unknown }[] | undefined) ?? [])
    .map(({ TargetGroupArn }) => TargetGroupArn))
    .toContain('arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/corp-botcube-credentials/0123456789abcdef');
  expect(ofType('AWS::EC2::SecurityGroupIngress').map(({ Properties }) => Properties)
    .filter(({ SourceSecurityGroupId }) => SourceSecurityGroupId === 'sg-fixturecredentials')
    .map(({ FromPort }) => FromPort)).toEqual([8081]);
});

test('logs connections to the existing bucket', () => {
  const [loadBalancer] = ofType('AWS::ElasticLoadBalancingV2::LoadBalancer');
  expect(loadBalancer.Properties.LoadBalancerAttributes).toEqual(expect.arrayContaining([{ Key: 'connection_logs.s3.bucket', Value: 'corp-botcube-connection-logs' }]));
});

const MIRROR = 'mirror.example.com/ecr-public';
test('pulls its sidecar images from the mirror registry', () => {
  const deploymentImages = new Set(['chat-service', 'credential-service']);
  const sidecars = containers().filter(({ Name }) => !deploymentImages.has(Name));
  expect(sidecars.map(({ Image }) => Image).filter(image => !image.startsWith(`${MIRROR}/`))).toEqual([]);
});

test('builds every image FROM the mirror registry', () => {
  const builds = app.synth().artifacts.filter((artifact): artifact is AssetManifestArtifact => artifact instanceof AssetManifestArtifact)
    .flatMap(artifact => Object.values((JSON.parse(fs.readFileSync(artifact.file, 'utf8')) as { dockerImages?: Record<string, { source: { dockerBuildArgs?: Record<string, string> } }> }).dockerImages ?? {}))
    .map(({ source }) => source.dockerBuildArgs?.REGISTRY);
  expect([...new Set(builds)]).toEqual([MIRROR]);
});

/** The Dockerfiles of the images BotCube builds, relative to botcube/, and the local stack's. */
const DOCKERFILES = ['chat/Dockerfile', 'credential-service/Dockerfile', 'harness/deepagents/Dockerfile',
  'harness/deepagents/session-api.Dockerfile', 'examples/bot/Dockerfile', 'ui/web/Dockerfile'];
const LOCAL_DOCKERFILES = ['infra/local/chat.Dockerfile', 'infra/local/ui.Dockerfile', 'infra/local/harness.Dockerfile', 'infra/local/credential-service.Dockerfile'];
const readDockerfile = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../../..', file), 'utf8');

/**
 * Each image the Dockerfile pulls, built with REGISTRY=`registry`: its `# syntax=` frontend, its FROM images and the
 * images it copies `--from`, other than its own stages and `scratch`.
 */
function baseImages(dockerfile: string, registry: string): string[] {
  const args = new Map([['REGISTRY', registry]]);
  const stages = new Set(['scratch', 'harness']);
  const fill = (value: string) => value.replace(/\$\{(\w+)\}/g, (_, name: string) => args.get(name) ?? `\${${name}}`);
  return dockerfile.split('\n').flatMap(line => {
    const syntax = /^#\s*syntax=(\S+)/.exec(line);
    if (syntax?.[1]) return [syntax[1]];
    const arg = /^ARG (\w+)=(\S+)/.exec(line);
    if (arg?.[1] && arg[2] && !args.has(arg[1])) args.set(arg[1], fill(arg[2]));
    const copied = /^COPY\b.*--from=(\S+)/.exec(line);
    if (copied?.[1]) return stages.has(fill(copied[1])) ? [] : [fill(copied[1])];
    const from = /^FROM (\S+)(?: AS (\S+))?/i.exec(line);
    if (!from?.[1]) return [];
    const image = fill(from[1]);
    const base = stages.has(image) ? [] : [image];
    if (from[2]) stages.add(from[2]);
    return base;
  });
}

test.each([...DOCKERFILES, ...LOCAL_DOCKERFILES])('%s pulls only images in the one registry its REGISTRY build arg names', file => {
  const images = baseImages(readDockerfile(file), MIRROR);
  expect(images.filter(image => !image.startsWith(`${MIRROR}/`))).toEqual([]);
});

/** The image the parking transition's Lambda asset bundles in when it cannot bundle on the machine. */
const BUNDLING = 'sam/build-python3.12';

test('prints under Build images every image the Dockerfiles it builds pull, and its bundling image', () => {
  const config = loadConfig(botcubeConfigPath('enterprise'));
  const registry = registryHost(config.integrations.imageRegistry);
  const pulled = [...DOCKERFILES.flatMap(file => baseImages(readDockerfile(file), registry)), `${registry}/${BUNDLING}`];
  expect(footprint(config).buildImages).toEqual([...new Set(pulled)].sort());
});

/** The values projected from the BotCube Config, which each process reads from the file BOTCUBE_CONFIG names (ADR 0091). */
const PROJECTED = ['BOTCUBE_TELEMETRY_CREDENTIAL', 'BOTCUBE_PROXY_URL', 'BOTCUBE_PROXY_CREDENTIAL', 'BOTCUBE_PROXY_HEADERS', 'BOTCUBE_MODELS_KIND', 'BOTCUBE_MODELS_CACHE_MARKERS'];

test("exports the Chat Service's and the Harness's traces straight to the collector, its credential left to the BotCube Config, and no X-Ray sidecar", () => {
  const exported = {
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://otel-collector.example.com:4318/v1/traces',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-tenant=botcube-example',
  };
  expect(environment('chat-service')).toMatchObject(exported);
  const [runtime] = ofType('AWS::BedrockAgentCore::Runtime');
  expect(runtime.Properties.EnvironmentVariables).toMatchObject(exported);
  expect(containers().map(({ Name }) => Name)).not.toContain('otel-collector');
  const chatPolicies = ofType('AWS::IAM::Policy').filter(({ Properties }) => JSON.stringify(Properties.Roles).includes('ChatServiceTaskTaskRole'));
  expect(chatPolicies.length).toBeGreaterThan(0);
  expect(JSON.stringify(chatPolicies)).not.toContain('xray:');
});

test("sets no proxy variable on any process: each reaches the proxy only for the endpoints that name it, from the BotCube Config", () => {
  const [runtime] = ofType('AWS::BedrockAgentCore::Runtime');
  for (const variables of [environment('chat-service'), environment('credential-service'), runtime.Properties.EnvironmentVariables]) {
    expect(Object.keys(variables ?? {}).filter(name => /PROXY/.test(name))).toEqual([]);
  }
});

test('hands each process the BotCube Config by its locator, never the values projected from it', () => {
  const locator = environment('chat-service').BOTCUBE_CONFIG;
  expect(locator).toMatch(/^s3:\/\/botcube-config-/);
  expect(environment('credential-service').BOTCUBE_CONFIG).toBe(locator);
  const [runtime] = ofType('AWS::BedrockAgentCore::Runtime');
  for (const variables of [environment('chat-service'), environment('credential-service'), runtime.Properties.EnvironmentVariables]) {
    expect(Object.keys(variables ?? {}).filter(name => PROJECTED.includes(name))).toEqual([]);
  }
});


