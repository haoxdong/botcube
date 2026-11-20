#!/usr/bin/env node
// The ECS CDK app cdk.json runs: the active Cartridge's own ECS app when its deploy directory has one, else BotCube's.
// A Cartridge's own app wraps this one (lib/production-app.ts) to add its resources beside BotCube's (ADR 0091).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// CARTRIDGE_DEPLOY_ROOT is the old name, read until every setter moves to BOTCUBE_DEPLOY_ROOT.
const deployRoot = process.env.BOTCUBE_DEPLOY_ROOT || process.env.CARTRIDGE_DEPLOY_ROOT;
if (!deployRoot) throw new Error('BOTCUBE_DEPLOY_ROOT must point to the active deploy directory');
const own = join(resolve(deployRoot), 'ecs/cdk');
const require = createRequire(import.meta.url);
if (existsSync(join(own, 'package.json'))) {
  execFileSync('pnpm', ['--dir', own, 'run', '-s', 'build'], { stdio: 'inherit' });
  require(join(own, 'dist/bin/cdk.js'));
} else {
  require('../dist/bin/cdk.js');
}
