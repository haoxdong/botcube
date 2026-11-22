import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { botDirectoryErrors, deployRootFile, readConfig, webOrigins } from './read.cjs';
import { loadConfig } from './load.js';

function file(config: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'botcube-deployment-')), 'botcube.yaml');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

const VPC = {
  vpcId: 'vpc-acme',
  publicSubnets: [{ subnetId: 'subnet-puba', availabilityZone: 'eu-west-1a' }, { subnetId: 'subnet-pubb', availabilityZone: 'eu-west-1b' }],
  privateSubnets: [
    { subnetId: 'subnet-priva', availabilityZone: 'eu-west-1a', ipv4CidrBlock: '192.0.2.0/24', routeTableId: 'rtb-acme' },
    { subnetId: 'subnet-privb', availabilityZone: 'eu-west-1b', ipv4CidrBlock: '198.51.100.0/24', routeTableId: 'rtb-acme' },
  ],
};

const DEPLOYMENT = {
  name: 'acme-bot',
  env: { account: '123456789012', region: 'eu-west-1' },
  domains: { web: 'https://acme.example.com', chatService: 'https://api.acme.example.com', chatServicePreview: 'https://api-next.acme.example.com' },
  cloudflare: { zone: 'acme.example.com', originPull: { caCertificate: 'deploy/origin-pull-ca.crt' } },
  existing: { vpc: VPC },
};

describe("the deployment's keys", () => {
  it('load as the file gives them', () => {
    const config = { ...DEPLOYMENT, tags: { team: 'acme' }, network: { natGateways: 1 }, existing: { vpc: VPC, buckets: { slots: { bucketName: 'acme-slots' } } }, parking: { automationUserAgents: ['bot'], autoPark: true } };
    expect(loadConfig(file(config))).toMatchObject(config);
    expect(readConfig(file(config))).toEqual(config);
  });

  it.each([
    [{ ...DEPLOYMENT, stackFamily: 'acme' }, 'stackFamily'],
    [{ ...DEPLOYMENT, names: { runtimeRole: 'acme-runtime' } }, 'names.runtimeRole'],
    [{ ...DEPLOYMENT, domains: { ...DEPLOYMENT.domains, api: 'https://x.example.com' } }, 'domains.api'],
    [{ ...DEPLOYMENT, existing: { vpc: { ...VPC, natEgress: {} } } }, 'existing.vpc.natEgress'],
  ])('reject an unknown key, naming it: %#', (config, field) => {
    expect(() => loadConfig(file(config))).toThrow(`${field}: Unrecognized key`);
    expect(() => readConfig(file(config))).toThrow(field);
  });

  it("reject a tag key AWS reserves", () => {
    const config = { ...DEPLOYMENT, tags: { 'aws:createdBy': 'acme' } };
    expect(() => loadConfig(file(config))).toThrow('tags');
    expect(() => readConfig(file(config))).toThrow('tags');
  });

  it('allow the web origin and its aliases', () => {
    const domains = { ...DEPLOYMENT.domains, webAliases: ['https://www.acme.example.com'] };
    expect(webOrigins({ domains })).toEqual(['https://acme.example.com', 'https://www.acme.example.com']);
    expect(webOrigins({})).toBeUndefined();
  });
});

/** A deploy root beside a BotCube Config, holding the files given and nothing else. */
function deployRoot(config: unknown, files: Record<string, unknown> = {}): string {
  const root = join(mkdtempSync(join(tmpdir(), 'botcube-deploy-root-')), 'deploy');
  mkdirSync(join(root, 'agentcore'), { recursive: true });
  if (config !== undefined) writeFileSync(join(root, '../botcube.yaml'), JSON.stringify(config));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), JSON.stringify(value));
  return root;
}

