import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { footprint, formatFootprint } from './footprint.js';
import { loadConfig } from './load.js';
import { SUPPLIABLE } from './suppliable.js';
import type { CredentialSource } from './blocks.js';

const example = (name: string) => fileURLToPath(new URL(`../examples/${name}/botcube.yaml`, import.meta.url));
const configReads = [
  '  Resolved BotCube Config: s3:GetObject on s3://botcube-config-000000000000-us-east-1-54bde42c6729292d/resolved/* (chatService, credentialService)',
  '  Resolved BotCube Config: s3:GetObject on s3://botcube-config-000000000000-us-east-1-4dcc6a31a7bde934/resolved/* (harness)',
];
const printedFor = (name: string) => formatFootprint(footprint(loadConfig(example(name))));
/** The lines of one printed section, from its heading to the next unindented line. */
function section(printed: string, heading: string): string[] {
  const lines = printed.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`No ${heading} section in:\n${printed}`);
  const end = lines.findIndex((line, index) => index > start && line !== '' && !line.startsWith(' '));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter(Boolean);
}

it.each(['public', 'enterprise'])('prints the %s example as existing, created and runtime-created resources, IAM actions, egress hosts, images and commands', (name) => {
  const headings = printedFor(name).split('\n').filter((line) => line && !line.startsWith(' '));
  expect(headings).toEqual(['Names', 'Domains', 'Existing resources', 'Created resources', 'Created at runtime', 'IAM actions', 'Models', 'Shell environment', 'Egress hosts', 'TLS', 'Images', 'Build images', 'Commands']);
});

it("names the enterprise example's OIDC issuer host among its egress hosts", () => {
  const printed = printedFor('enterprise');

  expect(printed).toContain('  login.example.com\n');
  expect(printed).not.toContain('<identity.issuer host>');
});

it('lists the resources a BotCube Config runs its OIDC provider on among the existing ones', () => {
  const config = loadConfig(example('enterprise'));
  if (config.integrations.signIn.kind !== 'oidc') throw new Error('The enterprise example signs in with OIDC');
  const resources = [{ type: 'AWS::Example::Directory', name: 'example-users' }, { type: 'AWS::Example::Mailer', name: 'example.com' }];

  const printed = formatFootprint(footprint({ ...config, integrations: { ...config.integrations,  signIn: { ...config.integrations.signIn, resources } } }));

  expect(section(printed, 'Existing resources')).toEqual(expect.arrayContaining([
    '  integrations.signIn.resources AWS::Example::Directory example-users',
    '  integrations.signIn.resources AWS::Example::Mailer example.com',
  ]));
});

