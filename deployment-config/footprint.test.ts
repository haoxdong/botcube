import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { footprint, formatFootprint } from './footprint.js';
import { loadDeployment } from './load.js';
import type { CredentialSource } from './blocks.js';

const example = (name: string) => fileURLToPath(new URL(`../examples/${name}/deployment-config.json`, import.meta.url));
const printedFor = (name: string) => formatFootprint(footprint(loadDeployment(example(name)).config));
/** The lines of one printed section, from its heading to the next unindented line. */
function section(printed: string, heading: string): string[] {
  const lines = printed.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`No ${heading} section in:\n${printed}`);
  const end = lines.findIndex((line, index) => index > start && line !== '' && !line.startsWith(' '));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter(Boolean);
}

it.each(['public', 'enterprise'])('prints the %s example as supplied and created resources, IAM actions, egress hosts, images and commands', (name) => {
  const headings = printedFor(name).split('\n').filter((line) => line && !line.startsWith(' '));
  expect(headings).toEqual(['Supplied resources', 'Created resources', 'IAM actions', 'Egress hosts', 'Images', 'Build images', 'Commands']);
});

it("names the enterprise example's OIDC issuer host among its egress hosts", () => {
  const printed = printedFor('enterprise');

  expect(printed).toContain('  login.example.com\n');
  expect(printed).not.toContain('<identity.issuer host>');
});

it('lists the resources a Deployment Config runs its OIDC provider on among the supplied ones', () => {
  const { config } = loadDeployment(example('enterprise'));
  if (config.identity.kind !== 'oidc') throw new Error('The enterprise example signs in with OIDC');
  const resources = [{ type: 'AWS::Example::Directory', name: 'example-users' }, { type: 'AWS::Example::Mailer', name: 'example.com' }];

  const printed = formatFootprint(footprint({ ...config, identity: { ...config.identity, resources } }));

  expect(section(printed, 'Supplied resources')).toEqual(expect.arrayContaining([
    '  identity.resources AWS::Example::Directory example-users',
    '  identity.resources AWS::Example::Mailer example.com',
  ]));
});

