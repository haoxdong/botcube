import { ok as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findConfigRoot, type AgentCoreProjectSpec } from '@aws/agentcore-cdk';
import { loadDeployConfig, type DeployIdentity } from '../lib/deploy-config';

const TEMPLATE_DEPLOY = path.resolve(__dirname, '../../../../template/deploy');
const tempRoots: string[] = [];

/** The template spec's one runtime. */
function runtimeOf(spec: AgentCoreProjectSpec) {
  const [runtime] = spec.runtimes;
  assert(runtime, 'the template spec declares a runtime');
  return runtime;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  identity?: (identity: DeployIdentity) => void;
  spec?: (spec: AgentCoreProjectSpec) => void;
  targets?: unknown[];
}

/** A copy of the template Cartridge deploy root, edited per test. */
function deployRoot(fixture: Fixture = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcore-deploy-config-'));
  tempRoots.push(root);
  const identity: DeployIdentity = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DEPLOY, 'identity.json'), 'utf8'));
  const spec: AgentCoreProjectSpec = JSON.parse(
    fs.readFileSync(path.join(TEMPLATE_DEPLOY, 'agentcore/agentcore.json'), 'utf8')
  );
  const [memory] = spec.memories;
  assert(memory, 'the template spec declares a memory');
  fixture.identity?.(identity);
  fixture.spec?.(spec);
  fs.mkdirSync(path.join(root, 'agentcore'));
  fs.writeFileSync(path.join(root, 'identity.json'), JSON.stringify(identity));
  fs.writeFileSync(path.join(root, 'agentcore/agentcore.json'), JSON.stringify(spec));
  fs.writeFileSync(
    path.join(root, 'agentcore/aws-targets.json'),
    JSON.stringify(fixture.targets ?? [{ name: 'template', account: '000000000000', region: 'us-east-1' }])
  );
  return root;
}

test('requires CARTRIDGE_DEPLOY_ROOT', async () => {
  await expect(loadDeployConfig(undefined, '/')).rejects.toThrow(
    new Error('CARTRIDGE_DEPLOY_ROOT must point to the active Cartridge deploy directory')
  );
});

test('loads the identity, project spec and targets from a deploy root relative to the working directory', async () => {
  const root = deployRoot();

  const config = await loadDeployConfig(path.basename(root), path.dirname(root));

  expect(config.deployRoot).toBe(root);
  expect(config.identity.aws.cloudFormation.stackFamily).toBe('bot-cube');
  expect(config.spec.name).toBe('botcube');
  expect(config.targets).toEqual([expect.objectContaining({ name: 'template', account: '000000000000' })]);
  // The AgentCore constructs find their config through the session project root.
  expect(findConfigRoot()).toBe(path.join(root, 'agentcore'));
});

test('reads agentcore.json only from the deploy root', async () => {
  const root = deployRoot();
  fs.rmSync(path.join(root, 'agentcore/agentcore.json'));

  await expect(loadDeployConfig(root, '/')).rejects.toThrow(path.join(root, 'agentcore/agentcore.json'));
});

test('rejects a project without runtimes', async () => {
  const root = deployRoot({ spec: spec => (spec.runtimes = []) });

  await expect(loadDeployConfig(root, '/')).rejects.toThrow(new Error('agentcore.json must configure a runtime'));
});

test.each([
  ['account', (identity: DeployIdentity) => Reflect.deleteProperty(identity.aws, 'account')],
  ['region', (identity: DeployIdentity) => Reflect.deleteProperty(identity.aws, 'region')],
])('rejects an identity.json without an %s', async (_field, edit) => {
  const root = deployRoot({ identity: edit });

  await expect(loadDeployConfig(root, '/')).rejects.toThrow(
    new Error(`Invalid Cartridge deploy identity at ${path.join(root, 'identity.json')}`)
  );
});

test('rejects an identity.json without an aws section', async () => {
  const root = deployRoot({ identity: identity => Reflect.deleteProperty(identity, 'aws') });

  await expect(loadDeployConfig(root, '/')).rejects.toThrow('Invalid Cartridge deploy identity');
});

test('rejects a deploy root with no AWS targets', async () => {
  const root = deployRoot({ targets: [] });

  await expect(loadDeployConfig(root, '/')).rejects.toThrow(
    new Error(`No deployment targets configured in ${path.join(root, 'agentcore/aws-targets.json')}`)
  );
});

test.each([
  ['account', { name: 'other', account: '111111111111', region: 'us-east-1' }],
  ['region', { name: 'other', account: '000000000000', region: 'us-west-2' }],
])('rejects a target whose %s does not match identity.json', async (_field, mismatched) => {
  const root = deployRoot({
    targets: [{ name: 'template', account: '000000000000', region: 'us-east-1' }, mismatched],
  });

  await expect(loadDeployConfig(root, '/')).rejects.toThrow(
    new Error('AWS target other does not match identity.json account and region')
  );
});

test.each([
  [
    'payments',
    (spec: AgentCoreProjectSpec) => (spec.payments = [{ name: 'pay', authorizerType: 'AWS_IAM', connectors: [] }]),
  ],
  ['harnesses', (spec: AgentCoreProjectSpec) => (spec.harnesses = [{ name: 'harness', path: 'harness' }])],
  [
    'agentCoreGateways',
    (spec: AgentCoreProjectSpec) => (spec.agentCoreGateways = [{ name: 'gateway', targets: [] } as never]),
  ],
  [
    'credentials',
    (spec: AgentCoreProjectSpec) => (spec.credentials = [{ authorizerType: 'ApiKeyCredentialProvider', name: 'key' }]),
  ],
  [
    'knowledge-base connectors',
    (spec: AgentCoreProjectSpec) =>
      (spec.knowledgeBases = [
        { type: 'AgentCoreKnowledgeBase', name: 'kb', dataSources: [{ type: 'WEB', connectorConfigFile: 'web.json' }] },
      ]),
  ],
])('rejects an agentcore.json that configures %s, which this app does not deploy', async (feature, edit) => {
  const root = deployRoot({ spec: edit });

  await expect(loadDeployConfig(root, '/')).rejects.toThrow(
    new Error(`agentcore.json configures ${feature}, which this app does not deploy`)
  );
});

test('accepts a knowledge base that reads only from S3', async () => {
  const root = deployRoot({
    spec: spec =>
      (spec.knowledgeBases = [
        { type: 'AgentCoreKnowledgeBase', name: 'kb', dataSources: [{ type: 'S3', uri: 's3://bucket/prefix' }] },
      ]),
  });

  await expect(loadDeployConfig(root, '/')).resolves.toEqual(expect.objectContaining({ deployRoot: root }));
});

test('accepts an agentcore.json that omits the optional features', async () => {
  const root = deployRoot({
    spec: spec => {
      delete spec.payments;
      delete spec.harnesses;
      delete spec.knowledgeBases;
    },
  });

  await expect(loadDeployConfig(root, '/')).resolves.toEqual(expect.objectContaining({ deployRoot: root }));
});

test('loads a project without runtime environment variables', async () => {
  const root = deployRoot({ spec: spec => delete runtimeOf(spec).envVars });

  expect((await loadDeployConfig(root, '/')).spec.runtimes).toHaveLength(1);
});
