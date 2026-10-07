import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ok as assert } from 'node:assert';
import type { App } from 'aws-cdk-lib';
import { cartridgeDeployRoot } from '../lib/cartridge.js';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const deployRoot = cartridgeDeployRoot();
/** A path the Cartridge holds, relative to the repository root. */
const cartridgeFile = (file: string) => path.relative(repositoryRoot, path.join(deployRoot, file));

/** Runs the entrypoint as `cdk synth -c ...` does, with context and inputs in the environment, from an unrelated directory. */
function entrypoint(context: Record<string, string>, originInput?: object) {
  const saved = { ...process.env };
  const cwd = process.cwd();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ecs-cdk-entrypoint-'));
  // The entrypoint runs from a scratch directory, so the deploy root is absolute.
  process.env.CARTRIDGE_DEPLOY_ROOT = deployRoot;
  process.env.CDK_CONTEXT_JSON = JSON.stringify(context);
  process.env.CDK_OUTDIR = path.join(scratch, 'cdk.out');
  delete process.env.PREVIEW_ORIGIN_INPUT;
  if (originInput) {
    process.env.PREVIEW_ORIGIN_INPUT = path.join(scratch, 'origin-input.json');
    fs.writeFileSync(process.env.PREVIEW_ORIGIN_INPUT, JSON.stringify(originInput));
  }
  process.chdir(scratch);
  try {
    let app: App | undefined;
    // isolateModules is synchronous, so the entrypoint loads with require().
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jest.isolateModules(() => { app = (require('../bin/cdk') as typeof import('../bin/cdk')).app; });
    assert(app, 'the entrypoint exports its app');
    return app.synth();
  } finally {
    process.chdir(cwd);
    process.env = saved;
  }
}

const originInput = {
  cloudflareCidrs: ['173.245.48.0/20'], clientVersion: 'version',
  memoryId: 'test_memory-AbCdEfGhIj',
  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/test-runtime',
};

test('without the previewOrigin flag, the app synthesizes storage, egress, API health and web latency alone', () => {
  const assembly = entrypoint({ parked: 'false' });
  expect(assembly.stacks.map(stack => stack.id).sort()).toEqual(['ApiHealth', 'ChatStorage', 'PrivateEgress', 'WebLatency']);
});

test('the previewOrigin flag requires the prepared origin input', () => {
  expect(() => entrypoint({ parked: 'false', previewOrigin: 'true' })).toThrow('PREVIEW_ORIGIN_INPUT is required');
});

test('each service runs the image built from its own Dockerfile at the repository root', () => {
  const assembly = entrypoint({ parked: 'false', previewOrigin: 'true' }, originInput);
  const origin = assembly.getStackArtifact('PreviewOrigin');
  const manifest = JSON.parse(fs.readFileSync(path.join(assembly.directory, 'PreviewOrigin.assets.json'), 'utf8'));
  const dockerfiles = Object.fromEntries(Object.entries(manifest.dockerImages as Record<string, { source: { dockerFile: string } }>)
    .map(([hash, image]) => [hash, image.source.dockerFile]));
  const containers = Object.values(origin.template.Resources as Record<string, { Type: string; Properties: { ContainerDefinitions: Array<{ Name: string; Image: unknown }> } }>)
    .filter(resource => resource.Type === 'AWS::ECS::TaskDefinition')
    .flatMap(resource => resource.Properties.ContainerDefinitions)
    .map((container: { Name: string; Image: unknown }) => [container.Name, Object.entries(dockerfiles).find(([hash]) => JSON.stringify(container.Image).includes(hash))?.[1]]);
  expect(containers.sort()).toEqual([
    ['chat-service', cartridgeFile('../chat/Dockerfile')],
    ['credential-service', cartridgeFile('credential-service/Dockerfile')],
    ['reaper', cartridgeFile('../chat/Dockerfile')],
  ]);
});
