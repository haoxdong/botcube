import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { deploymentConfigPath, synthesizeExample } from './example-fixture.js';

const AGENTCORE_STACK = 'AgentCore-bot-cube-template';
const BOTCUBE = path.resolve(__dirname, '../../../..');
const STAGED = ['examples/public/deploy/stage-tools.sh', 'examples/bot', 'examples/public/deployment-config.json', 'examples/enterprise/deployment-config.json', 'harness/deepagents/Dockerfile'];

function stagedRuntime(): { root: string; context: string; copies: Map<string, string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-tool-dist-'));
  for (const file of STAGED) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.cpSync(path.join(BOTCUBE, file), path.join(root, file), { recursive: true });
  }
  execFileSync('bash', [path.join(root, 'examples/public/deploy/stage-tools.sh')], { stdio: 'pipe' });
  const context = path.join(root, 'harness/deepagents');
  const copies = new Map(fs.readFileSync(path.join(context, '.tool-dist/Dockerfile'), 'utf8').split('\n')
    .map(line => /^COPY (\.tool-dist\/\S+) (\S+)$/.exec(line))
    .flatMap(match => (match?.[1] && match[2] ? [[match[2], match[1]] as const] : [])));
  return { root, context, copies };
}

test.each(['public', 'enterprise'])('the %s example Runtime names the Deployment Config its image ships', async example => {
  const agentCore = Template.fromStack((await synthesizeExample(example)).node.findChild(AGENTCORE_STACK) as Stack);
  const [runtime] = Object.values(agentCore.findResources('AWS::BedrockAgentCore::Runtime'));
  const [build] = Object.values(agentCore.findResources('AWS::CloudFormation::CustomResource')).filter(({ Properties }) => Properties.DockerfilePath !== undefined);
  const locator = (runtime.Properties.EnvironmentVariables as Record<string, unknown>).BOTCUBE_DEPLOYMENT_CONFIG;

  expect(locator).toBe(`/opt/botcube/examples/${example}/deployment-config.json`);
  expect(build.Properties.DockerfilePath).toBe('.tool-dist/Dockerfile');
  const { root, context, copies } = stagedRuntime();
  try {
    const staged = `.tool-dist/examples/${example}/deployment-config.json`;
    expect(copies.get(locator as string)).toBe(staged);
    expect(fs.readFileSync(path.join(context, staged), 'utf8'))
      .toBe(fs.readFileSync(deploymentConfigPath(example), 'utf8'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
