// The UI origins every stack grants come from the BotCube Config the Chat Service serves, not the deploy identity.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

let root: string;
let savedEnvironment: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-origins-'));
  fs.mkdirSync(path.join(root, 'product/deploy'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../../../../examples/public/deploy/identity.json'), path.join(root, 'product/deploy/identity.json'));
  savedEnvironment = { ...process.env };
  process.env.BOTCUBE_REPOSITORY_ROOT = root;
  process.env.BOTCUBE_DEPLOY_ROOT = path.join(root, 'product/deploy');
  process.env.CDK_CONTEXT_JSON = JSON.stringify({ parked: 'true' });
});

afterEach(() => {
  process.env = savedEnvironment;
  fs.rmSync(root, { recursive: true, force: true });
});

function webLatencyDomains(): unknown {
  let app: App | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    app = (require('../lib/production-app') as typeof import('../lib/production-app.js')).productionApp();
  });
  if (!app) throw new Error('The production app did not compose');
  const monitors = Template.fromStack(app.node.findChild('WebLatency') as Stack).findResources('AWS::RUM::AppMonitor');
  return Object.values(monitors).map(({ Properties }) => Properties.DomainList);
}

test("a Cartridge with its own chat grants the web origins its BotCube Config names, over https", () => {
  fs.mkdirSync(path.join(root, 'product/chat'));
  fs.writeFileSync(path.join(root, 'product/chat/Dockerfile'), 'FROM scratch\n');
  fs.writeFileSync(path.join(root, 'product/deployment-config.json'), JSON.stringify({
    bot: './bot.json', web: { corsOrigins: ['https://ui.example.com', 'https://dev.ui.example.com', 'http://localhost:3001'] },
  }));
  expect(webLatencyDomains()).toEqual([['ui.example.com', 'dev.ui.example.com']]);
});

test('a BotCube Config without web origins grants none', () => {
  fs.mkdirSync(path.join(root, 'product/chat'));
  fs.writeFileSync(path.join(root, 'product/chat/Dockerfile'), 'FROM scratch\n');
  fs.writeFileSync(path.join(root, 'product/deployment-config.json'), JSON.stringify({ bot: './bot.json' }));
  expect(webLatencyDomains()).toEqual([[]]);
});
