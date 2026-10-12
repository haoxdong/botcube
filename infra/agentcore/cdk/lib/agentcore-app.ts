import type { App } from 'aws-cdk-lib';
import * as path from 'path';
import { AgentCoreStack, type AgentCoreStackProps, type AgentCorePhysicalIdentity } from './cdk-stack';
import type { DeployConfig } from './deploy-config';

function sanitize(name: string): string {
  return name.replace(/_/g, '-');
}

function toStackName(stackFamily: string, targetName: string): string {
  return `AgentCore-${sanitize(stackFamily)}-${sanitize(targetName)}`;
}

/** Add one AgentCore stack per deployment target of a loaded Cartridge deploy config, deployed from `commit`. */
export function addAgentCoreStacks(
  app: App,
  { deployRoot, identity, spec, targets }: DeployConfig,
  commit: string,
  overrides: Omit<Partial<AgentCoreStackProps>, 'spec' | 'physicalIdentity' | 'env'> = {}
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
  for (const target of targets) {
    new AgentCoreStack(app, toStackName(identity.aws.cloudFormation.stackFamily, target.name), {
      spec,
      physicalIdentity,
      commit,
      // The Chat Service serves OIDC discovery on the hostname its ALB answers, as BOTCUBE_PUBLIC_ORIGIN.
      userMemoryRole: {
        issuer: `https://${new URL(identity.domains.chatService).hostname}`,
        roleName: identity.aws.iam.userMemoryRole,
      },
      privateNatBrowser: agentCore.privateNatBrowser,
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
    });
  }
}
