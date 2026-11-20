import type { App } from 'aws-cdk-lib';
import * as path from 'path';
import { grantLambdasInline } from './lambda-inline-grants';
import { AgentCoreStack, type AgentCoreStackProps, type AgentCorePhysicalIdentity } from './cdk-stack';
import type { DeployConfig, DeployIdentity } from './deploy-config';
import type { UserMemoryRole } from './user-memory-role';

/**
 * Add one AgentCore stack per deployment target of a loaded Cartridge deploy config, deployed from `commit`, with the
 * Deployment Config's `turnCredentials.kind`.
 */
export function addAgentCoreStacks(
  app: App,
  { deployRoot, identity, spec, targets }: DeployConfig,
  commit: string,
  overrides: Omit<Partial<AgentCoreStackProps>, 'spec' | 'physicalIdentity' | 'env'> = {},
  turnCredentials: 'web-identity' | 'assume-role' = 'web-identity'
): void {
  const physicalIdentity: AgentCorePhysicalIdentity = {
    runtime: identity.aws.agentCore.runtime,
    memory: identity.aws.agentCore.memory,
    sessionApiFunction: identity.aws.agentCore.sessionApiFunction,
    sessionApiAlias: identity.aws.agentCore.sessionApiAlias,
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
  const userMemoryRole = memoryRoleFor(identity, turnCredentials, chatServiceIssuer);
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
        ...(agentCore.rollbackVersion !== undefined ? { rollbackVersion: agentCore.rollbackVersion } : {}),
        harnessCodeLocation: path.resolve(deployRoot, runtime.codeLocation),
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
    grantLambdasInline(stack);
  }
}

function memoryRoleFor(
  identity: DeployIdentity,
  turnCredentials: 'web-identity' | 'assume-role',
  issuer: string
): UserMemoryRole {
  const { userMemoryRole: roleName, chatServiceTaskRole } = identity.aws.iam;
  if (turnCredentials === 'web-identity') return { issuer, roleName };
  if (!chatServiceTaskRole) {
    throw new Error('Deploy identity aws.iam.chatServiceTaskRole: required with turnCredentials assume-role');
  }
  return { turnCredentials, roleName, chatServiceTaskRole };
}
