import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { IgnoreMode } from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { DockerImageCode } from 'aws-cdk-lib/aws-lambda';

export function sessionApiTimeout(codeLocation: string): number {
  const path = join(codeLocation, 'src/botcube_harness_deepagents/session-api.json');
  return JSON.parse(readFileSync(path, 'utf8')).deadlines.invocation;
}

export function sessionApiCode(codeLocation: string, buildArgs: Record<string, string>) {
  const context = resolve(codeLocation, '../..');
  const harness = relative(context, codeLocation);
  const dockerfile = `${harness}/session-api.Dockerfile`;
  return DockerImageCode.fromImageAsset(context, {
    file: dockerfile,
    buildArgs,
    ignoreMode: IgnoreMode.GIT,
    exclude: [
      '/*',
      '!/config',
      '/config/*',
      '!/config/pyproject.toml',
      '!/config/bot.schema.json',
      '!/config/src',
      '!/credential-source',
      '!/harness',
      '/harness/*',
      `!/${harness}`,
      `/${harness}/*`,
      `!/${dockerfile}`,
      `!/${harness}/pyproject.toml`,
      `!/${harness}/uv.lock`,
      `!/${harness}/src`,
      '**/.venv',
      '**/.pytest_cache',
      '**/__pycache__',
      '**/*.pyc',
    ],
    platform: Platform.LINUX_ARM64,
  });
}