describe('the enterprise example', () => {
  it('lists each resource it supplies with the grants it carries', () => {
    expect(section(printedFor('enterprise'), 'Supplied resources')).toEqual([
      '  supplied.network vpc-fixtureenterprise',
      "    grant every other Lambda function's role, the deploy's own included: AWS managed policy AWSLambdaVPCAccessExecutionRole",
      '  supplied.kmsKeys.vault arn:aws:kms:us-east-1:000000000000:key/11111111-aaaa-4aaa-8aaa-111111111111',
      '    grant Credential Service task: kms:Decrypt kms:DescribeKey kms:GenerateDataKey',
      '  supplied.kmsKeys.sheet arn:aws:kms:us-east-1:000000000000:key/22222222-bbbb-4bbb-8bbb-222222222222',
      '    grant Credential Service task: kms:Decrypt kms:GetPublicKey',
      '  supplied.kmsKeys.memory arn:aws:kms:us-east-1:000000000000:key/33333333-cccc-4ccc-8ccc-333333333333',
      '    grant AgentCore Memory execution role: kms:Decrypt kms:DescribeKey kms:GenerateDataKey',
      '  supplied.kmsKeys.images arn:aws:kms:us-east-1:000000000000:key/44444444-dddd-4ddd-8ddd-444444444444',
      '    grant Harness (AgentCore Runtime): kms:Decrypt',
      '  supplied.tables.chat corp-botcube-chat',
      '    grant Chat Service task: dynamodb:BatchGetItem dynamodb:BatchWriteItem dynamodb:ConditionCheckItem dynamodb:DeleteItem dynamodb:DescribeTable dynamodb:GetItem dynamodb:GetRecords dynamodb:GetShardIterator dynamodb:PutItem dynamodb:Query dynamodb:Scan dynamodb:UpdateItem',
      '    grant production parking functions: dynamodb:DeleteItem dynamodb:DescribeStream dynamodb:GetItem dynamodb:GetRecords dynamodb:GetShardIterator dynamodb:ListStreams dynamodb:PutItem dynamodb:Query dynamodb:UpdateItem',
      "    grant the deploy role's origin smoke test: dynamodb:DeleteItem dynamodb:PutItem dynamodb:UpdateItem",
      '  supplied.tables.vault corp-botcube-vault',
      '    grant Credential Service task: dynamodb:ConditionCheckItem dynamodb:DeleteItem dynamodb:GetItem dynamodb:PutItem dynamodb:Query dynamodb:UpdateItem',
      '  supplied.buckets.connectionLogs corp-botcube-connection-logs',
      '    grant Elastic Load Balancing log delivery: s3:PutObject',
    ]);
  });

  it('creates none of the resources it supplies', () => {
    expect(section(printedFor('enterprise'), 'Created resources')).toEqual([]);
  });

  it('grants no BotCube role anything on a resource it supplies', () => {
    const { iam } = footprint(loadDeployment(example('enterprise')).config);
    expect(iam.credentialService?.actions.filter((action) => /^(dynamodb|kms):/.test(action))).toEqual([]);
    expect(iam.chatService?.actions.filter((action) => action.startsWith('dynamodb:'))).toEqual([]);
    expect(iam.harness?.actions).not.toContain('kms:Decrypt');
  });

  it('lets every Lambda function attach to the supplied network: each role holds the VPC access policy', () => {
    const { iam } = footprint(loadDeployment(example('enterprise')).config);
    expect([iam.sessionApi?.managedPolicies, iam.filesLinks?.managedPolicies]).toEqual([
      expect.arrayContaining(['AWSLambdaVPCAccessExecutionRole']), expect.arrayContaining(['AWSLambdaVPCAccessExecutionRole'])]);
    expect(section(printedFor('enterprise'), 'Supplied resources').slice(0, 2)).toEqual([
      '  supplied.network vpc-fixtureenterprise',
      "    grant every other Lambda function's role, the deploy's own included: AWS managed policy AWSLambdaVPCAccessExecutionRole",
    ]);
  });

  it('pulls every image, and builds every image FROM, its mirror registry', () => {
    const printed = printedFor('enterprise');
    // Its traces go straight to its own collector, so it pulls no collector sidecar.
    expect(section(printed, 'Images')).toEqual(['  bot (FROM the BotCube Harness image)', '  botcube-chat-service', '  botcube-credential-service']);
    expect(section(printed, 'Build images')).toEqual([
      '  mirror.example.com/ecr-public/docker/library/nginx:stable-alpine',
      '  mirror.example.com/ecr-public/docker/library/node:24-bookworm-slim',
      '  mirror.example.com/ecr-public/docker/library/python:3.13-slim',
      '  mirror.example.com/ecr-public/docker/library/rust:1.88-slim-bookworm',
      '  mirror.example.com/ecr-public/lambda/python:3.13',
      '  mirror.example.com/ecr-public/sam/build-python3.12',
    ]);
    expect(printed).not.toContain('public.ecr.aws');
  });
});

describe('the public example', () => {
  it('supplies nothing and creates every resource BotCube would', () => {
    const printed = printedFor('public');
    expect(section(printed, 'Supplied resources')).toEqual([]);
    expect(section(printed, 'Created resources')).toEqual([
      "  supplied.network: the private subnets' NAT gateway, its Elastic IP and route",
      "  supplied.kmsKeys.vault: the Credential Service's vault key",
      "  supplied.kmsKeys.sheet: the Sign-in Sheet's RSA key",
      "  supplied.kmsKeys.images: the bot image repository's key",
      '  supplied.tables.chat: the chat table and its stream',
      "  supplied.tables.vault: the Credential Service's vault table",
      "  supplied.buckets.connectionLogs: the origin load balancer's connection logs bucket",
    ]);
  });

  it('grants the roles what the resources BotCube creates need', () => {
    const { iam } = footprint(loadDeployment(example('public')).config);
    expect(iam.credentialService?.actions).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'kms:GenerateDataKey', 'kms:GetPublicKey']));
    expect(iam.harness?.actions).toContain('kms:Decrypt');
    expect(iam.sessionApi?.managedPolicies).toEqual(['AWSLambdaBasicExecutionRole']);
  });

  it('pulls from Amazon ECR Public', () => {
    expect(section(printedFor('public'), 'Images')).toContain('  public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0');
  });
});

