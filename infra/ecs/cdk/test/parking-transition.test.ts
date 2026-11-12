import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Capture, Match, Template } from 'aws-cdk-lib/assertions';
import { cartridgeIdentity } from '../lib/cartridge.js';
import { parkingTransition } from '../lib/parking-transition.js';

const identity = cartridgeIdentity(path.resolve(__dirname, '../../../../templates/always-on/deploy'));

test('bundles the transition when cdk.out sits inside ecs/cdk, as in the deploy workflow', () => {
  const infraRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transition-infra-'));
  try {
    for (const file of ['ecs/parking_transition.py', 'ecs/verify/live.py', 'ecs/parking/dispatcher.mjs', 'ecs/cdk/lib/stack.ts', 'ecs/verify/__pycache__/live.pyc']) {
      fs.mkdirSync(path.dirname(path.join(infraRoot, file)), { recursive: true });
      fs.writeFileSync(path.join(infraRoot, file), '');
    }
    fs.writeFileSync(path.join(infraRoot, 'identity-defaults.json'), '{}');
    const app = new App({ outdir: path.join(infraRoot, 'ecs/cdk/cdk.out') });
    parkingTransition(new Stack(app, 'Parking', { env: { account: identity.aws.account, region: identity.aws.region } }), infraRoot, identity);
    const outdir = app.synth().directory;
    const asset = fs.readdirSync(outdir).find(name => fs.existsSync(path.join(outdir, name, 'ecs')));
    if (!asset) throw new Error(`No transition asset in ${outdir}`);
    const bundled = (relative: string) => fs.existsSync(path.join(outdir, asset, relative));
    expect([bundled('ecs/parking_transition.py'), bundled('ecs/verify/live.py'), bundled('cartridge/identity.json'), bundled('identity-defaults.json')]).toEqual([true, true, true, true]);
    expect([bundled('ecs/cdk'), bundled('ecs/parking'), bundled('ecs/verify/__pycache__')]).toEqual([false, false, false]);
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

test('grants provisioned concurrency changes on the unqualified Session API function', () => {
  // Unpark 680a9ed8 (2026-11-12, after these were scoped to the alias ARN) failed: RegisterScalableTarget reported
  // "User is missing the following permissions: lambda:PutProvisionedConcurrencyConfig, lambda:DeleteProvisionedConcurrencyConfig".
  const stack = new Stack(new App(), 'Concurrency', { env: { account: identity.aws.account, region: identity.aws.region } });
  parkingTransition(stack, path.resolve(__dirname, '../../..'), identity);
  const statements = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy'))
    .flatMap(policy => (policy as { Properties: { PolicyDocument: { Statement: { Action: string | string[], Resource: unknown }[] } } }).Properties.PolicyDocument.Statement);
  const resources = (action: string) => statements.filter(statement => [statement.Action].flat().includes(action))
    .flatMap(statement => [statement.Resource].flat().map(resource => JSON.stringify(resource)));
  // An unqualified ARN ends at the function name; the alias ARN continues with ':<alias>'.
  const unqualified = `function:${identity.aws.agentCore.sessionApiFunction}"`;
  for (const action of ['lambda:PutProvisionedConcurrencyConfig', 'lambda:DeleteProvisionedConcurrencyConfig']) {
    expect(resources(action).some(resource => resource.includes(unqualified))).toBe(true);
  }
});

test('binds stack updates to a dedicated CloudFormation execution role instead of CDK admin', () => {
  const stack = new Stack(new App(), 'Boundary', { env: { account: identity.aws.account, region: identity.aws.region } });
  parkingTransition(stack, path.resolve(__dirname, '../../..'), identity);
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: { Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'cloudformation.amazonaws.com' } }], Version: '2012-10-17' },
  });
  expect(JSON.stringify(template.toJSON())).not.toContain('cdk-hnb659fds-cfn-exec-role');
});


test('pins UpdateStack and PassRole to the CloudFormation role and narrows runtime probes', () => {
  const stack = new Stack(new App(), 'TransitionBoundary', { env: { account: identity.aws.account, region: identity.aws.region } });
  parkingTransition(stack, path.resolve(__dirname, '../../..'), identity);
  const template = Template.fromStack(stack);
  const roleArn = new Capture();
  template.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ PARKING_EXECUTION_ROLE_ARN: roleArn }) } });
  const executionArn = roleArn.asObject();
  expect(executionArn).toEqual({ 'Fn::GetAtt': [expect.stringContaining('ParkingExecutionRole'), 'Arn'] });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: Match.objectLike({ PARKING_EXECUTION_ROLE_ARN: executionArn }) },
  });
  template.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([
    Match.objectLike({ Action: 'cloudformation:UpdateStack', Condition: { StringEquals: { 'cloudformation:RoleArn': executionArn } },
      Resource: stack.resolve(['bot-cube-private-egress', 'bot-cube-preview-origin', 'bot-cube-api-health']
        .map(name => stack.formatArn({ service: 'cloudformation', resource: `stack/${name}/*` }))),
    }),
    Match.objectLike({ Action: 'iam:PassRole', Resource: executionArn, Condition: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } } }),
    Match.objectLike({ Action: 'ecs:RunTask', Resource: stack.resolve(stack.formatArn({ service: 'ecs', resource: 'task-definition/PreviewOriginChatServiceReaperTask*:*' })),
      Condition: { ArnEquals: { 'ecs:cluster': stack.resolve(stack.formatArn({ service: 'ecs', resource: 'cluster/bot-cube' })) } } }),
    Match.objectLike({ Action: ['bedrock-agentcore:GetAgentRuntime', 'bedrock-agentcore:UpdateAgentRuntime'],
      Resource: stack.resolve(stack.formatArn({ service: 'bedrock-agentcore', resource: 'runtime/bot_cube_runtime-*' })) }),
  ]) } });
});
