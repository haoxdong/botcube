import * as fs from 'node:fs';
import * as path from 'node:path';
import { IgnoreMode } from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import type { AssetImageProps } from 'aws-cdk-lib/aws-ecs';

// The context is the repository root, so admit only the Dockerfile's own COPY sources
// (tests excluded): any other file would change the asset hash and roll the service for nothing.
// A Dockerfile that declares REGISTRY pulls every FROM image through `imageRegistry`, or its own default without one.
export function repositoryImageProps(repositoryRoot: string, file: string, imageRegistry?: string): AssetImageProps {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
  const buildArgs = {
    ...(dockerfile.includes('ARG BOTCUBE_ROOT=') ? { BOTCUBE_ROOT: fs.existsSync(path.join(repositoryRoot, 'botcube')) ? 'botcube' : '.' } : {}),
    ...(imageRegistry && dockerfile.includes('ARG REGISTRY=') ? { REGISTRY: imageRegistry } : {}),
  };
  const sources = dockerfile.split('\n')
    .filter(line => /^COPY\s/.test(line) && !line.includes('--from='))
    .flatMap(line => line.trim().split(/\s+/).slice(1, -1))
    .map(source => source.replace('${BOTCUBE_ROOT}', buildArgs.BOTCUBE_ROOT ?? '').replace(/^\.\//, ''));
  return {
    file, platform: Platform.LINUX_AMD64, ignoreMode: IgnoreMode.DOCKER,
    ...(Object.keys(buildArgs).length ? { buildArgs } : {}),
    exclude: ['*', ...[file, ...sources].map(source => `!${source.replace(/\/$/, '')}`), '**/*.test.ts'],
  };
}