describe("a migrated deploy root's files, from its BotCube Config", () => {
  it('name every resource from name, unless names overrides it', () => {
    const identity = deployRootFile(deployRoot({ ...DEPLOYMENT, names: { alertsTopicName: 'corp-alerts', linkBrowserName: 'acme_link' } }), 'identity.json');
    expect(identity).toMatchObject({ aws: {
      account: '123456789012', region: 'eu-west-1',
      cloudFormation: { stackFamily: 'acme-bot' },
      agentCore: { runtime: 'acme_bot_runtime', memory: 'acme_bot_memory', sessionApiFunction: 'acme-bot-session-api' },
      ecs: { cluster: 'acme-bot', alertsTopicName: 'corp-alerts', chatService: { turnIdentityKeysSecretName: '/acme-bot/chat-service/turn-identity-keys' } },
      iam: { runtimeRole: 'acme-bot-runtime' },
    } });
    expect(identity).toHaveProperty('ssm', { runtimeArn: '/acme-bot/agentcore/runtime-arn', parkState: '/acme-bot/production/park-state' });
  });

  it('resolve the origin-pull CA beside the BotCube Config, from the repository root', () => {
    const root = deployRoot(DEPLOYMENT);
    expect(deployRootFile(root, 'identity.json', { repositoryRoot: join(root, '../..') })).toHaveProperty(
      'aws.ecs.originPullCaCertificate', `${join(root, '..').split('/').at(-1)}/deploy/origin-pull-ca.crt`,
    );
  });

  it('take the VPC, and create the NAT in it, leaving through its Elastic IP, only with natGateways 1', () => {
    const own = deployRootFile(deployRoot({ ...DEPLOYMENT, network: { publicIp: '192.0.2.10' }, existing: { vpc: VPC } }), 'identity.json');
    const nat = deployRootFile(deployRoot({ ...DEPLOYMENT, network: { natGateways: 1, publicIp: '192.0.2.10' }, existing: { vpc: VPC } }), 'identity.json');
    expect(own).not.toHaveProperty('aws.ecs.privateEgress');
    expect(own).toHaveProperty('aws.ecs.publicSubnets', [{ id: 'subnet-puba', availabilityZone: 'eu-west-1a' }, { id: 'subnet-pubb', availabilityZone: 'eu-west-1b' }]);
    expect(nat).toHaveProperty('aws.ecs.privateEgress', {
      stackName: 'acme-bot-private-egress', publicIp: '192.0.2.10', routeTableId: 'rtb-acme', natGateway: { name: 'acme-bot-private-egress', publicSubnetId: 'subnet-puba' },
    });
  });

  it('need the route tables only for the NAT', () => {
    const privateSubnets = VPC.privateSubnets.map(({ routeTableId: _, ...subnet }) => subnet);
    expect(loadConfig(file({ ...DEPLOYMENT, existing: { vpc: { ...VPC, privateSubnets } } })).existing.vpc.privateSubnets).toEqual(privateSubnets);
    expect(() => loadConfig(file({ ...DEPLOYMENT, network: { natGateways: 1 }, existing: { vpc: { ...VPC, privateSubnets } } })))
      .toThrow('existing.vpc.privateSubnets.0.routeTableId: With network.natGateways 1, BotCube routes each private subnet to the NAT: give its route table');
  });

  it('place the link browser in the private subnets', () => {
    const config = { ...DEPLOYMENT, agentCore: { browsers: { link: { extension: { bucket: 'acme-assets', key: 'ext.zip', versionId: 'v1' } } } }, existing: { vpc: VPC, browsers: { link: { browserId: 'browser-acme', securityGroupId: 'sg-acme' } } } };
    expect(deployRootFile(deployRoot(config), 'identity.json')).toHaveProperty('aws.agentCore.privateNatBrowser', {
      name: 'acme_bot_link', id: 'browser-acme', vpcId: 'vpc-acme', browserSecurityGroupId: 'sg-acme',
      extension: { bucket: 'acme-assets', prefix: 'ext.zip', versionId: 'v1' },
      subnets: [{ id: 'subnet-priva', availabilityZone: 'eu-west-1a', cidrBlock: '192.0.2.0/24' }, { id: 'subnet-privb', availabilityZone: 'eu-west-1b', cidrBlock: '198.51.100.0/24' }],
    });
  });

  it("hold none of this repository's release settings, and a release.json beside the BotCube Config fails", () => {
    const root = deployRoot(DEPLOYMENT);
    const identity = deployRootFile(root, 'identity.json');
    for (const field of ['github', 'verification', 'artifacts']) expect(identity).not.toHaveProperty(field);
    writeFileSync(join(root, '../release.json'), JSON.stringify({ github: { environment: 'production' } }));
    expect(() => deployRootFile(root, 'identity.json')).toThrow('release.json: a configuration file');
  });

  it('give the AgentCore project and its one target', () => {
    const root = deployRoot({ ...DEPLOYMENT, tags: { team: 'acme' } });
    expect(deployRootFile(root, 'agentcore/agentcore.json')).toEqual({
      name: 'acmebot', tags: { 'agentcore:project-name': 'acme-bot', team: 'acme' },
      runtimes: [{ name: 'acme_bot', dockerfile: '.tool-dist/Dockerfile' }], memories: [{ name: 'acme_bot' }],
    });
    expect(deployRootFile(root, 'agentcore/aws-targets.json')).toEqual([{ name: 'default', account: '123456789012', region: 'eu-west-1' }]);
  });

  it('fail when there is no BotCube Config beside the deploy root', () => {
    expect(() => deployRootFile(deployRoot(undefined), 'identity.json')).toThrow(/identity\.json: BotCube Config .*botcube\.yaml names no deployment/);
  });

  it.each(['name', 'env', 'domains', 'existing'])('fail on a BotCube Config without %s, naming it as the loaders do', (key) => {
    const { [key as keyof typeof DEPLOYMENT]: _left, ...config } = DEPLOYMENT;
    const root = deployRoot(config);
    expect(() => deployRootFile(root, 'identity.json')).toThrow(`BotCube Config ${join(root, '../botcube.yaml')}: ${key}: '${key}' is a required property`);
  });
});

