#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const deployRoot = process.env.CARTRIDGE_DEPLOY_ROOT;
if (!deployRoot) throw new Error('CARTRIDGE_DEPLOY_ROOT is required');
const identity = JSON.parse(readFileSync(join(deployRoot, 'identity.json'), 'utf8'));
const values = {
  AWS_ACCOUNT_ID: identity.aws.account,
  AGENTCORE_REGION: identity.aws.region,
  AGENTCORE_MEMORY_NAME: identity.aws.agentCore.memory,
  AGENTCORE_RUNTIME_NAME: identity.aws.agentCore.runtime,
  CLOUDFORMATION_STACK_FAMILY: identity.aws.cloudFormation.stackFamily,
  CLOUDWATCH_LOG_GROUP: identity.aws.cloudWatch.logGroup,
  CODEBUILD_PROJECT: identity.aws.codeBuild.project,
  NEXT_PUBLIC_CHAT_SERVICE_URL: identity.domains.chatService,
  CORS_ORIGINS: identity.domains.corsOrigins.join(','),
  ECR_REPOSITORY: identity.aws.ecr.repository,
  GITHUB_DEPLOY_ENVIRONMENT: identity.github.environment,
  IAM_CODEBUILD_ROLE: identity.aws.iam.codeBuildRole,
  IAM_DEPLOY_USER: identity.aws.iam.deployUser,
  IAM_INVOKE_POLICY_FAMILY: identity.aws.iam.invokePolicyFamily,
  IAM_LAMBDA_ROLE: identity.aws.iam.lambdaRole,
  IAM_MEMORY_ROLE: identity.aws.iam.memoryRole,
  IAM_RUNTIME_ROLE: identity.aws.iam.runtimeRole,
  LAMBDA_FAMILY: identity.aws.lambda.family,
  PUBLIC_WEB_URL: identity.domains.web,
  RUNTIME_ARN_SSM_PARAMETER: identity.ssm.runtimeArn,
  TOOL_STAGING_HOOK: identity.artifacts.toolStaging.hook,
};

for (const [name, value] of Object.entries(values)) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\n')) {
    throw new Error(`Invalid deploy identity value for ${name}`);
  }
  process.stdout.write(`${name}=${value}\n`);
}
