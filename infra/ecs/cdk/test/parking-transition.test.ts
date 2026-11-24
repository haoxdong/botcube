import { readConfig } from 'botcube-config/read';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { deployIdentity } from '../lib/deploy-root.js';
import { deployedStacks, parkingTransition } from '../lib/parking-transition.js';

const identity = deployIdentity(path.resolve(__dirname, '../../../../examples/public/deploy'));

const CONFIG = { path: path.resolve(__dirname, '../../../../examples/public/botcube.yaml') };

test('bundles the transition when cdk.out sits inside ecs/cdk, as in the deploy workflow', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transition-infra-'));
  const infraRoot = path.join(root, 'infra');
  try {
    for (const file of ['ecs/parking_transition.py', 'ecs/verify/live.py', 'ecs/parking/dispatcher.mjs', 'ecs/cdk/lib/stack.ts', 'ecs/verify/__pycache__/live.pyc']) {
      fs.mkdirSync(path.dirname(path.join(infraRoot, file)), { recursive: true });
      fs.writeFileSync(path.join(infraRoot, file), '');
    }
    for (const file of ['ecs/deploy_identity.py', 'identity-defaults.json', 'transition-requirements.txt']) fs.copyFileSync(path.resolve(__dirname, '../../..', file), path.join(infraRoot, file));
    fs.symlinkSync(path.resolve(__dirname, '../../../../credential-service'), path.join(root, 'credential-service'));
    const app = new App({ outdir: path.join(infraRoot, 'ecs/cdk/cdk.out') });
    const stack = new Stack(app, 'Parking', { env: { account: identity.aws.account, region: identity.aws.region } });
    parkingTransition(stack, infraRoot, identity, CONFIG);
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([{
      Action: ['ssm:GetParameter', 'ssm:PutParameter'], Effect: 'Allow', Resource: stack.resolve([
        stack.formatArn({ service: 'ssm', resource: `parameter${identity.ssm.parkState}` }),
        stack.formatArn({ service: 'ssm', resource: `parameter${identity.ssm.parkState}/backstop` }),
      ]),
    }]) } });
    const [environment] = Object.values(template.findResources('AWS::Lambda::Function'))
      .map(resource => (resource as { Properties: { Environment: { Variables: Record<string, unknown> } } }).Properties.Environment.Variables);
    expect(environment).toMatchObject({ BOTCUBE_CONFIG: '/var/task/botcube.yaml', PYTHONPATH: '/var/task/ecs' });
    expect(Object.keys(environment ?? {}).filter(name => name.startsWith('BOTCUBE_'))).toEqual(['BOTCUBE_CONFIG']);
    const outdir = app.synth().directory;
    const asset = fs.readdirSync(outdir).find(name => fs.existsSync(path.join(outdir, name, 'ecs')));
    if (!asset) throw new Error(`No transition asset in ${outdir}`);
    const bundle = path.join(outdir, asset);
    const bundled = (relative: string) => fs.existsSync(path.join(bundle, relative));
    expect([bundled('ecs/parking_transition.py'), bundled('ecs/verify/live.py'), bundled('botcube.yaml'), bundled('identity-defaults.json')]).toEqual([true, true, true, true]);
    // The release tooling's settings stay with it, never in a deployed bundle.
    expect(bundled('release.json')).toBe(false);
    expect([bundled('ecs/cdk'), bundled('ecs/parking'), bundled('ecs/verify/__pycache__'), bundled('deploy')]).toEqual([false, false, false, false]);
    // The Lambda imports this botocore, not the runtime's older built-in one that dropped platformVersion.
    const locked = fs.readFileSync(path.resolve(__dirname, '../../../transition-requirements.txt'), 'utf8').match(/^botocore==(\S+)/m)?.[1];
    expect(fs.readFileSync(path.join(bundle, 'botocore/__init__.py'), 'utf8')).toContain(`__version__ = '${locked}'`);
    expect([bundled('boto3/__init__.py'), bundled('bin')]).toEqual([true, false]);
    // The bundle alone, without the site packages the tests run on, gives the Lambda the identity synthesis used.
    const loaded = JSON.parse(execFileSync('python3', ['-I', '-S', '-c',
      'import json, sys; sys.path[:0] = [sys.argv[1], sys.argv[1] + "/ecs"]; import deploy_identity; print(json.dumps(deploy_identity.load_deployment()))', bundle],
    { env: { PATH: process.env.PATH, BOTCUBE_CONFIG: path.join(bundle, 'botcube.yaml') }, encoding: 'utf8' }));
    expect(loaded).toEqual(readConfig(CONFIG.path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lets the transition register the Session API scalable target', () => {
  // RegisterScalableTarget fails with a ValidationException unless the caller holds these (run 9e9ac581 on 2026-11-12).
  const stack = new Stack(new App(), 'Scaling', { env: { account: identity.aws.account, region: identity.aws.region } });
  parkingTransition(stack, path.resolve(__dirname, '../../..'), identity, CONFIG);
  const actions = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy'))
    .flatMap(policy => (policy as { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } }).Properties.PolicyDocument.Statement)
    .flatMap(statement => [statement.Action].flat());
  expect(actions).toEqual(expect.arrayContaining(['lambda:GetProvisionedConcurrencyConfig', 'cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'application-autoscaling:RegisterScalableTarget']));
});

test('lets the transition read only deploy leases and the deployed stacks it guards a park with', () => {
  const stack = new Stack(new App(), 'Guard', { env: { account: identity.aws.account, region: identity.aws.region } });
  parkingTransition(stack, path.resolve(__dirname, '../../..'), identity, CONFIG);
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
  parkingTransition(stack, path.resolve(__dirname, '../../..'), identity, CONFIG);
  const [machine] = Object.values(Template.fromStack(stack).findResources('AWS::StepFunctions::StateMachine'))
    .map(resource => JSON.stringify(stack.resolve((resource as { Properties: unknown }).Properties)))
    .filter(definition => definition.includes('WaitForStack'));
  expect(machine).toMatch(/\\"WaitForStack\\":\{\\"Type\\":\\"Wait\\",\\"Seconds\\":5,/);
});

test('reports a failed live advance to SNS before the execution fails', () => {
  const stack = new Stack(new App(), 'Failure', { env: { account: identity.aws.account, region: identity.aws.region } });
  parkingTransition(stack, path.resolve(__dirname, '../../..'), identity, CONFIG);
  const [machine] = Object.values(Template.fromStack(stack).findResources('AWS::StepFunctions::StateMachine'))
    .map(resource => JSON.stringify(stack.resolve((resource as { Properties: unknown }).Properties)))
    .filter(definition => definition.includes('WaitForStack'));
  const definition = machine?.replaceAll('\\"', '"');
  expect(definition).toContain('"ErrorEquals":["States.ALL"],"ResultPath":"$.failure","Next":"WasLiveTransition"');
  expect(definition).toContain('"Variable":"$.mode","StringEquals":"live","Next":"ReportLiveTransitionFailure"');
  expect(definition).toContain('"Next":"TransitionFailed"');
  expect(definition).toContain('"Subject":"Production live transition failed"');
});