describe("the models Endpoint's credential", () => {
  const { config } = loadDeployment(example('enterprise'));
  if (config.models.kind !== 'openai-compatible') throw new Error('The enterprise example runs its models on an OpenAI-compatible endpoint');
  const models = config.models;
  const withCredential = (credential: CredentialSource) => footprint({ ...config, allowCommandCredentials: true, models: { ...models, credential } });
  const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube-example/models-api-key';

  it('from a mounted file needs no grant and runs no command', () => {
    const needs = footprint(config);
    expect(JSON.stringify(needs.iam.harness)).not.toContain('secretsmanager');
    expect(needs.egressHosts).toContain('models.example.com');
    expect(needs.commands.filter((command) => command.startsWith('models.'))).toEqual([]);
  });

  it('from a secret grants its readers, the Chat Service and the Harness, its value', () => {
    const needs = withCredential({ kind: 'secret', secretArn });
    expect(needs.iam.chatService?.actions).toContain('secretsmanager:GetSecretValue');
    expect(needs.iam.harness?.actions).toContain('secretsmanager:GetSecretValue');
    expect(needs.egressHosts).toContain('secretsmanager.<region>.amazonaws.com');
  });

  it('from a command lists the command its readers may run', () => {
    const printed = formatFootprint(withCredential({ kind: 'command', command: ['/usr/local/bin/token-broker', '--audience', 'models'], timeoutSeconds: 30 }));
    expect(printed).toContain('\nCommands\n  models.credential (chatService, harness): /usr/local/bin/token-broker --audience models\n');
  });
});

