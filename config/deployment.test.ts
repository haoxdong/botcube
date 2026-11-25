import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { botDirectoryErrors, readDeployment, deploymentNames, readConfig, webOrigins } from './read.cjs';
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
  cloudflare: { zone: 'acme.example.com', originPull: { caCertificate: { bucket: 'acme-trust', key: 'origin-pull.pem' } } },
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

describe("a deploy root's native BotCube Config", () => {
  it('loads native keys and derives only physical names', () => {
    const config = readDeployment(deployRoot({ ...DEPLOYMENT, names: { alertsTopicName: 'corp-alerts', linkBrowserName: 'acme_link' } }));
    expect(config).toEqual({ ...DEPLOYMENT, names: { alertsTopicName: 'corp-alerts', linkBrowserName: 'acme_link' } });
    expect(deploymentNames(config)).toMatchObject({
      runtimeAgentRuntimeName: 'acme_bot_runtime', memoryName: 'acme_bot_memory',
      sessionApiFunctionName: 'acme-bot-session-api', clusterName: 'acme-bot',
      alertsTopicName: 'corp-alerts', linkBrowserName: 'acme_link', runtimeRoleName: 'acme-bot-runtime',
    });
  });

  it.each(['*', 'acme-runtime', '1runtime', 'a'.repeat(49)])('reports the field path for invalid Runtime name %s', (runtimeAgentRuntimeName) => {
    const config = { ...DEPLOYMENT, names: { runtimeAgentRuntimeName } };
    expect(() => loadConfig(file(config))).toThrow('names.runtimeAgentRuntimeName:');
    expect(() => readDeployment(deployRoot(config))).toThrow('names.runtimeAgentRuntimeName:');
  });

  it.each(['acme-bot', 'example', 'a-b-c'])('derives fixed names identically in Node and Python for %s', (name) => {
    const config = { name, names: { clusterName: 'custom-cluster', chatServiceTaskRoleName: 'custom-role' } };
    const reader = fileURLToPath(new URL('../credential-service/src/botcube_credential_service/botcube_config.py', import.meta.url));
    const python = execFileSync('python3', ['-c',
      'import json, runpy, sys; print(json.dumps(runpy.run_path(sys.argv[1])["deployment_names"](json.loads(sys.argv[2]))))',
      reader, JSON.stringify(config)], { encoding: 'utf8' });
    expect(deploymentNames(config)).toEqual(JSON.parse(python));
    expect(deploymentNames(config)).toMatchObject({
      parkStateParameterName: `/${name}/production/park-state`,
      originPullClientSecretName: `/${name}/cloudflare/origin-pull-client`,
      originTokenSecretName: `/${name}/cloudflare/origin-api-token`,
      turnIdentityKeysSecretName: `/${name}/chat-service/turn-identity-keys`,
      rollbackTaskFamilyPrefix: `${name}-preview-rollback-`, rollbackPolicyName: `${name}-preview-rollback`,
    });
  });

  it('need the route tables only for the NAT', () => {
    const privateSubnets = VPC.privateSubnets.map(({ routeTableId: _, ...subnet }) => subnet);
    expect(loadConfig(file({ ...DEPLOYMENT, existing: { vpc: { ...VPC, privateSubnets } } })).existing.vpc.privateSubnets).toEqual(privateSubnets);
    expect(() => loadConfig(file({ ...DEPLOYMENT, network: { natGateways: 1 }, existing: { vpc: { ...VPC, privateSubnets } } })))
      .toThrow('existing.vpc.privateSubnets.0.routeTableId: With network.natGateways 1, BotCube routes each private subnet to the NAT: give its route table');
  });

  it('reads the origin-pull CA as an S3 reference without a deploy-tree file', () => {
    const ca = { bucket: 'acme-trust', key: 'origin-pull.pem', versionId: 'v3' };
    const config = { ...DEPLOYMENT, cloudflare: { zone: 'acme.example.com', originPull: { caCertificate: ca } } };
    expect(loadConfig(file(config)).cloudflare?.originPull.caCertificate).toEqual(ca);
    expect(readDeployment(deployRoot(config)).cloudflare?.originPull.caCertificate).toEqual(ca);
  });

  it('keeps existing network and browser keys in their native shape', () => {
    const config = { ...DEPLOYMENT, agentCore: { browsers: { link: { extension: { bucket: 'acme-assets', key: 'ext.zip', versionId: 'v1' } } } }, existing: { vpc: VPC, browsers: { link: { browserId: 'browser-acme', securityGroupId: 'sg-acme' } } } };
    expect(readDeployment(deployRoot(config))).toEqual(config);
  });

  it("hold none of this repository's release settings, and a release.json beside the BotCube Config fails", () => {
    const root = deployRoot(DEPLOYMENT);
    const identity = readDeployment(root);
    for (const field of ['github', 'verification', 'artifacts']) expect(identity).not.toHaveProperty(field);
    writeFileSync(join(root, '../release.json'), JSON.stringify({ github: { environment: 'production' } }));
    expect(() => readDeployment(root)).toThrow('release.json: a configuration file');
  });

  it('fail when there is no BotCube Config beside the deploy root', () => {
    expect(() => readDeployment(deployRoot(undefined))).toThrow(/botcube\.yaml: no file/);
  });

  it.each(['name', 'env', 'domains', 'existing'])('fail on a BotCube Config without %s, naming it as the loaders do', (key) => {
    const { [key as keyof typeof DEPLOYMENT]: _left, ...config } = DEPLOYMENT;
    const root = deployRoot(config);
    expect(() => readDeployment(root)).toThrow(`BotCube Config ${join(root, '../botcube.yaml')}: ${key}: '${key}' is a required property`);
  });
});

describe('a deploy root still holding a retired file', () => {
  it("fails naming each field's botcube.yaml key, or why it has none", () => {
    const root = deployRoot(DEPLOYMENT, { 'identity.json': {
      aws: { account: '000000000000', ecs: { publicSubnets: [{ id: 'subnet-puba' }], parking: { originSlotKey: 'slot' }, cluster: 'acme' } },
      ssm: { parkState: '/acme/park' },
      github: { environment: 'production' },
    } });
    expect(() => readDeployment(root)).toThrow([
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
    expect(() => readDeployment(root)).toThrow(`Deploy root ${root}: ${retired} is retired`);
    rmSync(join(root, retired));
    expect(readDeployment(root)).toHaveProperty('env.account', '123456789012');
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

 it.each([
  ['maxLifetime', 59], ['maxLifetime', 3601], ['maxLifetime', 60.5],
  ['idleRuntimeSessionTimeout', 59], ['idleRuntimeSessionTimeout', 901], ['idleRuntimeSessionTimeout', 60.5],
  ['runtimeMaxLifetimeSeconds', 1800], ['runtimeIdleTimeoutSeconds', 240], ['unknown', 60],
])('rejects agentCore.runtime.%s=%s at both config readers', (key, value) => {
  const path = file({ ...DEPLOYMENT, agentCore: { runtime: { [key]: value } } });
  expect(() => loadConfig(path)).toThrow(`agentCore.runtime.${key}`);
  expect(() => readConfig(path)).toThrow(`agentCore.runtime.${key}`);
});
