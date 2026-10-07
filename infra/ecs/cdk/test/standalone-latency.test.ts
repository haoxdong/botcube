import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

let root: string;
let savedEnvironment: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-latency-'));
  const archive = execFileSync('git', ['archive', 'HEAD:botcube'], { cwd: path.resolve(__dirname, '../../../../..'), maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', root], { input: archive });
  savedEnvironment = { ...process.env };
  process.env.BOTCUBE_REPOSITORY_ROOT = root;
  process.env.CARTRIDGE_DEPLOY_ROOT = path.join(root, 'template/deploy');
});

afterEach(() => {
  process.env = savedEnvironment;
  fs.rmSync(root, { recursive: true, force: true });
});

function compose(moments?: unknown): App {
  process.env.CDK_CONTEXT_JSON = JSON.stringify({ parked: 'true', ...(moments !== undefined ? { webLatencyMoments: moments } : {}) });
  let app: App | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    app = (require('../bin/cdk') as { app: App }).app;
  });
  if (!app) throw new Error('CDK entrypoint did not return its app');
  return app;
}

test('the unfiltered standalone export synthesizes explicitly supplied latency moments without a budget file', () => {
  expect(fs.existsSync(path.join(root, 'template/latency-budgets.json'))).toBe(false);
  const app = compose(JSON.stringify(['first-response', 'tool-result']));
  app.synth();
  Template.fromStack(app.node.findChild('WebLatency') as Stack).hasResourceProperties('AWS::RUM::AppMonitor', {
    AppMonitorConfiguration: {
      MetricDestinations: [{ Destination: 'CloudWatch', MetricDefinitions: [
        { EventPattern: JSON.stringify({ event_type: ['latency'], event_details: { moment: ['first-response'] } }) },
        { EventPattern: JSON.stringify({ event_type: ['latency'], event_details: { moment: ['tool-result'] } }) },
      ] }],
    },
  });
});

test('the standalone export without explicit moments reports its missing budget file', () => {
  expect(() => compose()).toThrow(/ENOENT.*latency-budgets\.json/);
});

test('malformed JSON latency moments fail loudly', () => {
  expect(() => compose('[')).toThrow(SyntaxError);
});

test.each(['{}', '[]', '[42]', '[""]', '["   "]', ['first-response']])('invalid latency moments %p fail loudly', moments => {
  expect(() => compose(moments)).toThrow('Context webLatencyMoments must be a JSON array of nonempty strings');
});
