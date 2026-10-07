#!/usr/bin/env node
import { addAgentCoreStacks } from '../lib/agentcore-app';
import { loadDeployConfig } from '../lib/deploy-config';
import { stageAgentCoreDockerPrerequisites } from '../lib/predeploy-assets';
import { readCdkContext } from '../lib/cdk-context';
import { App } from 'aws-cdk-lib';
import { execFileSync } from 'child_process';
import * as path from 'path';

// HEAD, marked `-dirty` when tracked files differ from it, so a deploy never claims a commit it did not ship.
function checkoutCommit(repositoryRoot: string): string {
  const git = (...args: string[]) => execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' }).trim();
  return git('rev-parse', 'HEAD') + (git('status', '--porcelain', '--untracked-files=no') ? '-dirty' : '');
}

async function main() {
  const config = await loadDeployConfig(process.env.CARTRIDGE_DEPLOY_ROOT, process.cwd());

  const repositoryRoot = path.resolve(config.deployRoot, '../..');
  const commit = checkoutCommit(repositoryRoot);
  stageAgentCoreDockerPrerequisites(
    config.spec,
    config.deployRoot,
    undefined,
    repositoryRoot,
    config.identity.artifacts.toolStaging.hook
  );

  const app = new App({
    context: readCdkContext(path.resolve(__dirname, '../../cdk.json')),
  });
  addAgentCoreStacks(app, config, commit);
  app.synth();
}

main().catch((error: unknown) => {
  console.error('AgentCore CDK synthesis failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
