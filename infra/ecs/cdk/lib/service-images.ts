import * as path from 'node:path';
import { ecrRepositoryArn } from 'botcube-config/ecr';
import type { readConfig } from 'botcube-config/read';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import type { Construct } from 'constructs';
import { auditCopyImage, credentialServiceImage, type CredentialServiceImage } from './credential-audit-copy.js';
import { projectDir } from './deploy-root.js';
import { repositoryImageProps } from './repository-image.js';

/** The Dockerfiles of a bot's own services, relative to the repository root, which its own ECS app names; absent, BotCube's stock one. */
export interface BotServiceDockerfiles {
  readonly chat?: string;
  readonly credential?: string;
}

const BOTCUBE = path.resolve(projectDir(__dirname), '../../..');

/**
 * The preview origin's Chat Service Dockerfile and the BotCube Config it serves (`config`). A bot's own (`own`) builds on
 * the BotCube Config beside its deploy root, as an image the BotCube Config names (`named`) runs on; the stock Chat
 * Service runs on the public example's, which its image ships.
 */
export function productionChatImage(repositoryRoot: string, deployRoot: string, own?: string, named?: string): { file: string; config: string; botcubeConfig?: string } {
  const file = own ?? path.relative(repositoryRoot, path.join(BOTCUBE, 'chat/Dockerfile'));
  if (own || named) return { file, config: path.join(deployRoot, '../botcube.yaml') };
  return {
    file,
    config: path.join(BOTCUBE, 'examples/public/botcube.yaml'),
    botcubeConfig: '/opt/chat-service/examples/public/botcube.yaml',
  };
}

/** The preview origin's Credential Service Dockerfile: the bot's own (`own`), or else the stock one from `credential-service/`. */
export function productionCredentialImage(repositoryRoot: string, own?: string): string {
  return own ?? path.relative(repositoryRoot, path.join(BOTCUBE, 'credential-service/Dockerfile'));
}

/** An image by its reference, pulled with a grant on its repository when that is in Amazon ECR, as an ECR image's is. */
class NamedImage extends ecs.ContainerImage {
  constructor(private readonly reference: string) { super(); }

  bind(scope: Construct, container: ecs.ContainerDefinition): ecs.ContainerImageConfig {
    const arn = ecrRepositoryArn(this.reference);
    if (arn) ecr.Repository.fromRepositoryArn(scope, 'Repository', arn).grantPull(container.taskDefinition.obtainExecutionRole());
    return { imageName: this.reference };
  }
}

/**
 * The images the preview origin's services run: each one the BotCube Config names (`services.<service>.image`), else a
 * build of its Dockerfile in `dockerfiles`, with the repository root as its context.
 */
export function serviceImages(
  repositoryRoot: string,
  services: ReturnType<typeof readConfig>['services'],
  dockerfiles: { chat: string; credential: string },
): { chat: ecs.ContainerImage; credential: CredentialServiceImage } {
  const chat = services?.chatService?.image;
  const credential = services?.credentialService?.image;
  return {
    chat: chat ? new NamedImage(chat) : ecs.ContainerImage.fromAsset(repositoryRoot, repositoryImageProps(repositoryRoot, dockerfiles.chat)),
    credential: credential
      ? { service: new NamedImage(credential), auditCopy: auditCopyImage(credential) }
      : credentialServiceImage(repositoryRoot, repositoryImageProps(repositoryRoot, dockerfiles.credential)),
  };
}
