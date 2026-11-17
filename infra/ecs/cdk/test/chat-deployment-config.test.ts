// The deployed Chat Service reads the Deployment Config its infrastructure was built from (ADR 0091): each example's
// chat container names, in BOTCUBE_DEPLOYMENT_CONFIG, the copy its image ships, beside the bot settings it names.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { synthesizeExample, synthesizeExampleAt } from './example-fixture.js';

interface Container { Name: string; Environment?: { Name: string; Value: unknown }[] }

const DOCKERFILE = fs.readFileSync(path.resolve(__dirname, '../../../../templates/always-on/chat/Dockerfile'), 'utf8').split('\n');

function chatEnvironment(app: App): Record<string, unknown> {
  const origin = app.node.findChild('PreviewOrigin') as Stack;
  const container = Object.values(Template.fromStack(origin).findResources('AWS::ECS::TaskDefinition'))
    .flatMap(({ Properties }) => Properties.ContainerDefinitions as Container[])
    .find(({ Name }) => Name === 'chat-service');
  if (container === undefined) throw new Error('The preview origin has no chat-service container');
  return Object.fromEntries((container.Environment ?? []).map(({ Name, Value }) => [Name, Value]));
}

test.each(['public', 'enterprise'])('the %s example names the Deployment Config its chat image ships', async example => {
  const app = await synthesizeExample(example);
  expect(chatEnvironment(app).BOTCUBE_DEPLOYMENT_CONFIG).toBe(`/opt/chat-service/examples/${example}/deployment-config.json`);
  // The build stage gathers the config and its `../bot/bot.json`; the runtime stage ships them under its WORKDIR.
  expect(DOCKERFILE).toEqual(expect.arrayContaining([
    `COPY \${BOTCUBE_ROOT}/examples/${example}/deployment-config.json examples/${example}/deployment-config.json`,
    'COPY ${BOTCUBE_ROOT}/examples/bot/bot.json examples/bot/bot.json',
    'WORKDIR /opt/chat-service',
    'COPY --from=build /workspace/botcube/examples/ examples/',
  ]));
}, 180_000);

test('a Deployment Config the chat image does not ship fails before any stack', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-examples-'));
  try {
    const config = path.join(root, 'deployment-config.json');
    fs.copyFileSync(path.resolve(__dirname, '../../../../examples/bot/bot.json'), path.join(root, 'bot.json'));
    fs.writeFileSync(config, JSON.stringify({ bot: './bot.json' }));
    await expect(synthesizeExampleAt(config)).rejects.toThrow(`Deployment Config ${config}: the chat image ships only`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
