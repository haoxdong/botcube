import { Tags, type App } from 'aws-cdk-lib';
import * as path from 'path';
import { grantLambdasInline } from 'botcube-config/lambda-inline-grants';
import { AgentCoreStack, type AgentCoreStackProps, type AgentCorePhysicalIdentity } from './cdk-stack';
import type { DeployConfig, DeployIdentity } from './deploy-config';
import type { UserMemoryRole } from './user-memory-role';

/**
 * The AgentCore resources whose tags agentcore-cdk composes itself, so a resource's own tag wins over a project tag
 * of the same key; its project tags skip them, and so do the BotCube Config's.
 */
const COMPOSED_TAG_TYPES = [
  'AWS::BedrockAgentCore::Runtime',
  'AWS::BedrockAgentCore::Memory',
  'AWS::BedrockAgentCore::Evaluator',
  'AWS::BedrockAgentCore::OnlineEvaluationConfig',
  'AWS::BedrockAgentCore::PolicyEngine',
  'AWS::BedrockAgentCore::Gateway',
  'AWS::BedrockAgentCore::Dataset',
  'AWS::BedrockAgentCore::Harness',
  'AWS::BedrockAgentCore::CapacityProvider',
];

/**
 * Add one AgentCore stack per deployment target of a loaded bot deploy config, deployed from `commit`, with the
 * BotCube Config's `awsAccess.kind` and its `tags` on every stack.
 */
export function addAgentCoreStacks(
  app: App,
  {
    deployRoot,
    botcubeConfigPath,
    identity,
    spec,
    targets,
    runtimeImage,
    existingMemoryKeyArn,
    tags = {},
  }: DeployConfig,
  commit: string,
  overrides: Omit<Partial<AgentCoreStackProps>, 'spec' | 'physicalIdentity' | 'env'> = {},
  awsAccess: 'web-identity' | 'assume-role' = 'web-identity'
): void {
  const physicalIdentity: AgentCorePhysicalIdentity = {
    runtime: identity.aws.agentCore.runtime,
    memory: identity.aws.agentCore.memory,
    sessionApiFunction: identity.aws.agentCore.sessionApiFunction,
    ecrRepository: identity.aws.ecr.repository,
    codeBuildProject: identity.aws.codeBuild.project,
    lambdaFunction: identity.aws.lambda.family,
    roles: {
      runtime: identity.aws.iam.runtimeRole,
      memory: identity.aws.iam.memoryRole,
      lambda: identity.aws.iam.lambdaRole,
      codeBuild: identity.aws.iam.codeBuildRole,
      sessionApi: identity.aws.iam.sessionApiRole,
    },
  };

  const [runtime] = spec.runtimes;
  if (!runtime) throw new Error('The AgentCore spec declares no runtime to deploy');

  const { agentCore } = identity.aws;
  // The Chat Service serves OIDC discovery on the hostname its ALB answers, as BOTCUBE_PUBLIC_ORIGIN.
  const chatServiceIssuer = `https://${new URL(identity.domains.chatService).hostname}`;
  const userMemoryRole = memoryRoleFor(identity, awsAccess, chatServiceIssuer);
  const memoryEncryption = existingMemoryKeyArn ? { existingMemoryKeyArn } : {};
  for (const target of targets) {
    const stack = new AgentCoreStack(
      app,
      `AgentCore-${identity.aws.cloudFormation.stackFamily}-${target.name}`.replace(/_/g, '-'),
      {
        spec,
        physicalIdentity,
        commit,
        chatServiceIssuer,
        userMemoryRole,
        privateNatBrowser: agentCore.privateNatBrowser,
        platformVersion: agentCore.platformVersion,
        ...(agentCore.maxLifetime !== undefined ? { runtimeMaxLifetimeSeconds: agentCore.maxLifetime } : {}),
        ...(agentCore.idleRuntimeSessionTimeout !== undefined
          ? { runtimeIdleTimeoutSeconds: agentCore.idleRuntimeSessionTimeout }
          : {}),
        ...(agentCore.rollbackVersion !== undefined ? { rollbackVersion: agentCore.rollbackVersion } : {}),
        harnessCodeLocation: path.resolve(deployRoot, runtime.codeLocation),
        runtimeImage,
        botcubeConfigPath,
        ...memoryEncryption,
        runtimeNetwork: agentCore.runtimeNetworkParameter
          ? {
              securityGroupParameterName: agentCore.runtimeNetworkParameter,
              subnetIds: agentCore.privateNatBrowser.subnets.map(subnet => subnet.id),
            }
          : undefined,
        ...overrides,
        ...(overrides.vpc ? { runtimeNetwork: undefined } : {}),
        env: { account: target.account, region: target.region },
        description: `AgentCore stack for ${spec.name} deployed to ${target.name} (${target.region})`,
        tags: {
          'agentcore:project-name': spec.name,
          'agentcore:target-name': target.name,
        },
      }
    );
    for (const [key, value] of Object.entries(tags))
      Tags.of(stack).add(key, value, { excludeResourceTypes: COMPOSED_TAG_TYPES });
    grantLambdasInline(stack);
  }
}

function memoryRoleFor(
  identity: DeployIdentity,
  awsAccess: 'web-identity' | 'assume-role',
  issuer: string
): UserMemoryRole {
  const { userMemoryRole: roleName, chatServiceTaskRole } = identity.aws.iam;
  if (awsAccess === 'web-identity') return { issuer, roleName };
  if (!chatServiceTaskRole) {
    throw new Error('Deploy identity aws.iam.chatServiceTaskRole: required with awsAccess assume-role');
  }
  return { awsAccess, roleName, chatServiceTaskRole };
}
