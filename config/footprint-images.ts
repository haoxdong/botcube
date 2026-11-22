import { registryHost } from './images.js';
import type { BotCubeConfig } from './schema.js';

/** The images BotCube deploys; a bot's own image is built FROM the Harness image and stands in for it. */
export const IMAGES = {
  chatService: 'botcube-chat-service',
  credentialService: 'botcube-credential-service',
  bot: 'bot (FROM the BotCube Harness image)',
} as const;

/** The images BotCube pulls, by their path in the image registry: its sidecars, then what its own images are built FROM. */
const PULLED = {
  build: ['docker/library/nginx:stable-alpine', 'docker/library/node:24-bookworm-slim', 'docker/library/python:3.13-slim', 'docker/library/rust:1.88-slim-bookworm',
    'lambda/python:3.13', 'sam/build-python3.12'],
};

/** Each distinct value once, in order. */
export const sorted = (values: readonly string[]) => [...new Set(values)].sort();

/**
 * The images the deployment runs, each one the BotCube Config names in place of the one BotCube would build, and the
 * sidecars it pulls (`sidecars`, by path in the image registry); then the images BotCube builds its own FROM.
 */
export function footprintImages(config: BotCubeConfig, sidecars: readonly string[]): { images: string[]; buildImages: string[] } {
  const { integrations, services, agentCore } = config;
  const pulled = (paths: readonly string[]) => paths.map(image => `${registryHost(integrations.imageRegistry)}/${image}`);
  const named = {
    chatService: services?.chatService?.image,
    credentialService: services?.credentialService?.image,
    bot: agentCore?.runtime?.containerUri,
  };
  const deployed = (Object.keys(IMAGES) as (keyof typeof IMAGES)[]).map(image => named[image] ?? IMAGES[image]);
  return { images: sorted([...deployed, ...pulled(sidecars)]), buildImages: sorted(pulled(PULLED.build)) };
}
