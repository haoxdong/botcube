import { ok as assert } from 'node:assert';
import type { App } from 'aws-cdk-lib';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { ContainerDefinition } from 'aws-cdk-lib/aws-ecs';
import { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';
import { environmentViolations, processEnvironments, type ProcessEnvironment } from '../lib/environment-rule.js';
import type { DeployIdentity } from '../lib/production-identity.js';
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
/** The public example with a raw service origin, so the product's service gets the `rawHostname` neither example sets. */
const rawService = (identity: DeployIdentity): DeployIdentity => ({
  ...identity,
  domains: { ...identity.domains, rawServiceOrigins: ['https://raw.example.com'] },
  aws: { ...identity.aws, ecs: { ...identity.aws.ecs, credentialService: {
    ...identity.aws.ecs.credentialService, publicHostname: 'service.example.com', publicPaths: ['/me/sign-ins'],
  } } },
});
beforeAll(async () => { examples.push(processEnvironments(await synthesizeExample('public', rawService), 'raw-service')); });

test('the public and enterprise examples, and public with a raw service origin, set only allowed names', () => {
  const environments = examples.flat();
  expect(environments.filter(({ process }) => process.endsWith('/Runtime'))).toHaveLength(3);
  expect(environmentViolations(environments)).toEqual([]);
});

test("a raw service origin gives the product's service its host, and its RPC path only through the BotCube Config", () => {
  const raw = examples.flat().filter(({ process }) => process.startsWith('raw-service/'));
  const service = raw.find(({ process }) => process.endsWith('/credential-service'));
  expect(service?.names).toContain('BOTCUBE_RAW_SERVICE_HOST');
  expect(service?.names).not.toContain('BOTCUBE_RAW_SERVICE_RPC_PATH');
});

/** One process of each kind in the public example, and how a test sets a name on it. */
const KINDS: [string, string, (app: App, name: string) => void][] = [
  ['an ECS task', 'public/PreviewOrigin/ChatServiceTask5BA326C5/chat-service', (app, name) => {
    only(app, (construct): construct is ContainerDefinition => construct instanceof ContainerDefinition && construct.containerName === 'chat-service').addEnvironment(name, '1');
  }],
  ['a Lambda', 'public/ProductionParking/TransitionD7BFF7BD/Lambda', (app, name) => {
    only(app, (construct): construct is LambdaFunction => construct instanceof LambdaFunction && construct.node.path === 'ProductionParking/Transition').addEnvironment(name, '1');
  }],
  ['a Harness runtime', 'public/AgentCore-bot-cube-template/ApplicationAgentBotCubeRuntimeB058A2A5/Runtime', (app, name) => {
    const runtime = only(app, (construct): construct is CfnRuntime => construct instanceof CfnRuntime);
    runtime.environmentVariables = { ...(runtime.environmentVariables as Record<string, string>), [name]: '1' };
  }],
];

test.each(KINDS)('a name outside the four uses on %s fails the rule, and passes once removed', async (_kind, process, setName) => {
  const seeded = await synthesizeExample('public');
  setName(seeded, 'BOTCUBE_SEEDED');
  expect(environmentViolations(processEnvironments(seeded, 'public'))).toEqual([
    `${process} sets BOTCUBE_SEEDED, outside the four uses: read it from the BotCube Config`,
  ]);

  expect(environmentViolations(processEnvironments(await synthesizeExample('public'), 'public'))).toEqual([]);
});
