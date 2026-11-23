import { ok as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, CfnOutput, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { ModuleKind, transpileModule } from 'typescript';
import { findConfigRoot, type AgentCoreProjectSpec } from '@aws/agentcore-cdk';
import { loadDeployConfig } from '../lib/deploy-config';

const botcubeRoot = path.resolve(__dirname, '../../../..');
/** The public example's retired deploy-root files, as they were before its BotCube Config held them. */
const RETIRED = path.join(botcubeRoot, 'tests/fixtures/public-example-deploy-root');
const PUBLIC_EXAMPLE = path.join(botcubeRoot, 'examples/public/deploy');
const tempRoots: string[] = [];

/** The example spec's one runtime. */
function runtimeOf(spec: AgentCoreProjectSpec) {
  const [runtime] = spec.runtimes;
  assert(runtime, 'the example spec declares a runtime');
  return runtime;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A copy of the public example with its BotCube Config edited by `edit`, and its empty deploy root. */
function publicExample(edit: (text: string) => string = text => text): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcore-public-example-'));
  tempRoots.push(root);
  const example = path.dirname(PUBLIC_EXAMPLE);
  fs.writeFileSync(path.join(root, 'botcube.yaml'), edit(fs.readFileSync(path.join(example, 'botcube.yaml'), 'utf8')));
  fs.mkdirSync(path.join(root, 'deploy'));
  return path.join(root, 'deploy');
}

test('requires a deploy root', async () => {
  await expect(loadDeployConfig(undefined, '/')).rejects.toThrow(
    new Error('BOTCUBE_DEPLOY_ROOT must point to the active deploy directory')
  );
});

test('loads the identity, project spec and targets from the BotCube Config beside a deploy root relative to the working directory', async () => {
  const root = publicExample();

  const config = await loadDeployConfig(path.basename(root), path.dirname(root));

  expect(config.deployRoot).toBe(root);
  expect(config.identity.aws.cloudFormation.stackFamily).toBe('bot-cube');
  expect(config.spec.name).toBe('botcube');
  expect(config.targets).toEqual([{ name: 'template', account: '000000000000', region: 'us-east-1' }]);
});

test('gives agentcore-cdk the project it finds on disk', async () => {
  const config = await loadDeployConfig(PUBLIC_EXAMPLE, '/');

  expect(config.identity).not.toHaveProperty('github');
  const configRoot = findConfigRoot();
  assert(configRoot, 'agentcore-cdk finds a project');
  expect(JSON.parse(fs.readFileSync(path.join(configRoot, 'agentcore.json'), 'utf8'))).toEqual(config.spec);
});

test('requires the Bot Image in botcube.yaml instead of building staged sources', async () => {
  const root = publicExample(text => text.replace(/\s+containerUri: \S+/, ''));
  await expect(loadDeployConfig(root, '/')).rejects.toThrow('agentCore.runtime.containerUri');
});

test.each(['identity.json', 'agentcore/agentcore.json', 'agentcore/aws-targets.json'])(
  'fails while the deploy root still holds its retired %s, and loads once it is gone',
  async retired => {
    const root = publicExample();
    fs.mkdirSync(path.join(root, 'agentcore'));
    fs.copyFileSync(path.join(RETIRED, retired), path.join(root, retired));

    await expect(loadDeployConfig(root, '/')).rejects.toThrow(
      `Deploy root ${root}: ${retired} is retired: botcube.yaml beside the deploy root replaces it`
    );
    fs.rmSync(path.join(root, retired));
    await expect(loadDeployConfig(root, '/')).resolves.toEqual(expect.objectContaining({ deployRoot: root }));
  }
);

test('rejects a BotCube Config that names no account and region', async () => {
  const root = publicExample(text => text.replace(/^env: .*$/m, ''));

  await expect(loadDeployConfig(root, '/')).rejects.toThrow(
    `BotCube Config ${path.join(root, '..', 'botcube.yaml')}: env: 'env' is a required property`
  );
});

const HARNESS = path.join(botcubeRoot, 'harness/deepagents');

test("the template names only its project, runtime and memory: BotCube's defaults fill the rest", async () => {
  const config = await loadDeployConfig(PUBLIC_EXAMPLE, '/');

  expect(config.identity.aws.agentCore.sessionApiAlias).toBe('live');
  expect(config.spec).toMatchObject({
    version: 1,
    managedBy: 'CDK',
    tags: { 'agentcore:created-by': 'agentcore-cli' },
  });
  expect(runtimeOf(config.spec)).toMatchObject({
    build: 'Container',
    entrypoint: 'src/botcube_harness_deepagents/serving.py',
    codeLocation: HARNESS,
    runtimeVersion: 'PYTHON_3_13',
    protocol: 'AGUI',
    envVars: expect.arrayContaining([{ name: 'OTEL_PYTHON_DISTRO', value: 'aws_distro' }]),
  });
  expect(fs.existsSync(path.join(HARNESS, 'Dockerfile'))).toBe(true);
  const [memory] = config.spec.memories;
  // Session events last 365 days, the AgentCore maximum; every long-term record files under its actor first (ADR 0033).
  expect(memory?.eventExpiryDuration).toBe(365);
  expect(
    memory?.strategies.map(strategy => [
      strategy.type,
      strategy.namespaceTemplates,
      strategy.reflectionNamespaceTemplates,
    ])
  ).toEqual([
    ['USER_PREFERENCE', ['/actors/{actorId}/preferences/'], undefined],
    ['SEMANTIC', ['/actors/{actorId}/facts/'], undefined],
    ['SUMMARIZATION', ['/actors/{actorId}/summaries/{sessionId}/'], undefined],
    ['EPISODIC', ['/actors/{actorId}/episodes/{sessionId}/'], ['/actors/{actorId}/episodes/']],
  ]);
});

test('SDK metrics stay off while Turn tracing remains enabled', async () => {
  const config = await loadDeployConfig(PUBLIC_EXAMPLE, '/');
  expect(runtimeOf(config.spec).envVars).toEqual(
    expect.arrayContaining([
      { name: 'AGENT_OBSERVABILITY_ENABLED', value: 'true' },
      { name: 'OTEL_PYTHON_DISTRO', value: 'aws_distro' },
      { name: 'OTEL_PYTHON_CONFIGURATOR', value: 'aws_configurator' },
      { name: 'OTEL_TRACES_SAMPLER', value: 'always_on' },
      { name: 'TRACELOOP_TRACE_CONTENT', value: 'false' },
      { name: 'OTEL_METRICS_EXPORTER', value: 'none' },
      { name: 'OTEL_AWS_APPLICATION_SIGNALS_ENABLED', value: 'false' },
    ])
  );
});

test('the default Harness environment carries no dead var or rolled-out flag', async () => {
  const config = await loadDeployConfig(PUBLIC_EXAMPLE, '/');
  const { envVars } = runtimeOf(config.spec);
  assert(envVars, 'the default Harness declares an environment');
  const names = envVars.map(variable => variable.name);
  expect(names).not.toContain('UNIFIED_TRACES_DESTINATION_ENABLED');
  expect(names).not.toContain('BOTCUBE_SNAPSHOT_PRIME');
});

test('synthesizes the Harness asset from a vendored CDK package', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botcube-vendored-cdk-'));
  tempRoots.push(root);
  const original = path.resolve(__dirname, '..');
  const vendored = path.join(root, 'botcube/infra/agentcore/cdk');
  const modulePath = path.join(vendored, 'compiled/lib/deploy-config.js');
  const entrypoint = 'src/botcube_harness_deepagents/serving.py';
  const assetPath = path.join(root, 'botcube/harness/deepagents', entrypoint);
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.copyFileSync(path.join(original, 'package.json'), path.join(vendored, 'package.json'));
  fs.symlinkSync(path.join(original, 'node_modules'), path.join(vendored, 'node_modules'));
  fs.writeFileSync(path.join(root, 'cdk.json'), '{}');
  fs.copyFileSync(path.join(botcubeRoot, 'harness/deepagents', entrypoint), assetPath);
  const source = fs.readFileSync(path.join(original, 'lib/deploy-config.ts'), 'utf8');
  fs.writeFileSync(
    modulePath,
    transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  );

  const config = jest.requireActual<typeof import('../lib/deploy-config')>(modulePath);
  const deploy = await config.loadDeployConfig(PUBLIC_EXAMPLE, root);
  const stack = new Stack(new App(), 'ForeignProject');
  const asset = new Asset(stack, 'Harness', { path: path.join(runtimeOf(deploy.spec).codeLocation, entrypoint) });
  new CfnOutput(stack, 'HarnessAssetKey', { value: asset.s3ObjectKey });
  Template.fromStack(stack).hasOutput('HarnessAssetKey', { Value: Match.stringLikeRegexp('^[a-f0-9]{64}\\.py$') });
});
