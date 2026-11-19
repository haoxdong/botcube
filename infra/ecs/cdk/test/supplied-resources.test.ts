// Test seam 2 (ADR 0091): the enterprise example deploys into the network, keys, tables and buckets its Deployment Config
// supplies, granting nothing on them, pulls every image from its mirror, exports traces to its collector and reaches the
// internet through its proxy; the expected values are its file's.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { AssetManifestArtifact } from 'aws-cdk-lib/cx-api';
import { Template } from 'aws-cdk-lib/assertions';
import type { DeployIdentity } from '../lib/production-identity.js';
import { footprint } from '../../../../deployment-config/footprint.js';
import { loadDeployment } from '../../../../deployment-config/load.js';
import { deploymentConfigPath, synthesizeExample } from './example-fixture.js';

interface Resource { Type: string; Properties: Record<string, unknown> }
interface Container { Name: string; Environment?: { Name: string; Value: unknown }[] }

interface StackTemplate { Resources: Record<string, Resource>; Parameters?: Record<string, unknown> }

let templates: StackTemplate[];
let resources: Resource[];
let app: App;
beforeAll(async () => {
  app = await synthesizeExample('enterprise');
  templates = app.node.children.filter((child): child is Stack => child instanceof Stack).map(stack => Template.fromStack(stack).toJSON() as StackTemplate);
  resources = templates.flatMap(template => Object.values(template.Resources));
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
const PROXY = {
  HTTP_PROXY: 'http://proxy.example.com:3128',
  HTTPS_PROXY: 'http://proxy.example.com:3128',
  NO_PROXY: 'localhost,127.0.0.1,::1,169.254.169.254,169.254.170.2,.amazonaws.com',
  NODE_USE_ENV_PROXY: '1',
};

test('creates no network, KMS key, table or bucket', () => {
  const created = ['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::KMS::Key', 'AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable', 'AWS::S3::Bucket'];
  expect(resources.filter(({ Type }) => created.includes(Type)).map(({ Type }) => Type)).toEqual([]);
});

/** Each supplied resource as the enterprise example's file names it. */
const SUPPLIED = [
  'corp-botcube-chat', 'corp-botcube-vault', 'corp-botcube-connection-logs',
  ...['11111111-aaaa-4aaa-8aaa-111111111111', '22222222-bbbb-4bbb-8bbb-222222222222', '33333333-cccc-4ccc-8ccc-333333333333', '44444444-dddd-4ddd-8ddd-444444444444'],
];
const POLICY_TYPES = ['AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy', 'AWS::KMS::Key', 'AWS::S3::BucketPolicy', 'AWS::DynamoDB::ResourcePolicy'];

test('grants nothing on a supplied resource: no policy anywhere names one', () => {
  const granting = templates.flatMap(template => Object.entries(template.Resources)
    .filter(([, { Type }]) => POLICY_TYPES.includes(Type))
    .flatMap(([logicalId, resource]) => SUPPLIED.filter(name => JSON.stringify(resource).includes(name)).map(name => `${logicalId} ${name}`)));
  expect(granting).toEqual([]);
});

test("places every Lambda function in the supplied network's private subnets", () => {
  const functions = templates.flatMap(template => Object.entries(template.Resources).filter(([, { Type }]) => Type === 'AWS::Lambda::Function'));
  expect(functions.length).toBeGreaterThan(0);
  const outside = functions.filter(([, { Properties }]) => JSON.stringify((Properties.VpcConfig as { SubnetIds?: unknown } | undefined)?.SubnetIds) !== JSON.stringify(PRIVATE_SUBNETS));
  expect(outside.map(([logicalId]) => logicalId)).toEqual([]);
});

test('lets each Lambda function attach to the supplied network: its role holds the VPC access policy', () => {
  const withoutAccess = templates.flatMap(template => Object.entries(template.Resources)
    .filter(([, { Type }]) => Type === 'AWS::Lambda::Function')
    .filter(([, { Properties }]) => !references(Properties.Role).some(roleId => JSON.stringify(template.Resources[roleId]).includes('AWSLambdaVPCAccessExecutionRole')))
    .map(([logicalId]) => logicalId));
  expect(withoutAccess).toEqual([]);
});

test('refers only to what each stack defines, once the created resources are gone', () => {
  const dangling = templates.flatMap(template => references(template.Resources)
    .filter(id => !(id in template.Resources) && !(id in (template.Parameters ?? {}))));
  expect(dangling).toEqual([]);
});

const TEMPLATE_EGRESS = (JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../templates/always-on/deploy/identity.json'), 'utf8')) as DeployIdentity)
  .aws.ecs.privateEgress;

test("leaves egress to the supplied network: no NAT, route or Elastic IP, and none of the template's NAT subnet or route table", () => {
  const egress = ['AWS::EC2::NatGateway', 'AWS::EC2::Route', 'AWS::EC2::EIP'];
  expect(resources.filter(({ Type }) => egress.includes(Type)).map(({ Type }) => Type)).toEqual([]);
  const named = JSON.stringify(templates);
  expect([TEMPLATE_EGRESS?.natGateway.publicSubnetId, TEMPLATE_EGRESS?.routeTableId].filter(id => !id || named.includes(id))).toEqual([]);
});

test('fails when its deploy identity also names a NAT, naming both fields', async () => {
  const withNat = (identity: DeployIdentity) => ({ ...identity, aws: { ...identity.aws, ecs: { ...identity.aws.ecs, privateEgress: TEMPLATE_EGRESS } } });
  await expect(synthesizeExample('enterprise', withNat)).rejects.toThrow('supplied.network, aws.ecs.privateEgress: ');
});

test('without a supplied network, fails when its deploy identity names no NAT, naming both fields', async () => {
  const withoutNat = ({ aws: { ecs: { privateEgress: _, ...ecs }, ...aws }, ...identity }: DeployIdentity) => ({ ...identity, aws: { ...aws, ecs } });
  await expect(synthesizeExample('public', withoutNat)).rejects.toThrow('supplied.network, aws.ecs.privateEgress: ');
});

test('runs in the supplied network', () => {
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

test('uses the supplied tables and their stream', () => {
  expect(environment('chat-service')).toMatchObject({ BOTCUBE_CHAT_TABLE: 'corp-botcube-chat' });
  expect(environment('credential-service')).toMatchObject({ BOTCUBE_VAULT_TABLE: 'corp-botcube-vault' });
  expect(ofType('AWS::Lambda::EventSourceMapping').map(({ Properties }) => Properties.EventSourceArn))
    .toContain('arn:aws:dynamodb:us-east-1:000000000000:table/corp-botcube-chat/stream/2026-01-01T00:00:00.000');
});

test('encrypts with the supplied KMS keys', () => {
  expect(environment('credential-service')).toMatchObject({
    BOTCUBE_VAULT_KMS_KEY_ID: 'arn:aws:kms:us-east-1:000000000000:key/11111111-aaaa-4aaa-8aaa-111111111111',
    BOTCUBE_SHEET_KMS_KEY_ID: 'arn:aws:kms:us-east-1:000000000000:key/22222222-bbbb-4bbb-8bbb-222222222222',
  });
  expect(ofType('AWS::BedrockAgentCore::Memory').map(({ Properties }) => Properties.EncryptionKeyArn))
    .toEqual(['arn:aws:kms:us-east-1:000000000000:key/33333333-cccc-4ccc-8ccc-333333333333']);
  expect(ofType('AWS::ECR::Repository').map(({ Properties }) => Properties.EncryptionConfiguration))
    .toEqual([{ EncryptionType: 'KMS', KmsKey: 'arn:aws:kms:us-east-1:000000000000:key/44444444-dddd-4ddd-8ddd-444444444444' }]);
});

test('logs connections to the supplied bucket', () => {
  const [loadBalancer] = ofType('AWS::ElasticLoadBalancingV2::LoadBalancer');
  expect(loadBalancer.Properties.LoadBalancerAttributes).toEqual(expect.arrayContaining([{ Key: 'connection_logs.s3.bucket', Value: 'corp-botcube-connection-logs' }]));
});

const MIRROR = 'mirror.example.com/ecr-public';
/** The images the example's test fixture stands in for the ones BotCube builds from this repository. */
const BUILT = new Set(['botcube-chat-service', 'botcube-credential-service']);

test('runs every image it does not build from the mirror registry', () => {
  const pulled = containers().map(({ Image }) => (Image as unknown as string)).filter(image => !BUILT.has(image));
  expect(pulled.filter(image => !image.startsWith(`${MIRROR}/`))).toEqual([]);
});

test('builds every image FROM the mirror registry', () => {
  const builds = app.synth().artifacts.filter((artifact): artifact is AssetManifestArtifact => artifact instanceof AssetManifestArtifact)
    .flatMap(artifact => Object.values((JSON.parse(fs.readFileSync(artifact.file, 'utf8')) as { dockerImages?: Record<string, { source: { dockerBuildArgs?: Record<string, string> } }> }).dockerImages ?? {}))
    .map(({ source }) => source.dockerBuildArgs?.REGISTRY);
  // AgentCore builds the bot's image in CodeBuild, with the build args its image builder resource passes.
  const harness = resources.flatMap(({ Properties }) => (typeof Properties.BuildArgs === 'string' ? [JSON.parse(Properties.BuildArgs) as Record<string, string>] : []))
    .map(args => args.REGISTRY);
  expect(builds.length).toBeGreaterThan(0);
  expect({ builds: [...new Set(builds)], harness }).toEqual({ builds: [MIRROR], harness: [MIRROR] });
});

/** The Dockerfiles of the images BotCube builds, relative to botcube/, and the local stack's. */
const DOCKERFILES = ['chat/Dockerfile', 'templates/always-on/deploy/credential-service/Dockerfile', 'harness/deepagents/Dockerfile',
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
  const { config } = loadDeployment(deploymentConfigPath('enterprise'));
  const pulled = [...DOCKERFILES.flatMap(file => baseImages(readDockerfile(file), config.imageRegistry)), `${config.imageRegistry}/${BUNDLING}`];
  expect(footprint(config).buildImages).toEqual([...new Set(pulled)].sort());
});

test("exports the Chat Service's and the Harness's traces straight to the collector, with its credential and headers, and no X-Ray sidecar", () => {
  const exported = {
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://otel-collector.example.com:4318/v1/traces',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-tenant=botcube-example',
    BOTCUBE_TELEMETRY_CREDENTIAL: JSON.stringify({ kind: 'file', path: '/run/secrets/botcube/telemetry-token' }),
  };
  expect(environment('chat-service')).toMatchObject(exported);
  const [runtime] = ofType('AWS::BedrockAgentCore::Runtime');
  expect(runtime.Properties.EnvironmentVariables).toMatchObject(exported);
  expect(containers().map(({ Name }) => Name)).not.toContain('otel-collector');
  const chatPolicies = ofType('AWS::IAM::Policy').filter(({ Properties }) => JSON.stringify(Properties.Roles).includes('ChatServiceTaskTaskRole'));
  expect(chatPolicies.length).toBeGreaterThan(0);
  expect(JSON.stringify(chatPolicies)).not.toContain('xray:');
});

test("sends the Chat Service, the Credential Service and the Runtime through their own relay to the proxy, with its credential and headers", () => {
  const relayed = {
    ...PROXY,
    HTTP_PROXY: 'http://127.0.0.1:3128',
    HTTPS_PROXY: 'http://127.0.0.1:3128',
    BOTCUBE_PROXY_URL: 'http://proxy.example.com:3128',
    BOTCUBE_PROXY_CREDENTIAL: JSON.stringify({ kind: 'file', path: '/run/secrets/botcube/proxy-token' }),
    BOTCUBE_PROXY_HEADERS: JSON.stringify({ 'x-egress-route': 'botcube-example' }),
  };
  expect(environment('chat-service')).toMatchObject(relayed);
  expect(environment('credential-service')).toMatchObject(relayed);
  const [runtime] = ofType('AWS::BedrockAgentCore::Runtime');
  expect(runtime.Properties.EnvironmentVariables).toMatchObject(relayed);
});


