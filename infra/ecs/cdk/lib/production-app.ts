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

/** Where a bot keeps an ECS CDK app of its own, which wraps this one to add its own resources (ADR 0091). */
export const BOT_ECS_APP = 'ecs/cdk';

/**
 * The preview origin's Chat Service image and the BotCube Config it serves (`config`). A bot holding its own Chat
 * Service in `chat/` beside `deploy/` builds that, on the BotCube Config beside them; any other deploy root runs the
 * stock Chat Service, on the public example's BotCube Config its image ships.
 */
export function productionChatImage(repositoryRoot: string, deployRoot: string): { file: string; config: string; deploymentConfig?: string } {
  const own = path.join(deployRoot, '../chat/Dockerfile');
  if (fs.existsSync(own)) return { file: path.relative(repositoryRoot, own), config: path.join(deployRoot, '../deployment-config.json') };
  const botcube = path.resolve(projectDir(__dirname), '../../..');
  return {
    file: path.relative(repositoryRoot, path.join(botcube, 'chat/Dockerfile')),
    config: path.join(botcube, 'examples/public/deployment-config.json'),
    deploymentConfig: '/opt/chat-service/examples/public/deployment-config.json',
  };
}

/** The browser origins, besides its own, the BotCube Config at `configPath` names in `web.corsOrigins`; none without them. */
export function webOrigins(configPath: string): string[] {
  const config: { web?: { corsOrigins: string[] } } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return config.web?.corsOrigins ?? [];
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

/** The production stacks of the active bot, from its deploy identity and this app's context and inputs. */
export function productionApp(product: Pick<ProductionOptions, 'serving' | 'credentials'> = {}): App {
  const app = new App();
  const repositoryRoot = path.resolve(projectDir(__dirname), process.env.BOTCUBE_REPOSITORY_ROOT ?? '../../../..');
  const deployRoot = activeDeployRoot();
  const identity = deployIdentity(deployRoot);
  const chatImage = productionChatImage(repositoryRoot, deployRoot);
  let origin;
  let chat;
  if (app.node.tryGetContext('previewOrigin')) {
    const inputPath = process.env.PREVIEW_ORIGIN_INPUT;
    if (!inputPath) throw new Error('PREVIEW_ORIGIN_INPUT is required');
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
  defineProduction(app, { repositoryRoot, deployRoot, identity, corsOrigins: webOrigins(chatImage.config), origin, ...(chat ? { chat } : {}), ...(webLatency ? { webLatency } : {}), ...product });
  grantLambdasInline(app);
  return app;
}
