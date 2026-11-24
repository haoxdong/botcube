import { configBucketName } from './config-bucket.cjs';
import { deploymentNames } from './names.cjs';
import type { Principal } from './principals.js';
import type { BotCubeConfig } from './schema.js';

export function configStores(config: BotCubeConfig) {
  const { account, region } = config.env;
  const names = deploymentNames(config);
  const runtimeStack = `AgentCore-${config.name}-${names.agentCoreTargetName}`.replace(/_/g, '-');
  const stores = [
    { bucket: configBucketName(account, region, names.previewOriginStackName), readers: ['chatService', 'credentialService'] },
    { bucket: configBucketName(account, region, runtimeStack), readers: ['harness'] },
  ] satisfies { bucket: string; readers: Principal[] }[];
  const egressFrom = Object.fromEntries(stores.map(({ bucket, readers }) => [`${bucket}.s3.${region}.amazonaws.com`, readers]));
  return {
    need: {
      egressHosts: Object.keys(egressFrom),
      egressFrom,
      iam: Object.fromEntries(stores.flatMap(({ readers }) => readers.map(reader => [reader, { actions: ['s3:GetObject'] }]))),
    },
    created: stores.map(({ bucket, readers }) => `Resolved BotCube Config: s3:GetObject on s3://${bucket}/resolved/* (${readers.join(', ')})`),
  };
}
