import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { activeDeployRoot, deployIdentity, projectDir } from './deploy-root.js';
import { defineProduction, type ProductionOptions } from './production.js';
import { credentialServiceImage } from './credential-audit-copy.js';
import { grantLambdasInline } from './lambda-inline-grants.js';
import { repositoryImageProps } from './repository-image.js';

/** Where a Cartridge keeps an ECS CDK app of its own, which wraps this one to add its own resources (ADR 0091). */
export const CARTRIDGE_ECS_APP = 'ecs/cdk';

/**
 * The preview origin's Chat Service image. A Cartridge holding its own Chat Service in `chat/` beside `deploy/` builds
 * that; any other deploy root runs the stock Chat Service, on the public example's Deployment Config its image ships.
 */
export function productionChatImage(repositoryRoot: string, deployRoot: string): { file: string; deploymentConfig?: string } {
  const own = path.join(deployRoot, '../chat/Dockerfile');
  if (fs.existsSync(own)) return { file: path.relative(repositoryRoot, own) };
  return {
    file: path.relative(repositoryRoot, path.resolve(projectDir(__dirname), '../../../chat/Dockerfile')),
    deploymentConfig: '/opt/chat-service/examples/public/deployment-config.json',
  };
}

/** The preview origin's Credential Service image: the deploy root's own, or else the stock one from `credential-service/`. */
export function productionCredentialImage(repositoryRoot: string, deployRoot: string): string {
  const own = path.join(deployRoot, 'credential-service/Dockerfile');
  return path.relative(repositoryRoot, fs.existsSync(own) ? own : path.resolve(projectDir(__dirname), '../../../credential-service/Dockerfile'));
}

/** HEAD, marked `-dirty` when tracked files differ from it, so a deploy never claims a commit it did not ship. */
function checkoutCommit(root: string): string {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  return git('rev-parse', 'HEAD') + (git('status', '--porcelain', '--untracked-files=no') ? '-dirty' : '');
}

/** The production stacks of the active Cartridge, from its deploy identity and this app's context and inputs. */
export function productionApp(product: Pick<ProductionOptions, 'serving' | 'credentials'> = {}): App {
  const app = new App();
  const repositoryRoot = path.resolve(projectDir(__dirname), process.env.BOTCUBE_REPOSITORY_ROOT ?? '../../../..');
  const deployRoot = activeDeployRoot();
  const identity = deployIdentity(deployRoot);
  let origin;
  let chat;
  if (app.node.tryGetContext('previewOrigin')) {
    const inputPath = process.env.PREVIEW_ORIGIN_INPUT;
    if (!inputPath) throw new Error('PREVIEW_ORIGIN_INPUT is required');
    const chatImage = productionChatImage(repositoryRoot, deployRoot);
    if (chatImage.deploymentConfig) chat = { deploymentConfig: chatImage.deploymentConfig };
    origin = {
      input: JSON.parse(fs.readFileSync(inputPath, 'utf8')),
      images: {
        chat: ContainerImage.fromAsset(repositoryRoot, repositoryImageProps(repositoryRoot, chatImage.file)),
        credential: credentialServiceImage(repositoryRoot, repositoryImageProps(repositoryRoot, productionCredentialImage(repositoryRoot, deployRoot))),
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
  defineProduction(app, { repositoryRoot, deployRoot, identity, origin, ...(chat ? { chat } : {}), ...(webLatency ? { webLatency } : {}), ...product });
  grantLambdasInline(app);
  return app;
}
