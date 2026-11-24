import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { readConfig } from '../../../../config/read.cjs';
import { IMAGES } from '../../../../config/footprint-images.js';
import { defineExample } from '../example/app.js';
import type { DeployIdentity } from '../lib/production-identity.js';
import { registryCredentialImage } from './credential-image.js';
import { caCertificate, repositoryRoot } from './origin-fixture.js';

export const botcubeConfigPath = (example: string) => path.resolve(__dirname, `../../../../examples/${example}/botcube.yaml`);

/** The example repository's metrics workflow on main, as the release tooling that deploys an example names it. */
const EXAMPLE_METRICS_READER_SUBJECT = 'repo:example-owner@000000000/example-repository@000000000:ref:refs/heads/main';

/** An example's whole deployment, both CDK apps, synthesizable offline: registry images and fixture origin inputs. */
export async function synthesizeExample(example: string, identity?: (identity: DeployIdentity) => DeployIdentity, context?: Record<string, string>): Promise<App> {
  return synthesizeExampleAt(botcubeConfigPath(example), identity, context);
}

/** The deployment the BotCube Config at `configPath` describes, synthesized as an example's is, under the CDK `context` given. */
export async function synthesizeExampleAt(configPath: string, adjust: (identity: DeployIdentity) => DeployIdentity = same => same, context: Record<string, string> = {}): Promise<App> {
  const app = new App({ context });
  const { services } = readConfig(configPath);
  await defineExample(app, configPath, {
    repositoryRoot, commit: 'example', webLatency: { readerSubject: EXAMPLE_METRICS_READER_SUBJECT },
    identity: identity => adjust({ ...identity, aws: { ...identity.aws, ecs: { ...identity.aws.ecs, originPullCaCertificate: caCertificate } } }),
    origin: identity => ({
      input: { cloudflareCidrs: ['173.245.48.0/20'], clientVersion: 'version', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/example` },
      images: {
        chat: ContainerImage.fromRegistry(services?.chatService?.image ?? IMAGES.chatService),
        credential: registryCredentialImage(services?.credentialService?.image ?? IMAGES.credentialService),
      },
      commit: 'example',
    }),
  });
  return app;
}