describe("sign-in's client secret", () => {
  const { config } = loadDeployment(example('enterprise'));
  if (config.identity.kind !== 'oidc') throw new Error('The enterprise example signs in with OIDC');
  const identity = config.identity;
  const withClientSecret = (clientSecret: CredentialSource) =>
    footprint({ ...config, identity: { ...identity, clients: [{ clientId: 'botcube', clientSecret }] } });

  it('from a secret grants the Chat Service alone its value', () => {
    const needs = withClientSecret({ kind: 'secret', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/oidc-client-secret' });
    expect(needs.iam.chatService?.actions).toContain('secretsmanager:GetSecretValue');
    expect(needs.iam.harness?.actions).not.toContain('secretsmanager:GetSecretValue');
    expect(needs.egressHosts).toContain('secretsmanager.<region>.amazonaws.com');
  });

  it('from a mounted file grants nothing', () => {
    const needs = withClientSecret({ kind: 'file', path: '/run/secrets/botcube/oidc-client-secret' });
    expect(needs.iam.chatService?.actions).not.toContain('secretsmanager:GetSecretValue');
  });

  it('from the aws source grants, reaches and runs nothing more: the receiver checks it', () => {
    const file = footprint({ ...config, identity: { ...identity, clients: [{ clientId: 'botcube', clientSecret: { kind: 'file', path: '/run/secrets/botcube/oidc-client-secret' } }] } });
    expect(withClientSecret({ kind: 'aws', audience: 'login.example.com' })).toEqual(file);
  });
});

describe('an optional External Service turned off with none', () => {
  const { config } = loadDeployment(example('public'));
  const on = footprint(config);

  it('telemetry: neither service is granted X-Ray, and nothing reaches it or runs the collector', () => {
    const off = footprint({ ...config, telemetry: { kind: 'none' } });
    expect([on.iam.chatService?.actions, on.iam.harness?.actions]).toEqual([expect.arrayContaining(['xray:PutTraceSegments']), expect.arrayContaining(['xray:PutTraceSegments'])]);
    expect([off.iam.chatService?.actions, off.iam.harness?.actions].flat().filter((action) => action?.startsWith('xray:'))).toEqual([]);
    expect(off.egressHosts).not.toContain('xray.<region>.amazonaws.com');
    expect(on.images).toContain('public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0');
    expect(off.images.filter((image) => image.includes('otel-collector'))).toEqual([]);
  });

  it('schedules: the Chat Service is granted no scheduler or run queue sender', () => {
    const off = footprint({ ...config, schedules: { kind: 'none' } });
    expect(on.iam.chatService?.actions).toContain('scheduler:CreateSchedule');
    expect(off.iam.chatService?.actions.filter((action) => action.startsWith('scheduler:') || action === 'sqs:SendMessage')).toEqual([]);
  });

  it("live view: the Chat Service is granted no browser's live view stream", () => {
    const off = footprint({ ...config, liveView: { kind: 'none' } });
    expect(on.iam.chatService?.actions).toContain('bedrock-agentcore:ConnectBrowserLiveViewStream');
    expect(off.iam.chatService?.actions).not.toContain('bedrock-agentcore:ConnectBrowserLiveViewStream');
  });
});

describe("the enterprise example's telemetry Endpoint", () => {
  const { config } = loadDeployment(example('enterprise'));
  const printed = formatFootprint(footprint(config));

  it('is reached directly by both services, without X-Ray or a collector', () => {
    expect(section(printed, 'Egress hosts')).toContain('  otel-collector.example.com:4318');
    expect(section(printed, 'Egress hosts')).not.toContain('  xray.<region>.amazonaws.com');
    expect(printed).not.toContain('otel-collector:v0.50.0');
  });

  it('from a secret grants both services its value', () => {
    if (config.telemetry.kind !== 'otlp') throw new Error('The enterprise example exports to its own collector');
    const needs = footprint({ ...config, telemetry: { ...config.telemetry, credential: { kind: 'secret', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/telemetry-token' } } });
    expect(needs.iam.chatService?.actions).toContain('secretsmanager:GetSecretValue');
    expect(needs.iam.harness?.actions).toContain('secretsmanager:GetSecretValue');
  });
});

describe("the enterprise example's proxy Endpoint", () => {
  const { config } = loadDeployment(example('enterprise'));
  if (config.proxy.kind !== 'forward') throw new Error('The enterprise example reaches the internet through its proxy');
  const proxy = config.proxy;
  const withCredential = (credential: NonNullable<typeof proxy.credential>) => ({ ...config, allowCommandCredentials: true, proxy: { ...proxy, credential } });

  it('from a mounted file, as the example gives it, grants the Harness no secret', () => {
    expect(footprint(config).iam.harness?.actions).not.toContain('secretsmanager:GetSecretValue');
  });

  it('from a secret grants the Chat Service and the Harness, which relay to it, its value', () => {
    const needs = footprint(withCredential({ kind: 'secret', secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/proxy-token' }));
    expect(needs.iam.chatService?.actions).toContain('secretsmanager:GetSecretValue');
    expect(needs.iam.harness?.actions).toContain('secretsmanager:GetSecretValue');
  });

  it('from a command lists the command each of them may run', () => {
    const needs = footprint(withCredential({ kind: 'command', command: ['/usr/local/bin/proxy-token', '--egress'], timeoutSeconds: 30 }));
    expect(needs.commands).toEqual(['proxy.credential (chatService, harness): /usr/local/bin/proxy-token --egress']);
  });
});
