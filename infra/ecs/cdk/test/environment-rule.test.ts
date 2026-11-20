import { ok as assert } from 'node:assert';
import type { App } from 'aws-cdk-lib';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { ContainerDefinition } from 'aws-cdk-lib/aws-ecs';
import { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';
import { environmentViolations, PENDING, processEnvironments, type ProcessEnvironment } from '../lib/environment-rule.js';
import { synthesizeExample } from './example-fixture.js';

function only<T extends IConstruct>(app: App, matches: (construct: IConstruct) => construct is T): T {
  const found = app.node.findAll().filter(matches);
  const match = found.at(0);
  assert(match !== undefined && found.length === 1, `one match, found ${found.length}`);
  return match;
}

const examples: ProcessEnvironment[][] = [];
beforeAll(async () => { examples.push(processEnvironments(await synthesizeExample('public'), 'public')); });
beforeAll(async () => { examples.push(processEnvironments(await synthesizeExample('enterprise'), 'enterprise')); });

test('the public and enterprise examples set only allowed or pending names, and every pending name is still set', () => {
  const environments = examples.flat();
  expect(environments.filter(({ process }) => process.endsWith('/Runtime'))).toHaveLength(2);
  expect(environmentViolations(environments, { pending: PENDING })).toEqual([]);
});

test('a name outside the four uses fails, naming the ECS container, the Lambda and the Runtime that set it', async () => {
  const app = await synthesizeExample('public');
  only(app, (construct): construct is ContainerDefinition => construct instanceof ContainerDefinition && construct.containerName === 'chat-service').addEnvironment('BOTCUBE_SEEDED', '1');
  only(app, (construct): construct is LambdaFunction => construct instanceof LambdaFunction && construct.node.path === 'ProductionParking/Transition').addEnvironment('BOTCUBE_SEEDED', '1');
  const runtime = only(app, (construct): construct is CfnRuntime => construct instanceof CfnRuntime);
  runtime.environmentVariables = { ...(runtime.environmentVariables as Record<string, string>), BOTCUBE_SEEDED: '1' };

  expect(environmentViolations(processEnvironments(app, 'public'), { pending: PENDING }).filter(violation => !violation.startsWith('PENDING'))).toEqual([
    'public/ProductionParking/TransitionD7BFF7BD/Lambda sets BOTCUBE_SEEDED, outside the four uses: read it from the Deployment Config',
    'public/PreviewOrigin/ChatServiceTask5BA326C5/chat-service sets BOTCUBE_SEEDED, outside the four uses: read it from the Deployment Config',
    'public/AgentCore-bot-cube-template/ApplicationAgentBotCubeRuntimeB058A2A5/Runtime sets BOTCUBE_SEEDED, outside the four uses: read it from the Deployment Config',
  ]);
});
