#!/usr/bin/env node
import { readDeployment, deploymentNames } from '../config/read.cjs';

const deployRoot = process.env.BOTCUBE_DEPLOY_ROOT;
if (!deployRoot) throw new Error('BOTCUBE_DEPLOY_ROOT is required');
const config = readDeployment(deployRoot);
const names = deploymentNames(config);
const values = {
  AWS_ACCOUNT_ID: config.env.account,
  AWS_REGION: config.env.region,
  AGENTCORE_MEMORY_NAME: names.memoryName,
  AGENTCORE_RUNTIME_NAME: names.runtimeAgentRuntimeName,
  CLOUDFORMATION_STACK_FAMILY: config.name,
  CLOUDWATCH_LOG_GROUP: names.buildLogGroupName,
  CODEBUILD_PROJECT: names.buildProjectName,
  NEXT_PUBLIC_CHAT_SERVICE_URL: config.domains.chatService,
  ECR_REPOSITORY: names.repositoryName,
  IAM_CODEBUILD_ROLE: names.buildRoleName,
  IAM_DEPLOY_USER: names.deployUserName,
  IAM_INVOKE_POLICY_FAMILY: names.invokePolicyNamePrefix,
  IAM_LAMBDA_ROLE: names.buildFunctionRoleName,
  IAM_MEMORY_ROLE: names.memoryRoleName,
  IAM_RUNTIME_ROLE: names.runtimeRoleName,
  LAMBDA_FAMILY: names.buildFunctionName,
  PUBLIC_WEB_URL: config.domains.web,
  RUNTIME_ARN_SSM_PARAMETER: `/${config.name}/agentcore/runtime-arn`,
};

for (const [name, value] of Object.entries(values)) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\n')) {
    throw new Error(`Invalid deploy identity value for ${name}`);
  }
  process.stdout.write(`${name}=${value}\n`);
}
