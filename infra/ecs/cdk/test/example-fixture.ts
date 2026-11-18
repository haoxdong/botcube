import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { IMAGES } from '../../../../deployment-config/footprint.js';
import { defineExample } from '../example/app.js';
import type { DeployIdentity } from '../lib/production-identity.js';
import { caPath, repositoryRoot } from './origin-fixture.js';

export const deploymentConfigPath = (example: string) => path.resolve(__dirname, `../../../../examples/${example}/deployment-config.json`);

/** An example's whole deployment, both CDK apps, synthesizable offline: registry images and fixture origin inputs. */
export async function synthesizeExample(example: string, identity?: (identity: DeployIdentity) => DeployIdentity): Promise<App> {
  return synthesizeExampleAt(deploymentConfigPath(example), identity);
}

/** The deployment the Deployment Config at `configPath` describes, synthesized as an example's is. */
export async function synthesizeExampleAt(configPath: string, adjust: (identity: DeployIdentity) => DeployIdentity = same => same): Promise<App> {
  const app = new App();
  await defineExample(app, configPath, {
    repositoryRoot, commit: 'example',
    identity: identity => adjust({ ...identity, aws: { ...identity.aws, ecs: { ...identity.aws.ecs, originPullCaCertificate: caPath } } }),
    origin: identity => ({
      input: { cloudflareCidrs: ['173.245.48.0/20'], clientVersion: 'version', runtimeArn: `arn:aws:bedrock-agentcore:${identity.aws.region}:${identity.aws.account}:runtime/example` },
      images: { chat: ContainerImage.fromRegistry(IMAGES.chatService), credential: ContainerImage.fromRegistry(IMAGES.credentialService) },
      commit: 'example',
    }),
  });
  return app;
}
