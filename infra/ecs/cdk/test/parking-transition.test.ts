import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { deployIdentity } from '../lib/deploy-root.js';
import { deployedStacks, parkingTransition } from '../lib/parking-transition.js';

const identity = deployIdentity(path.resolve(__dirname, '../../../../examples/public/deploy'));

test('bundles the transition when cdk.out sits inside ecs/cdk, as in the deploy workflow', () => {
  const infraRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transition-infra-'));
  try {
    for (const file of ['ecs/parking_transition.py', 'ecs/verify/live.py', 'ecs/parking/dispatcher.mjs', 'ecs/cdk/lib/stack.ts', 'ecs/verify/__pycache__/live.pyc']) {
      fs.mkdirSync(path.dirname(path.join(infraRoot, file)), { recursive: true });
      fs.writeFileSync(path.join(infraRoot, file), '');
    }
    fs.writeFileSync(path.join(infraRoot, 'identity-defaults.json'), '{}');
    fs.copyFileSync(path.resolve(__dirname, '../../../transition-requirements.txt'), path.join(infraRoot, 'transition-requirements.txt'));
    const app = new App({ outdir: path.join(infraRoot, 'ecs/cdk/cdk.out') });
    const stack = new Stack(app, 'Parking', { env: { account: identity.aws.account, region: identity.aws.region } });
    parkingTransition(stack, infraRoot, identity);
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([{
      Action: ['ssm:GetParameter', 'ssm:PutParameter'], Effect: 'Allow', Resource: stack.resolve([
        stack.formatArn({ service: 'ssm', resource: `parameter${identity.ssm.parkState}` }),
        stack.formatArn({ service: 'ssm', resource: `parameter${identity.ssm.parkState}/backstop` }),
      ]),
    }]) } });
    const outdir = app.synth().directory;
    const asset = fs.readdirSync(outdir).find(name => fs.existsSync(path.join(outdir, name, 'ecs')));
    if (!asset) throw new Error(`No transition asset in ${outdir}`);
    const bundled = (relative: string) => fs.existsSync(path.join(outdir, asset, relative));
    expect([bundled('ecs/parking_transition.py'), bundled('ecs/verify/live.py'), bundled('cartridge/identity.json'), bundled('identity-defaults.json')]).toEqual([true, true, true, true]);
    expect([bundled('ecs/cdk'), bundled('ecs/parking'), bundled('ecs/verify/__pycache__')]).toEqual([false, false, false]);
    // The Lambda imports this botocore, not the runtime's older built-in one that dropped platformVersion.
    const locked = fs.readFileSync(path.resolve(__dirname, '../../../transition-requirements.txt'), 'utf8').match(/^botocore==(\S+)/m)?.[1];
    expect(fs.readFileSync(path.join(outdir, asset, 'botocore/__init__.py'), 'utf8')).toContain(`__version__ = '${locked}'`);
    expect([bundled('boto3/__init__.py'), bundled('bin')]).toEqual([true, false]);
  } finally {
    fs.rmSync(infraRoot, { recursive: true, force: true });
  }
});

test('lets the transition register the Session API scalable target', () => {
  // RegisterScalableTarget fails with a ValidationException unless the caller holds these (run 9e9ac581 on 2026-11-12).
  const stack = new Stack(new App(), 'Scaling', { env: { account: identity.aws.account, region: identity.aws.region } });
  parkingTransition(stack, path.resolve(__dirname, '../../..'), identity);
  const actions = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy'))
    .flatMap(policy => (policy as { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } }).Properties.PolicyDocument.Statement)
    .flatMap(statement => [statement.Action].flat());
  expect(actions).toEqual(expect.arrayContaining(['lambda:GetProvisionedConcurrencyConfig', 'cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'application-autoscaling:RegisterScalableTarget']));
});

test('lets the transition read only deploy leases and the deployed stacks it guards a park with', () => {
  const stack = new Stack(new App(), 'Guard', { env: { account: identity.aws.account, region: identity.aws.region } });
  parkingTransition(stack, path.resolve(__dirname, '../../..'), identity);
  const statements = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy'))
    .flatMap(policy => (policy as { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown; Condition?: unknown }[] } } }).Properties.PolicyDocument.Statement)
    .map(statement => stack.resolve(statement) as { Action: string | string[]; Resource: unknown; Condition?: unknown });
  const bucket = identity.aws.ecs.parking.slotBucket;
  expect(statements.filter(statement => [statement.Action].flat().some(action => action.startsWith('s3:')))).toEqual([
    { Action: 's3:ListBucket', Effect: 'Allow', Resource: `arn:aws:s3:::${bucket}`, Condition: { StringLike: { 's3:prefix': 'deploy-leases/*' } } },
    { Action: 's3:GetObject', Effect: 'Allow', Resource: `arn:aws:s3:::${bucket}/deploy-leases/*` },
  ]);
  expect(deployedStacks(identity)).toEqual(['AgentCore-bot-cube-default', 'bot-cube-preview-origin', 'bot-cube-web-latency']);
  expect(statements).toContainEqual({ Action: 'cloudformation:DescribeStacks', Effect: 'Allow',
    Resource: stack.resolve(deployedStacks(identity).map(name => stack.formatArn({ service: 'cloudformation', resource: 'stack', resourceName: `${name}/*` }))) });
});

test('rechecks a transition stack every 5 seconds, so a finished update starts the next step promptly', () => {
  const stack = new Stack(new App(), 'Polling', { env: { account: identity.aws.account, region: identity.aws.region } });
  parkingTransition(stack, path.resolve(__dirname, '../../..'), identity);
  const [machine] = Object.values(Template.fromStack(stack).findResources('AWS::StepFunctions::StateMachine'))
    .map(resource => JSON.stringify(stack.resolve((resource as { Properties: unknown }).Properties)))
    .filter(definition => definition.includes('WaitForStack'));
  expect(machine).toMatch(/\\"WaitForStack\\":\{\\"Type\\":\\"Wait\\",\\"Seconds\\":5,/);
});
