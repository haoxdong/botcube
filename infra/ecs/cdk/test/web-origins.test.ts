import { webOrigins } from '../lib/production-app.js';
// The UI origins every stack grants come from the BotCube Config the Chat Service serves, not the deploy identity.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const BOTCUBE = path.resolve(__dirname, '../../../..');
/** The keys every BotCube Config gives, as YAML a test's own sections follow. */
const REQUIRED_YAML = Object.entries(JSON.parse(fs.readFileSync(path.join(BOTCUBE, 'tests/required-keys.json'), 'utf8')))
  .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join('');

let root: string;
let savedEnvironment: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-origins-'));
  fs.mkdirSync(path.join(root, 'product/deploy'), { recursive: true });
  savedEnvironment = { ...process.env };
  process.env.BOTCUBE_REPOSITORY_ROOT = root;
  process.env.BOTCUBE_DEPLOY_ROOT = path.join(root, 'product/deploy');
  process.env.CDK_CONTEXT_JSON = JSON.stringify({ parked: 'true' });
});

afterEach(() => {
  process.env = savedEnvironment;
  fs.rmSync(root, { recursive: true, force: true });
});

const PUBLIC_EXAMPLE = fs.readFileSync(path.resolve(__dirname, '../../../../examples/public/botcube.yaml'), 'utf8');

/** The public example's BotCube Config, its web origins replaced by `domains`, as the product's. */
function productConfig(domains: string): void {
  fs.writeFileSync(path.join(root, 'product/botcube.yaml'), PUBLIC_EXAMPLE.replace(/^ {2}web: .*\n {2}webAliases: .*$/m, domains));
}

/** The web latency monitor's domains, for a bot whose ECS app names its own chat Dockerfile. */
function webLatencyDomains(): unknown {
  let app: App | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    app = (require('../lib/production-app') as typeof import('../lib/production-app.js')).productionApp({ images: { chat: 'product/chat/Dockerfile' } });
  });
  if (!app) throw new Error('The production app did not compose');
  const monitors = Template.fromStack(app.node.findChild('WebLatency') as Stack).findResources('AWS::RUM::AppMonitor');
  return Object.values(monitors).map(({ Properties }) => Properties.DomainList);
}

test("a bot with its own chat grants the web origins its BotCube Config names, over https", () => {
  fs.mkdirSync(path.join(root, 'product/chat'));
  fs.writeFileSync(path.join(root, 'product/chat/Dockerfile'), 'FROM scratch\n');
  productConfig('  web: https://ui.example.com\n  webAliases: [https://dev.ui.example.com, http://localhost:3001]');
  expect(webLatencyDomains()).toEqual([['ui.example.com', 'dev.ui.example.com']]);
});

test('a BotCube Config whose web origins are all http grants none', () => {
  fs.mkdirSync(path.join(root, 'product/chat'));
  fs.writeFileSync(path.join(root, 'product/chat/Dockerfile'), 'FROM scratch\n');
  productConfig('  web: http://localhost:3001');
  expect(webLatencyDomains()).toEqual([[]]);
});


test.each([
  ['web: { corsOrigins: [https://old.example.com] }', 'web: renamed to domains.web and domains.webAliases'],
  ['network: { corsOrigins: [https://old.example.com] }', 'network.corsOrigins: renamed to domains.web and domains.webAliases'],
  ['network: { typo: true }', 'network.typo:'],
])('the CDK rejects invalid config %s', (text, message) => {
  const config = path.join(root, 'product/botcube.yaml');
  fs.writeFileSync(config, `${REQUIRED_YAML}${text}`);
  expect(() => webOrigins(config)).toThrow(message);
});
