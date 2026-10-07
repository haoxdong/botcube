import { ok as assert } from 'node:assert';
import type { App } from 'aws-cdk-lib';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DEPLOY = path.resolve(PACKAGE_ROOT, '../../../template/deploy');
const mockContextPaths: string[] = [];

// Jest runs the entrypoint from bin/, but deploys run it built into dist/bin/. Record the cdk.json
// path it asks for and read that path as the built entrypoint would.
jest.mock('../lib/cdk-context', () => {
  const actual = jest.requireActual('../lib/cdk-context');
  const { relative, resolve } = jest.requireActual('path');
  const packageRoot = resolve(__dirname, '..');
  return {
    readCdkContext: (configPath: string) => {
      mockContextPaths.push(configPath);
      return actual.readCdkContext(resolve(packageRoot, 'dist/bin', relative(resolve(packageRoot, 'bin'), configPath)));
    },
  };
});

const tempRoots: string[] = [];
const originalDeployRoot = process.env.CARTRIDGE_DEPLOY_ROOT;
const originalOutdir = process.env.CDK_OUTDIR;

afterEach(() => {
  jest.restoreAllMocks();
  mockContextPaths.length = 0;
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalDeployRoot === undefined) delete process.env.CARTRIDGE_DEPLOY_ROOT;
  else process.env.CARTRIDGE_DEPLOY_ROOT = originalDeployRoot;
  if (originalOutdir === undefined) delete process.env.CDK_OUTDIR;
  else process.env.CDK_OUTDIR = originalOutdir;
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcore-entrypoint-')));
  tempRoots.push(dir);
  return dir;
}

/** A repository whose Cartridge deploy root is bot/deploy and whose runtime copies staged tools. */
function repository(): string {
  const repo = tempDir();
  const deployRoot = path.join(repo, 'bot/deploy');
  const identity = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DEPLOY, 'identity.json'), 'utf8'));
  const spec = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DEPLOY, 'agentcore/agentcore.json'), 'utf8'));
  identity.artifacts.toolStaging.hook = 'bot/deploy/stage-tools.sh';
  spec.runtimes[0].codeLocation = '../../harness/';
  fs.mkdirSync(path.join(deployRoot, 'agentcore'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'harness'));
  fs.writeFileSync(path.join(deployRoot, 'identity.json'), JSON.stringify(identity));
  fs.writeFileSync(path.join(deployRoot, 'agentcore/agentcore.json'), JSON.stringify(spec));
  fs.writeFileSync(
    path.join(deployRoot, 'agentcore/aws-targets.json'),
    JSON.stringify([{ name: 'template', account: '000000000000', region: 'us-east-1' }])
  );
  fs.writeFileSync(path.join(deployRoot, 'stage-tools.sh'), '#!/bin/sh\npwd > staged-from\n', { mode: 0o755 });
  fs.writeFileSync(path.join(repo, 'harness/Dockerfile'), 'FROM scratch\nCOPY .tool-dist/ ./\n');
  fs.writeFileSync(path.join(repo, 'harness/session-api.Dockerfile'), 'FROM scratch\n');
  git(repo, 'init', '--quiet');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'repository');
  return repo;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/** The Commit output of the synthesized stack. */
function deployedCommit(outdir: string): string {
  const template = JSON.parse(fs.readFileSync(path.join(outdir, 'AgentCore-bot-cube-template.template.json'), 'utf8'));
  return template.Outputs.Commit.Value;
}

/** Run the entrypoint in this process until it synthesizes the app or exits. */
async function runEntrypoint(): Promise<{ app?: App; exitCode?: number; errors: unknown[][] }> {
  let resolve!: (result: { app?: App; exitCode?: number; errors: unknown[][] }) => void;
  const result = new Promise<{ app?: App; exitCode?: number; errors: unknown[][] }>(done => (resolve = done));
  await jest.isolateModulesAsync(async () => {
    const { App } = await import('aws-cdk-lib');
    const synth = App.prototype.synth;
    jest.spyOn(App.prototype, 'synth').mockImplementation(function (this: App, options) {
      const assembly = synth.call(this, options);
      resolve({ app: this, errors: [] });
      return assembly;
    });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(process, 'exit').mockImplementation(code => {
      resolve({ exitCode: code as number, errors: errors.mock.calls });
      return undefined as never;
    });
    await import('../bin/cdk');
  });
  return result;
}

test('stages tools from the repository root, then synthesizes the stacks with the package cdk.json context', async () => {
  const repo = repository();
  process.env.CARTRIDGE_DEPLOY_ROOT = path.join(repo, 'bot/deploy');
  process.env.CDK_OUTDIR = tempDir();

  const { app, exitCode, errors } = await runEntrypoint();

  expect({ exitCode, errors }).toEqual({ exitCode: undefined, errors: [] });
  expect(fs.readFileSync(path.join(repo, 'staged-from'), 'utf8').trim()).toBe(repo);
  const packageContext = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'cdk.json'), 'utf8')).context;
  expect(mockContextPaths).toHaveLength(1);
  assert(app, 'the entrypoint synthesized its app');
  expect(app.node.tryGetContext('@aws-cdk/core:target-partitions')).toEqual(
    packageContext['@aws-cdk/core:target-partitions']
  );
  expect(deployedCommit(process.env.CDK_OUTDIR)).toBe(git(repo, 'rev-parse', 'HEAD'));
});

test('marks the deployed commit dirty when tracked files differ from it', async () => {
  const repo = repository();
  fs.appendFileSync(path.join(repo, 'harness/session-api.Dockerfile'), '# local edit\n');
  process.env.CARTRIDGE_DEPLOY_ROOT = path.join(repo, 'bot/deploy');
  const outdir = (process.env.CDK_OUTDIR = tempDir());

  const { errors } = await runEntrypoint();

  expect(errors).toEqual([]);
  expect(deployedCommit(outdir)).toBe(`${git(repo, 'rev-parse', 'HEAD')}-dirty`);
});

test('prints why synthesis failed and exits 1', async () => {
  delete process.env.CARTRIDGE_DEPLOY_ROOT;

  const { exitCode, errors } = await runEntrypoint();

  expect(exitCode).toBe(1);
  expect(errors).toEqual([
    ['AgentCore CDK synthesis failed:', 'CARTRIDGE_DEPLOY_ROOT must point to the active Cartridge deploy directory'],
  ]);
});
