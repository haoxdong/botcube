#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { cartridgeDeployRoot } from '../lib/cartridge.js';
import { repositoryImageProps } from '../lib/repository-image.js';
import { defineProduction, parkedContext } from '../lib/production.js';

export const app = new App();
// This project's directory holds cdk.json, whether the app runs from source or from dist/.
const projectDir = (dir: string): string => (fs.existsSync(path.join(dir, 'cdk.json')) ? dir : projectDir(path.dirname(dir)));
const repositoryRoot = path.resolve(projectDir(__dirname), process.env.BOTCUBE_REPOSITORY_ROOT ?? '../../../..');
const deployRoot = cartridgeDeployRoot();
const identity = JSON.parse(fs.readFileSync(path.join(deployRoot, 'identity.json'), 'utf8'));
// A Cartridge holds its Chat Service half in `chat/` beside `deploy/`.
const cartridgeFile = (file: string) => path.relative(repositoryRoot, path.join(deployRoot, file));
// HEAD, marked `-dirty` when tracked files differ from it, so a deploy never claims a commit it did not ship.
function checkoutCommit(root: string): string {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  return git('rev-parse', 'HEAD') + (git('status', '--porcelain', '--untracked-files=no') ? '-dirty' : '');
}
let origin;
if (app.node.tryGetContext('previewOrigin')) {
  const inputPath = process.env.PREVIEW_ORIGIN_INPUT;
  if (!inputPath) throw new Error('PREVIEW_ORIGIN_INPUT is required');
  origin = {
    input: JSON.parse(fs.readFileSync(inputPath, 'utf8')),
    images: {
      chat: ContainerImage.fromAsset(repositoryRoot, repositoryImageProps(repositoryRoot, cartridgeFile('../chat/Dockerfile'))),
      credential: ContainerImage.fromAsset(repositoryRoot, repositoryImageProps(repositoryRoot, cartridgeFile('credential-service/Dockerfile'))),
    },
    commit: checkoutCommit(repositoryRoot),
  };
}
const momentsContext = app.node.tryGetContext('webLatencyMoments');
let webLatency;
if (momentsContext !== undefined) {
  if (typeof momentsContext !== 'string') throw new Error('Context webLatencyMoments must be a JSON array of nonempty strings');
  const moments: unknown = JSON.parse(momentsContext);
  if (!Array.isArray(moments) || moments.length === 0 || moments.some(moment => typeof moment !== 'string' || moment.trim().length === 0)) {
    throw new Error('Context webLatencyMoments must be a JSON array of nonempty strings');
  }
  webLatency = { moments };
}
defineProduction(app, { repositoryRoot, deployRoot, identity, parked: parkedContext(app.node.tryGetContext('parked')), origin, ...(webLatency ? { webLatency } : {}) });