describe('the enterprise example', () => {
  it('lists each resource it supplies with the grants it carries', () => {
    expect(section(printedFor('enterprise'), 'Existing resources')).toEqual([
      '  existing.vpc vpc-fixtureenterprise',
      "    grant every other Lambda function's role, the deploy's own included: ec2:AssignPrivateIpAddresses ec2:CreateNetworkInterface ec2:DeleteNetworkInterface ec2:DescribeNetworkInterfaces ec2:DescribeSubnets ec2:UnassignPrivateIpAddresses",
      '    grant its private subnets a route, by a NAT gateway or VPC endpoints: to each egress host below',
      '  existing.browsers.link browser-placeholder (security group sg-placeholder)',
      '  existing.kmsKeys.vault arn:aws:kms:us-east-1:000000000000:key/11111111-aaaa-4aaa-8aaa-111111111111',
      '    grant Credential Service task: kms:Decrypt kms:DescribeKey kms:GenerateDataKey',
      '  existing.kmsKeys.sheet arn:aws:kms:us-east-1:000000000000:alias/corp-botcube-sign-in-sheet',
      '    grant Credential Service task: kms:Decrypt kms:DescribeKey kms:GetPublicKey on arn:aws:kms:us-east-1:000000000000:key/* if ForAnyValue:StringEquals kms:ResourceAliases alias/corp-botcube-sign-in-sheet',
      '  existing.kmsKeys.memory arn:aws:kms:us-east-1:000000000000:key/33333333-cccc-4ccc-8ccc-333333333333',
      '    grant AgentCore Memory execution role: kms:Decrypt kms:DescribeKey kms:GenerateDataKey',
      '  existing.kmsKeys.functions arn:aws:kms:us-east-1:000000000000:key/55555555-eeee-4eee-8eee-555555555555',
      "    grant the Credential Service's audit-copy function's role: kms:Decrypt",
      "    grant the deploy role, which sets the function's environment: kms:CreateGrant kms:Encrypt",
      '  existing.tables.chat corp-botcube-chat',
      '    grant Chat Service task: dynamodb:BatchGetItem dynamodb:BatchWriteItem dynamodb:ConditionCheckItem dynamodb:DeleteItem dynamodb:DescribeTable dynamodb:GetItem dynamodb:GetRecords dynamodb:GetShardIterator dynamodb:PutItem dynamodb:Query dynamodb:Scan dynamodb:UpdateItem',
      '    grant production parking functions: dynamodb:DeleteItem dynamodb:DescribeStream dynamodb:GetItem dynamodb:GetRecords dynamodb:GetShardIterator dynamodb:ListStreams dynamodb:PutItem dynamodb:Query dynamodb:UpdateItem',
      "    grant the deploy role's origin smoke test: dynamodb:DeleteItem dynamodb:PutItem dynamodb:UpdateItem",
      '  existing.tables.vault corp-botcube-vault',
      '    grant Credential Service task: dynamodb:ConditionCheckItem dynamodb:DeleteItem dynamodb:GetItem dynamodb:PutItem dynamodb:Query dynamodb:UpdateItem',
      '  existing.buckets.connectionLogs corp-botcube-connection-logs',
      '    grant Elastic Load Balancing log delivery: s3:PutObject',
      '  existing.buckets.slots bot-cube-sessions',
      '  existing.credentialService http://credentials.example.com',
      '  existing.files fs-0fea7e5f11e5 (KMS key arn:aws:kms:us-east-1:000000000000:key/66666666-ffff-4fff-8fff-666666666666)',
      '    grant Chat Service task (role aws.iam.chatServiceTaskRole): elasticfilesystem:ClientMount elasticfilesystem:ClientWrite',
      '    grant Agent Computer browser (role aws.iam.agentComputerBrowserRole): elasticfilesystem:ClientMount elasticfilesystem:ClientWrite',
      "    grant a Turn's Files mount (role aws.iam.filesMountRole): elasticfilesystem:ClientMount elasticfilesystem:ClientWrite",
      "    grant NFS clients in the existing private subnets: TCP 2049 to the file system's mount target in each subnet",
      "    grant the existing VPC: a resolver that answers <fileSystemId>.efs.<region>.amazonaws.com, the name ECS mounts the Chat Service's own Files volume by: ECS takes no mount target address",
    ]);
  });

  it.each(['runtime', 'pool'] as const)('creates no Files access point at runtime, in %s mode too, and grants no access-point management', (filesAccessPointMode) => {
    const existing = footprint(loadConfig(example('enterprise')), { filesAccessPointMode });
    expect(section(formatFootprint(existing), 'Created at runtime')).toEqual([]);
    expect(existing.iam.chatService?.actions.filter((action) => action.startsWith('elasticfilesystem:'))).toEqual([]);
  });

  it('omits the build repository and its grant when running a published Bot Image', () => {
    const { existing, created, iam } = footprint(loadConfig(example('enterprise')));
    expect(existing.map(resource => resource.field)).not.toContain('existing.kmsKeys.images');
    expect(created.join('\n')).not.toContain('existing.kmsKeys.images');
    expect(iam.harness?.actions).not.toContain('kms:Decrypt');
  });

  it('lists the config reads and bucket endpoints for its own network', () => {
    const printed = printedFor('enterprise');
    expect(section(printed, 'Created resources')).toEqual(configReads);
    expect(section(printed, 'Egress hosts')).toContain('  botcube-config-000000000000-us-east-1-4dcc6a31a7bde934.s3.us-east-1.amazonaws.com (harness)');
    expect(section(printed, 'Egress hosts')).toContain('  botcube-config-000000000000-us-east-1-54bde42c6729292d.s3.us-east-1.amazonaws.com (chatService, credentialService)');
  });

  it('supplies the resources used by a deployment with published images', () => {
    const { existing, runtime } = footprint(loadConfig(example('enterprise')));
    expect(existing.map(({ field }) => field)).toEqual(Object.keys(SUPPLIABLE).filter(key => key !== 'kmsKeys.images').map(key => `existing.${key}`));
    expect(runtime).toEqual([]);
  });

  it('grants no BotCube role anything on a resource it supplies', () => {
    const { iam } = footprint(loadConfig(example('enterprise')));
    expect(iam.credentialService?.actions.filter((action) => /^(dynamodb|kms):/.test(action))).toEqual([]);
    expect(iam.chatService?.actions.filter((action) => action.startsWith('dynamodb:'))).toEqual([]);
    expect(iam.harness?.actions).not.toContain('kms:Decrypt');
  });

  it('lets every Lambda function attach to the existing network by an inline grant, holding no AWS managed policy', () => {
    const { iam } = footprint(loadConfig(example('enterprise')));
    const lambdas = [iam.sessionApi, iam.auditCopy];
    expect(lambdas.map(grant => grant?.actions)).toEqual(Array(2).fill(expect.arrayContaining(['ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface'])));
    expect(lambdas.map(grant => grant?.managedPolicies)).toEqual([[], []]);
  });

  it('pulls every image, and builds every image FROM, its mirror registry', () => {
    const printed = printedFor('enterprise');
    // Its traces go straight to its own collector, so it pulls no collector sidecar.
    expect(section(printed, 'Images')).toEqual(['  123456789012.dkr.ecr.us-east-1.amazonaws.com/bot-cube/chat:release', '  123456789012.dkr.ecr.us-east-1.amazonaws.com/bot-cube/credential:release', '  123456789012.dkr.ecr.us-east-1.amazonaws.com/bot-cube/runtime:release']);
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
  it('names every resource from its name, unless names overrides it, and lists its domains', () => {
    const printed = printedFor('public');
    expect(section(printed, 'Names')).toEqual(expect.arrayContaining([
      '  runtimeAgentRuntimeName bot_cube_runtime',
      '  agentComputerBrowserProfileNamePrefix template_',
      '  linkBrowserName bot_cube_provider_link',
      '  agentCoreTargetName template',
      '  clusterName bot-cube',
      '  buildLogGroupName /aws/lambda/bot-cube-container-build-handler',
    ]));
    expect(section(printed, 'Domains')).toEqual([
      '  domains.web https://chat.example.invalid',
      '  domains.webAliases https://www.chat.example.invalid',
      '  domains.chatService https://api.example.invalid',
      '  domains.chatServicePreview https://api-preview.example.invalid',
    ]);
  });

  it('supplies its link browser and slot bucket, and creates every other resource BotCube would', () => {
    const printed = printedFor('public');
    expect(section(printed, 'Existing resources')).toEqual([
      '  existing.browsers.link browser-placeholder (security group sg-placeholder)',
      '  existing.buckets.slots bot-cube-sessions',
    ]);
    expect(section(printed, 'Created resources')).toEqual([
      "  existing.vpc: the private subnets' NAT gateway, its Elastic IP and route",
      "  existing.kmsKeys.vault: the Credential Service's vault key",
      '  existing.tables.chat: the chat table and its stream',
      "  existing.tables.vault: the Credential Service's vault table",
      "  existing.buckets.connectionLogs: the origin load balancer's connection logs bucket",
      "  existing.credentialService: the Credential Service's private DNS namespace and Cloud Map service",
      '  existing.files: the Files file system, its mount targets and access points',
      ...configReads,
    ]);
  });

  it('grants the roles what the resources BotCube creates need', () => {
    const { iam } = footprint(loadConfig(example('public')));
    expect(iam.credentialService?.actions).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'kms:GenerateDataKey']));
    expect(iam.harness?.actions).not.toContain('kms:Decrypt');
  });

  it('lets each Lambda function write its logs by an inline grant, holding no AWS managed policy', () => {
    const { iam } = footprint(loadConfig(example('public')));
    const OWN_LOGS = ['logs:CreateLogStream', 'logs:PutLogEvents'];
    expect([iam.sessionApi, iam.auditCopy].map(grant => grant?.actions)).toEqual([expect.arrayContaining(OWN_LOGS), OWN_LOGS]);
    expect([iam.sessionApi, iam.auditCopy].map(grant => grant?.managedPolicies)).toEqual([[], []]);
    expect(section(printedFor('public'), 'IAM actions')).toEqual(expect.arrayContaining([
      "  auditCopy (Credential Service's audit-copy function)", '    logs:CreateLogStream', '    logs:PutLogEvents',
    ]));
  });

  it('runs the stock Credential Service, which mounts no Sign-in Sheet routes: no sheet key is created or granted', () => {
    expect(printedFor('public')).not.toContain('Sign-in Sheet');
    expect(footprint(loadConfig(example('public'))).iam.credentialService?.actions).not.toContain('kms:GetPublicKey');
  });

  it("creates each User's Files access point at runtime, and holds the grants to", () => {
    expect(section(printedFor('public'), 'Created at runtime')).toEqual([
      "  elasticfilesystem:CreateAccessPoint on the Files file system (Chat Service, on a User's first Files use)",
    ]);
    expect(footprint(loadConfig(example('public'))).iam.chatService?.actions).toEqual(expect.arrayContaining([
      'elasticfilesystem:CreateAccessPoint', 'elasticfilesystem:DeleteAccessPoint', 'elasticfilesystem:DescribeAccessPoints']));
  });

  it('pulls from Amazon ECR Public', () => {
    expect(section(printedFor('public'), 'Images')).toContain('  public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0');
  });
});

