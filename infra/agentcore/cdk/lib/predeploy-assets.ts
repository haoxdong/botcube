import { IgnoreMode } from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { DockerImageCode } from 'aws-cdk-lib/aws-lambda';

export function sessionApiCode(codeLocation: string, buildArgs: Record<string, string>) {
  return DockerImageCode.fromImageAsset(codeLocation, {
    file: 'session-api.Dockerfile',
    buildArgs,
    ignoreMode: IgnoreMode.DOCKER,
    exclude: [
      '**',
      '!session-api.Dockerfile',
      '!pyproject.toml',
      '!uv.lock',
      '!src/',
      '!src/**',
      '!.tool-dist/',
      '.tool-dist/*',
      '**/__pycache__',
      '**/*.pyc',
    ],
    platform: Platform.LINUX_ARM64,
  });
}
