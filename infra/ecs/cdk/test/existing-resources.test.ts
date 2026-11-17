// Test seam 2 (ADR 0091): the enterprise example deploys into the network, keys, tables and buckets its Deployment Config
// names, sends traces to its collector and reaches the internet through its proxy; the expected values are its file's.
import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { synthesizeExample } from './example-fixture.js';

interface Resource { Type: string; Properties: Record<string, unknown> }
interface Container { Name: string; Environment?: { Name: string; Value: unknown }[] }

interface StackTemplate { Resources: Record<string, Resource>; Parameters?: Record<string, unknown> }

let templates: StackTemplate[];
let resources: Resource[];
beforeAll(async () => {
  const app = await synthesizeExample('enterprise');
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

test('refers only to what each stack defines, once the created resources are gone', () => {
  const dangling = templates.flatMap(template => references(template.Resources)
    .filter(id => !(id in template.Resources) && !(id in (template.Parameters ?? {}))));
  expect(dangling).toEqual([]);
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

test('uses the existing tables and their stream', () => {
  expect(environment('chat-service')).toMatchObject({ BOTCUBE_CHAT_TABLE: 'corp-botcube-chat' });
  expect(environment('credential-service')).toMatchObject({ BOTCUBE_VAULT_TABLE: 'corp-botcube-vault' });
  expect(ofType('AWS::Lambda::EventSourceMapping').map(({ Properties }) => Properties.EventSourceArn))
    .toContain('arn:aws:dynamodb:us-east-1:000000000000:table/corp-botcube-chat/stream/2026-01-01T00:00:00.000');
});

test('encrypts with the existing KMS keys', () => {
  expect(environment('credential-service')).toMatchObject({
    BOTCUBE_VAULT_KMS_KEY_ID: 'arn:aws:kms:us-east-1:000000000000:key/11111111-aaaa-4aaa-8aaa-111111111111',
    BOTCUBE_SHEET_KMS_KEY_ID: 'arn:aws:kms:us-east-1:000000000000:key/22222222-bbbb-4bbb-8bbb-222222222222',
  });
  expect(ofType('AWS::BedrockAgentCore::Memory').map(({ Properties }) => Properties.EncryptionKeyArn))
    .toEqual(['arn:aws:kms:us-east-1:000000000000:key/33333333-cccc-4ccc-8ccc-333333333333']);
  expect(ofType('AWS::ECR::Repository').map(({ Properties }) => Properties.EncryptionConfiguration))
    .toEqual([{ EncryptionType: 'KMS', KmsKey: 'arn:aws:kms:us-east-1:000000000000:key/44444444-dddd-4ddd-8ddd-444444444444' }]);
});

test('logs connections to the existing bucket', () => {
  const [loadBalancer] = ofType('AWS::ElasticLoadBalancingV2::LoadBalancer');
  expect(loadBalancer.Properties.LoadBalancerAttributes).toEqual(expect.arrayContaining([{ Key: 'connection_logs.s3.bucket', Value: 'corp-botcube-connection-logs' }]));
});

test("sends the Chat Service's and the Harness's traces to the collector", () => {
  const config = JSON.parse(String(environment('otel-collector').OTEL_CONFIG)) as { exporters: unknown; service: { pipelines: { traces: { exporters: string[] } } } };
  expect(config.exporters).toEqual({ otlphttp: { traces_endpoint: 'http://otel-collector.example.com:4318/v1/traces' } });
  expect(config.service.pipelines.traces.exporters).toEqual(['otlphttp']);
  const [runtime] = ofType('AWS::BedrockAgentCore::Runtime');
  expect(runtime.Properties.EnvironmentVariables).toMatchObject({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://otel-collector.example.com:4318/v1/traces' });
});

test('sends every service through the proxy', () => {
  for (const container of ['chat-service', 'otel-collector', 'credential-service']) expect(environment(container)).toMatchObject(PROXY);
  const [runtime] = ofType('AWS::BedrockAgentCore::Runtime');
  expect(runtime.Properties.EnvironmentVariables).toMatchObject(PROXY);
});