describe('Files access points from the deploy-time pool', () => {
  const pooled = footprint(loadConfig(example('public')), { filesAccessPointMode: 'pool' });

  it('creates nothing at runtime', () => {
    expect(section(formatFootprint(pooled), 'Created at runtime')).toEqual([]);
  });

  it('grants the Chat Service no access-point management, as CDK grants none in pool mode', () => {
    expect(pooled.iam.chatService?.actions.filter((action) => /AccessPoint/.test(action))).toEqual([]);
    expect(pooled.iam.chatService?.actions).toContain('sts:AssumeRole');
  });
});

describe("the models Endpoint's credential", () => {
  const config = loadConfig(example('enterprise'));
  if (config.integrations.modelGateway.kind !== 'openai-compatible') throw new Error('The enterprise example runs its models on an OpenAI-compatible endpoint');
  const models = config.integrations.modelGateway;
  const withCredential = (credential: CredentialSource) => footprint({ ...config, allowCommandCredentials: true, integrations: { ...config.integrations,  modelGateway: { ...models, credential } } });
  const secretId = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube-example/models-api-key';

  it('from a mounted file needs no grant and runs no command', () => {
    const needs = footprint(config);
    expect(JSON.stringify(needs.iam.harness)).not.toContain('secretsmanager');
    expect(needs.egressHosts).toContain('models.example.com');
    expect(needs.commands.filter((command) => command.startsWith('integrations.modelGateway.'))).toEqual([]);
  });

  const anthropic = { url: 'https://anthropic.models.example.com', credential: { kind: 'secret', secretId: 'botcube/anthropic-key' } } as const;
  const bot = { models: [{ key: 'claude-sonnet-5-5', label: 'Sonnet', provider: 'anthropic', maxTokens: 64000 }, { key: 'gpt-5', label: 'GPT', provider: 'openai', maxTokens: 16000 }] };

  it("prints the gateway's URL, each provider's own, and each model of the bot settings with its provider", () => {
    const printed = formatFootprint(footprint({ ...config, integrations: { ...config.integrations, modelGateway: { ...models, providers: { anthropic } } } }, { bot }));
    expect(section(printed, 'Models')).toEqual([
      '  openai-compatible https://models.example.com/v1',
      '  provider anthropic https://anthropic.models.example.com',
      '  model claude-sonnet-5-5: anthropic',
      '  model gpt-5: openai',
    ]);
  });

  it("prints the bot settings' shell environment as the shell holds it, the relay origin's port chosen at runtime", () => {
    const environment = { SITE_URL: '${BOTCUBE_RELAY_URL}/site', NOTE: 'cost $$5' };
    const printed = formatFootprint(footprint(config, { bot: { ...bot, environment } }));
    expect(section(printed, 'Shell environment')).toEqual([
      '  BOTCUBE_RELAY_URL=http://127.0.0.1:<port>',
      '  SITE_URL=http://127.0.0.1:<port>/site',
      '  NOTE=cost $5',
    ]);
  });

  it("reaches a provider's own URL with its own credential from the same readers as the gateway's", () => {
    const needs = footprint({ ...config, integrations: { ...config.integrations, modelGateway: { ...models, providers: { anthropic } } } });
    expect(section(formatFootprint(needs), 'Egress hosts')).toContain('  anthropic.models.example.com (credentialService)');
    expect(needs.iam.credentialService?.actions).toContain('secretsmanager:GetSecretValue');
  });

  it("is reached by the Credential Service for the agent's relayed calls", () => {
    expect(section(formatFootprint(footprint(config)), 'Egress hosts')).toContain('  models.example.com (credentialService)');
  });

  it('from a secret grants the Credential Service access to its value', () => {
    const needs = withCredential({ kind: 'secret', secretId });
    expect(needs.iam.credentialService?.actions).toContain('secretsmanager:GetSecretValue');
    expect(needs.iam.harness?.actions).not.toContain('secretsmanager:GetSecretValue');
    expect(needs.egressHosts).toContain('secretsmanager.<region>.amazonaws.com');
  });

  it('from a command lists the command its readers may run, and the Harness runs none', () => {
    const printed = formatFootprint(withCredential({ kind: 'command', command: ['/usr/local/bin/token-broker', '--audience', 'models'], timeoutSeconds: 30 }));
    expect(printed).toContain('\nCommands\n  integrations.modelGateway.credential (credentialService): /usr/local/bin/token-broker --audience models\n');
  });

  const oauth = (clientSecret: Extract<CredentialSource, { kind: 'oauth-client-credentials' }>['clientSecret']) =>
    withCredential({ kind: 'oauth-client-credentials', tokenEndpoint: 'https://idp.example.com:8443/oauth2/token', clientId: 'botcube-models', clientSecret });

  it('from OAuth client credentials reaches the token endpoint, and grants its readers the client secret and the Harness nothing', () => {
    const needs = oauth({ kind: 'secret', secretId });
    expect(needs.egressHosts).toEqual(expect.arrayContaining(['idp.example.com:8443', 'secretsmanager.<region>.amazonaws.com']));
    expect(needs.iam.credentialService?.actions).toContain('secretsmanager:GetSecretValue');
    expect(needs.iam.harness?.actions).not.toContain('secretsmanager:GetSecretValue');
  });

  it("from OAuth client credentials lists the command its readers may run for the client secret", () => {
    const printed = formatFootprint(oauth({ kind: 'command', command: ['/usr/local/bin/client-secret'], timeoutSeconds: 30 }));
    expect(printed).toContain('\nCommands\n  integrations.modelGateway.credential.clientSecret (credentialService): /usr/local/bin/client-secret\n');
  });
});

