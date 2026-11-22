#!/usr/bin/env node
import { deployRootFile } from '../config/read.cjs';

const deployRoot = process.env.BOTCUBE_DEPLOY_ROOT;
if (!deployRoot) throw new Error('BOTCUBE_DEPLOY_ROOT is required');
const identity = deployRootFile(deployRoot, 'identity.json');
const values = {
  AWS_ACCOUNT_ID: identity.aws.account,
  AWS_REGION: identity.aws.region,
  AGENTCORE_MEMORY_NAME: identity.aws.agentCore.memory,
  AGENTCORE_RUNTIME_NAME: identity.aws.agentCore.runtime,
  CLOUDFORMATION_STACK_FAMILY: identity.aws.cloudFormation.stackFamily,
  CLOUDWATCH_LOG_GROUP: identity.aws.cloudWatch.logGroup,
  CODEBUILD_PROJECT: identity.aws.codeBuild.project,
  NEXT_PUBLIC_CHAT_SERVICE_URL: identity.domains.chatService,
  ECR_REPOSITORY: identity.aws.ecr.repository,
  IAM_CODEBUILD_ROLE: identity.aws.iam.codeBuildRole,
  IAM_DEPLOY_USER: identity.aws.iam.deployUser,
  IAM_INVOKE_POLICY_FAMILY: identity.aws.iam.invokePolicyFamily,
  IAM_LAMBDA_ROLE: identity.aws.iam.lambdaRole,
  IAM_MEMORY_ROLE: identity.aws.iam.memoryRole,
  IAM_RUNTIME_ROLE: identity.aws.iam.runtimeRole,
  LAMBDA_FAMILY: identity.aws.lambda.family,
  PUBLIC_WEB_URL: identity.domains.web,
  RUNTIME_ARN_SSM_PARAMETER: identity.ssm.runtimeArn,
};

for (const [name, value] of Object.entries(values)) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\n')) {
    throw new Error(`Invalid deploy identity value for ${name}`);
  }
  process.stdout.write(`${name}=${value}\n`);
}