describe('a deploy root still holding a retired file', () => {
  it("fails naming each field's botcube.yaml key, or why it has none", () => {
    const root = deployRoot(DEPLOYMENT, { 'identity.json': {
      aws: { account: '000000000000', ecs: { publicSubnets: [{ id: 'subnet-puba' }], parking: { originSlotKey: 'slot' }, cluster: 'acme' } },
      ssm: { parkState: '/acme/park' },
      github: { environment: 'production' },
    } });
    expect(() => deployRootFile(root, 'agentcore/aws-targets.json')).toThrow([
      `Deploy root ${root}: identity.json is retired: botcube.yaml beside the deploy root replaces it; move each field to its key there, then delete the file`,
      `Deploy root ${root}: identity.json: aws.account: botcube.yaml env.account`,
      `Deploy root ${root}: identity.json: aws.ecs.publicSubnets: botcube.yaml existing.vpc.publicSubnets`,
      `Deploy root ${root}: identity.json: aws.ecs.parking.originSlotKey: BotCube's own value; delete it`,
      `Deploy root ${root}: identity.json: aws.ecs.cluster: botcube.yaml names.clusterName`,
      `Deploy root ${root}: identity.json: ssm.parkState: derived from botcube.yaml name`,
      `Deploy root ${root}: identity.json: github: no botcube.yaml key; delete it`,
    ].join('\n'));
  });

  it.each(['identity.json', 'agentcore/agentcore.json', 'agentcore/aws-targets.json'])('fails for the %s the public example held, and passes once it is gone', retired => {
    const root = deployRoot(DEPLOYMENT);
    copyFileSync(fileURLToPath(new URL(`../tests/fixtures/public-example-deploy-root/${retired}`, import.meta.url)), join(root, retired));
    expect(() => deployRootFile(root, 'identity.json')).toThrow(`Deploy root ${root}: ${retired} is retired`);
    rmSync(join(root, retired));
    expect(deployRootFile(root, 'identity.json')).toHaveProperty('aws.account', '123456789012');
  });

  it('names the AgentCore project fields of the public example', () => {
    const root = deployRoot(DEPLOYMENT);
    copyFileSync(fileURLToPath(new URL('../tests/fixtures/public-example-deploy-root/agentcore/agentcore.json', import.meta.url)), join(root, 'agentcore/agentcore.json'));
    expect(botDirectoryErrors(join(root, '..'), root)).toEqual([
      `Deploy root ${root}: agentcore/agentcore.json is retired: botcube.yaml beside the deploy root replaces it; move each field to its key there, then delete the file`,
      `Deploy root ${root}: agentcore/agentcore.json: name: derived from botcube.yaml name`,
      `Deploy root ${root}: agentcore/agentcore.json: tags.agentcore:project-name: botcube.yaml name`,
      `Deploy root ${root}: agentcore/agentcore.json: runtimes.0.name: derived from botcube.yaml name`,
      `Deploy root ${root}: agentcore/agentcore.json: runtimes.0.dockerfile: BotCube's own value; delete it`,
      `Deploy root ${root}: agentcore/agentcore.json: memories.0.name: derived from botcube.yaml name`,
    ]);
  });
});
