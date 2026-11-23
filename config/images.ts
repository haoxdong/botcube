import { z } from 'zod';
import { ECR_IMAGE, PINNED } from './ecr.cjs';

const registryUrl = z
  .url({ protocol: /^https$/ })
  .refine((url) => {
    const { search, hash, pathname, username, password } = new URL(url);
    return !search && !hash && !username && !password && (pathname === '/' ? !url.endsWith('/') : !pathname.endsWith('/'));
  }, 'Expected a registry base URL, https and a host with an optional path, no trailing /')
  .describe("The registry's base URL, a mirror of Amazon ECR Public's paths, such as https://mirror.example.com/ecr-public.");

/**
 * The one registry (ADR 0091), an Endpoint: every image BotCube pulls comes from it, the services' sidecars and every
 * image BotCube builds FROM. Its credential and TLS are the puller's own, Docker's or the ECS execution role's.
 */
export const imageRegistry = z
  .strictObject({ url: registryUrl })
  .default({ url: 'https://public.ecr.aws' })
  .describe("The registry every image BotCube pulls comes from, an Endpoint whose credential and TLS are the puller's own: the services' sidecars and every image BotCube builds FROM.");

/** The registry as an image reference's prefix, host and path, such as mirror.example.com/ecr-public. */
export function registryHost({ url }: { url: string }): string {
  const { host, pathname } = new URL(url);
  return pathname === '/' ? host : `${host}${pathname}`;
}

const ecrMessage = 'Expected an Amazon ECR image URI, <account>.dkr.ecr.<region>.amazonaws.com/<repository> and a :tag or @sha256 digest';

/**
 * An Amazon ECR image, as CloudFormation Runtime ContainerConfiguration.ContainerUri takes it: an AgentCore Runtime runs
 * only an image in the account's own registry.
 */
export const containerUri = z
  .string()
  .regex(ECR_IMAGE, ecrMessage)
  .describe(
    "As CloudFormation Runtime ContainerConfiguration.ContainerUri: the Bot Image the Runtime runs, built FROM the Harness image and pinned by digest in production. Required when deploying an AgentCore Runtime; build and publish the Bot Image before synthesis.",
  );

/** An OCI image reference, as ECS ContainerDefinition.Image takes it: a registry host, a repository, and a tag or a digest. */
const imageReference = z
  .string()
  .regex(
    new RegExp(`^[a-z0-9-]+(\\.[a-z0-9-]+)+(:\\d+)?(\\/[a-z0-9]+([._-]+[a-z0-9]+)*)+${PINNED}$`),
    'Expected an OCI image reference, <registry host>/<repository> and a :tag or @sha256 digest',
  );

/** The image a service BotCube creates runs, built from the bot's own Dockerfile; absent, BotCube builds it as a CDK asset. */
export const serviceImages = {
  chatService: imageReference.describe(
    "As ECS ContainerDefinition.Image: the Chat Service image, pinned by digest in production. Absent, BotCube builds the bot's own Chat Service, or its stock one.",
  ),
  credentialService: z.string().regex(ECR_IMAGE, ecrMessage).describe(
    "As ECS ContainerDefinition.Image and Lambda Code.ImageUri, so an Amazon ECR image: the Credential Service image, which its audit-copy Lambda also runs, pinned by digest in production. Absent, BotCube builds the bot's own Credential Service, or its stock one.",
  ),
};