describe("sign-in's client secret", () => {
  const config = loadConfig(example('enterprise'));
  if (config.integrations.signIn.kind !== 'oidc') throw new Error('The enterprise example signs in with OIDC');
  const identity = config.integrations.signIn;
  const withClientSecret = (clientSecret: CredentialSource) =>
    footprint({ ...config, integrations: { ...config.integrations,  signIn: { ...identity, clients: [{ clientId: 'botcube', clientSecret }] } } });

  it('from a secret grants the Chat Service alone its value', () => {
    const needs = withClientSecret({ kind: 'secret', secretId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/oidc-client-secret' });
    expect(needs.iam.chatService?.actions).toContain('secretsmanager:GetSecretValue');
    expect(needs.iam.harness?.actions).not.toContain('secretsmanager:GetSecretValue');
    expect(needs.egressHosts).toContain('secretsmanager.<region>.amazonaws.com');
  });

  it('from a mounted file grants nothing', () => {
    const needs = withClientSecret({ kind: 'file', path: '/run/secrets/botcube/oidc-client-secret' });
    expect(needs.iam.chatService?.actions).not.toContain('secretsmanager:GetSecretValue');
  });

  it('from the aws source grants, reaches and runs nothing more: the receiver checks it', () => {
    const file = footprint({ ...config, integrations: { ...config.integrations,  signIn: { ...identity, clients: [{ clientId: 'botcube', clientSecret: { kind: 'file', path: '/run/secrets/botcube/oidc-client-secret' } }] } } });
    expect(withClientSecret({ kind: 'aws', audience: 'login.example.com' })).toEqual(file);
  });
});

describe('the images a BotCube Config names', () => {
  it('stand in the Images for the ones BotCube would build', () => {
    const config = loadConfig(example('public'));
    const bot = '123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/bot@sha256:' + 'b'.repeat(64);
    const chat = 'mirror.example.com/acme/chat:1';
    const credential = '123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/credentials:1';
    const { images } = footprint({ ...config, agentCore: { ...config.agentCore, runtime: { ...config.agentCore?.runtime, containerUri: bot } },
      services: { chatService: { image: chat }, credentialService: { image: credential } } });
    expect(images).toEqual([bot, credential, chat, 'public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0']);
  });
});

describe('an optional External Service turned off with none', () => {
  const config = loadConfig(example('public'));
  const on = footprint(config);

  it('integrations.telemetry: neither service is granted X-Ray, and nothing reaches it or runs the collector', () => {
    const off = footprint({ ...config, integrations: { ...config.integrations,  telemetry: { kind: 'none' } } });
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
  const config = loadConfig(example('enterprise'));
  const printed = formatFootprint(footprint(config));

  it('is reached directly by both services, without X-Ray or a collector', () => {
    expect(section(printed, 'Egress hosts')).toContain('  otel-collector.example.com:4318');
    expect(section(printed, 'Egress hosts')).not.toContain('  xray.<region>.amazonaws.com');
    expect(printed).not.toContain('otel-collector:v0.50.0');
    expect(printed).not.toContain('xray:');
  });

  it('from a secret grants both services its value', () => {
    if (config.integrations.telemetry.kind !== 'otlp') throw new Error('The enterprise example exports to its own collector');
    const needs = footprint({ ...config, integrations: { ...config.integrations,  telemetry: { ...config.integrations.telemetry, credential: { kind: 'secret', secretId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/telemetry-token' } } } });
    expect(needs.iam.chatService?.actions).toContain('secretsmanager:GetSecretValue');
    expect(needs.iam.harness?.actions).toContain('secretsmanager:GetSecretValue');
  });
});

describe("the enterprise example's proxy Endpoint", () => {
  const config = loadConfig(example('enterprise'));
  if (config.integrations.proxy.kind !== 'forward') throw new Error('The enterprise example reaches the internet through its proxy');
  const proxy = config.integrations.proxy;
  const withCredential = (credential: NonNullable<typeof proxy.credential>) => ({ ...config, allowCommandCredentials: true, integrations: { ...config.integrations, proxy: { ...proxy, credential } } });

  it('from a mounted file, as the example gives it, grants the Harness no secret', () => {
    expect(footprint(config).iam.harness?.actions).not.toContain('secretsmanager:GetSecretValue');
  });

  it('from a secret grants the Chat Service and the Harness, which relay to it, its value', () => {
    const needs = footprint(withCredential({ kind: 'secret', secretId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/proxy-token' }));
    expect(needs.iam.chatService?.actions).toContain('secretsmanager:GetSecretValue');
    expect(needs.iam.harness?.actions).toContain('secretsmanager:GetSecretValue');
  });

  it('from a command lists the command each of them may run', () => {
    const needs = footprint(withCredential({ kind: 'command', command: ['/usr/local/bin/proxy-token', '--egress'], timeoutSeconds: 30 }));
    expect(needs.commands).toEqual(['integrations.proxy.credential (chatService, credentialService, harness): /usr/local/bin/proxy-token --egress']);
  });
});

describe('Endpoint TLS', () => {
  const config = loadConfig(example('enterprise'));
  if (config.integrations.modelGateway.kind !== 'openai-compatible' || config.integrations.proxy.kind !== 'forward') throw new Error('The enterprise example has a models Endpoint and a proxy');
  const { modelGateway: models } = config.integrations;
  const { proxy } = config.integrations;
  const KEY = '/run/spiffe/svid-key.pem';
  const files = { clientCertificate: { certificate: '/run/spiffe/svid.pem', key: KEY }, serverIdentity: 'spiffe://example.org/ns/egress/sa/proxy' };
  const command = { clientCertificate: { command: ['/usr/local/bin/svid-broker', '--audience', 'models'] as [string, ...string[]], timeoutSeconds: 30 } };

  it('prints none without a TLS block', () => {
    expect(section(printedFor('enterprise'), 'TLS')).toEqual([]);
  });

  it("prints each Endpoint's expected identity and certificate files, by who connects to it", () => {
    const printed = formatFootprint(footprint({ ...config, integrations: { ...config.integrations,  modelGateway: { ...models, tls: files }, telemetry: { kind: 'otlp', url: 'https://otel-collector.example.com/v1/traces', tls: files }, proxy: { ...proxy, url: 'https://proxy.example.com:3129', tls: files } } }));

    expect(section(printed, 'TLS')).toEqual([
      '  integrations.modelGateway.tls (credentialService): server identity spiffe://example.org/ns/egress/sa/proxy; client certificate /run/spiffe/svid.pem, key /run/spiffe/svid-key.pem',
      '  integrations.proxy.tls (chatService, credentialService, harness): server identity spiffe://example.org/ns/egress/sa/proxy; client certificate /run/spiffe/svid.pem, key /run/spiffe/svid-key.pem',
      '  integrations.telemetry.tls (chatService, harness): server identity spiffe://example.org/ns/egress/sa/proxy; client certificate /run/spiffe/svid.pem, key /run/spiffe/svid-key.pem',
    ]);
  });

  it('lists a client certificate command under Commands', () => {
    const printed = formatFootprint(footprint({ ...config, allowCommandCredentials: true, integrations: { ...config.integrations,  modelGateway: { ...models, tls: command } } }));

    expect(section(printed, 'TLS')).toEqual(['  integrations.modelGateway.tls (credentialService): client certificate from a command']);
    expect(section(printed, 'Commands')).toContain('  integrations.modelGateway.tls.clientCertificate (credentialService): /usr/local/bin/svid-broker --audience models');
  });
});

describe("an outside Harness issuer's bearer", () => {
  const config = loadConfig(example('public'));
  const issuer = 'https://idp.example.com/realms/platform/.well-known/openid-configuration';
  const withToken = (token: CredentialSource) =>
    footprint({ ...config, allowCommandCredentials: true, integrations: { ...config.integrations,  harnessAuth: { kind: 'jwt-bearer', issuer, clients: [{ clientId: 'botcube-harness' }], token } } });

  it('reaches the issuer, which the Runtime authorizer discovers its keys at', () => {
    expect(withToken({ kind: 'file', path: '/run/secrets/botcube/harness-token' }).egressHosts).toContain('idp.example.com');
  });

  it('from a secret grants the Chat Service alone its value', () => {
    const needs = withToken({ kind: 'secret', secretId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/harness-token' });
    expect(needs.iam.chatService?.actions).toContain('secretsmanager:GetSecretValue');
    expect(needs.iam.harness?.actions).not.toContain('secretsmanager:GetSecretValue');
  });

  it('from a command lists the command the Chat Service may run', () => {
    expect(withToken({ kind: 'command', command: ['/usr/local/bin/token-broker', 'harness'], timeoutSeconds: 30 }).commands)
      .toEqual(['integrations.harnessAuth.token (chatService): /usr/local/bin/token-broker harness']);
  });
});

describe('the botcube Harness issuer', () => {
  it('reaches no issuer beyond the Chat Service, which signs the bearer', () => {
    const config = loadConfig(example('public'));
    const sigv4 = footprint(config);
    const botcube = footprint({ ...config, integrations: { ...config.integrations,  harnessAuth: { kind: 'jwt-bearer', issuer: 'botcube', clients: [{ clientId: 'botcube-harness' }] } } });
    expect(botcube.egressHosts).toEqual(sigv4.egressHosts);
  });
});
