import {
  AgentCoreApplication,
  AgentCoreRuntime,
  exportName,
  outputId,
  toPascalId,
  type AgentCoreProjectSpec,
} from '@aws/agentcore-cdk';
import { CfnOutput, Stack } from 'aws-cdk-lib';
import { ecrRepositoryArn } from 'botcube-config/ecr';
import { Construct } from 'constructs';

type RuntimeSpec = AgentCoreProjectSpec['runtimes'][number];

/** A Runtime and the construct it sits under, whichever builds it. */
export interface RuntimeEnvironment {
  readonly node: Construct['node'];
  readonly runtime: AgentCoreRuntime;
}

/**
 * The AgentCore application and each Runtime's environment: `@aws/agentcore-cdk`'s, which builds the image with
 * CodeBuild, or, given the Bot Image the BotCube Config names, a {@link BotImageEnvironment} beside it.
 */
export function runtimeApplication(
  scope: Construct,
  spec: AgentCoreProjectSpec,
  runtimeImage: string | undefined
): [AgentCoreApplication, RuntimeEnvironment[]] {
  if (!runtimeImage) {
    const application = new AgentCoreApplication(scope, 'Application', { spec });
    return [application, [...application.environments.values()]];
  }
  const application = new AgentCoreApplication(scope, 'Application', { spec: { ...spec, runtimes: [] } });
  return [application, spec.runtimes.map(runtime => new BotImageEnvironment(application, spec, runtime, runtimeImage))];
}

/**
 * A Runtime that runs the Bot Image the BotCube Config names, in place of `@aws/agentcore-cdk`'s
 * AgentEnvironment, which always builds its image with CodeBuild: the same construct path, so the Runtime and its
 * role keep their logical IDs, the same environment variables, Memory wiring and outputs, and no build.
 */
export class BotImageEnvironment extends Construct {
  readonly runtime: AgentCoreRuntime;

  constructor(application: AgentCoreApplication, spec: AgentCoreProjectSpec, agent: RuntimeSpec, containerUri: string) {
    super(application, toPascalId('Agent', agent.name));
    if (agent.build !== 'Container') throw new Error(`Runtime ${agent.name}: a named image needs build Container`);
    if (agent.endpoints && Object.keys(agent.endpoints).length > 0)
      throw new Error(`Runtime ${agent.name}: endpoints are not deployed with a named image`);
    const repositoryArn = ecrRepositoryArn(containerUri);
    this.runtime = new AgentCoreRuntime(this, 'Runtime', {
      projectName: spec.name,
      agent,
      containerUri,
      ...(repositoryArn ? { ecrRepositoryArn: repositoryArn } : {}),
      ...(spec.tags ? { projectTags: spec.tags } : {}),
    });
    for (const { name, value } of agent.envVars ?? []) this.runtime.addEnvironmentVariable(name, value);
    this.runtime.wireConnections(agent.connections);
    // As AgentCoreApplication wires every runtime to every memory.
    for (const memory of application.memories.values()) {
      memory.grant(this.runtime);
      this.runtime.addEnvironmentVariable(memory.getEnvVarName(), memory.getEnvVarValue());
    }
    const stackName = Stack.of(this).stackName;
    for (const [part, value, what] of [
      ['RuntimeId', this.runtime.runtimeId, 'Runtime ID'],
      ['RuntimeArn', this.runtime.runtimeArn, 'Runtime ARN'],
      ['RoleArn', this.runtime.roleArn, 'Execution Role ARN'],
    ] as const) {
      new CfnOutput(this, outputId(part), {
        description: `${what} for agent: ${agent.name}`,
        value,
        exportName: exportName(stackName, agent.name, part),
      });
    }
  }
}
