import { readConfig, webOrigins as configWebOrigins } from 'botcube-config/read';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { activeDeployRoot, deployIdentity, deployRootConfig, projectDir } from './deploy-root.js';
import { defineProduction, type ProductionOptions } from './production.js';
import { grantLambdasInline } from './lambda-inline-grants.js';
import { productionChatImage, productionCredentialImage, serviceImages, type BotServiceDockerfiles } from './service-images.js';

/** Where a bot keeps an ECS CDK app of its own, which wraps this one to add its own resources (ADR 0091). */
export const BOT_ECS_APP = 'ecs/cdk';

/** The browser origins, besides its own, the BotCube Config at `configPath` names: `domains.web` and its aliases; none without them. */
export function webOrigins(configPath: string): string[] {
  return configWebOrigins(readConfig(configPath)) ?? [];
}

/** HEAD, marked `-dirty` when tracked files differ from it, so a deploy never claims a commit it did not ship. */
function checkoutCommit(root: string): string {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  return git('rev-parse', 'HEAD') + (git('status', '--porcelain', '--untracked-files=no') ? '-dirty' : '');
}

/** What a bot's own ECS app adds to BotCube's production stacks. */
export type ProductOptions = Pick<ProductionOptions, 'serving' | 'credentials' | 'webLatency'> & {
  /** Its own services' Dockerfiles, which build when its BotCube Config names no image for them. */
  images?: BotServiceDockerfiles;
};

/**
 * The production stacks of the active bot, from its deploy identity and this app's context and inputs, with what the
 * bot's own ECS app adds (`product`): its resources, its own services' Dockerfiles, and its release tooling's metrics reader.
 */
export function productionApp({ images: dockerfiles = {}, ...product }: ProductOptions = {}): App {
  const app = new App();
  const repositoryRoot = path.resolve(projectDir(__dirname), process.env.BOTCUBE_REPOSITORY_ROOT ?? '../../../..');
  const deployRoot = activeDeployRoot();
  const identity = deployIdentity(deployRoot, repositoryRoot);
  const config = deployRootConfig(deployRoot);
  const botcubeConfig = readConfig(config.path);
  const { services, tags } = botcubeConfig;
  const chatImage = productionChatImage(repositoryRoot, deployRoot, dockerfiles.chat, services?.chatService?.image);
  const corsOrigins = configWebOrigins(chatImage.config === config.path ? botcubeConfig : readConfig(chatImage.config)) ?? [];
  let origin;
  let chat;
  if (app.node.tryGetContext('previewOrigin')) {
    const inputPath = process.env.PREVIEW_ORIGIN_INPUT;
    if (!inputPath) throw new Error('PREVIEW_ORIGIN_INPUT is required');
    if (chatImage.botcubeConfig) chat = { botcubeConfig: chatImage.botcubeConfig };
    origin = {
      input: JSON.parse(fs.readFileSync(inputPath, 'utf8')),
      images: serviceImages(repositoryRoot, services, {
        chat: chatImage.file, credential: productionCredentialImage(repositoryRoot, dockerfiles.credential),
      }),
      commit: checkoutCommit(repositoryRoot),
    };
  }
  const momentsContext = app.node.tryGetContext('webLatencyMoments');
  let webLatency = product.webLatency;
  if (momentsContext !== undefined) {
    if (typeof momentsContext !== 'string') throw new Error('Context webLatencyMoments must be a JSON array of nonempty strings');
    const moments: unknown = JSON.parse(momentsContext);
    if (!Array.isArray(moments) || moments.length === 0 || moments.some(moment => typeof moment !== 'string' || moment.trim().length === 0)) {
      throw new Error('Context webLatencyMoments must be a JSON array of nonempty strings');
    }
    webLatency = { ...webLatency, moments };
  }
  defineProduction(app, { repositoryRoot, deployRoot, identity, config, corsOrigins, origin, ...(tags ? { tags } : {}), ...(chat ? { chat } : {}), ...product, ...(webLatency ? { webLatency } : {}) });
  grantLambdasInline(app);
  return app;
}
