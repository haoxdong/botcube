import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArnFormat, AssetHashType, DockerImage, Duration, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { DeployIdentity } from './production-identity.js';

export function parkingTransition(stack: Stack, infraRoot: string, identity: DeployIdentity, imageRegistry?: string) {
  const { ecs, agentCore } = identity.aws;
  const worker = new lambda.Function(stack, 'Transition', {
    functionName: `${ecs.parking.functionName}-transition`,
    runtime: lambda.Runtime.PYTHON_3_12, handler: 'parking_transition.handler',
    timeout: Duration.minutes(15), memorySize: 512,
    environment: { PYTHONPATH: '/var/task/ecs', CARTRIDGE_DEPLOY_ROOT: '/var/task/cartridge', CARTRIDGE_REPOSITORY_ROOT: '/var/task', RUNNER_TEMP: '/tmp', BACKSTOP_STATE_MACHINE: stack.formatArn({ service: 'states', resource: `stateMachine:${ecs.parking.functionName}-backstop` }), MONITORING_STATE_MACHINE: stack.formatArn({ service: 'states', resource: `stateMachine:${ecs.parking.functionName}-monitoring` }), TRANSITION_STATE_MACHINE: stack.formatArn({ service: 'states', resource: `stateMachine:${ecs.parking.functionName}-transition` }) },
    code: lambda.Code.fromAsset(infraRoot, { assetHashType: AssetHashType.OUTPUT, bundling: {
      image: imageRegistry ? DockerImage.fromRegistry(`${imageRegistry}/sam/build-${lambda.Runtime.PYTHON_3_12.name}`) : lambda.Runtime.PYTHON_3_12.bundlingImage,
      local: { tryBundle(outputDir) {
        fs.mkdirSync(path.join(outputDir, 'cartridge'), { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'cartridge/identity.json'), JSON.stringify(identity));
        fs.copyFileSync(path.join(infraRoot, 'identity-defaults.json'), path.join(outputDir, 'identity-defaults.json'));
        // Copy entry by entry: cdk.out sits under ecs/cdk, and copying ecs/ whole into it is a copy into itself.
        const skip = (source: string) => ['cdk', 'parking', '__pycache__'].includes(path.basename(source));
        for (const entry of fs.readdirSync(path.join(infraRoot, 'ecs')).filter(name => !skip(name))) fs.cpSync(path.join(infraRoot, 'ecs', entry), path.join(outputDir, 'ecs', entry), { recursive: true, filter: source => !skip(source) });
        return true;
      } },
    } }),
    logGroup: new logs.LogGroup(stack, 'TransitionLogs', { retention: logs.RetentionDays.ONE_MONTH }),
  });
  const allow = (actions: string[], resources: string[]) => worker.addToRolePolicy(new iam.PolicyStatement({ actions, resources }));
  const stackNames = [...(ecs.privateEgress ? [ecs.privateEgress.stackName] : []), ecs.previewOriginStackName, ecs.apiHealth.stackName];
  allow(['cloudformation:DescribeStacks', 'cloudformation:DescribeStackResources', 'cloudformation:ListStackResources', 'cloudformation:UpdateStack'],
    stackNames.map(name => stack.formatArn({ service: 'cloudformation', resource: 'stack', resourceName: `${name}/*` })));
  allow(['iam:PassRole'], [stack.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: `cdk-hnb659fds-cfn-exec-role-${stack.account}-${stack.region}` })]);
  allow(['ssm:GetParameters'], [stack.formatArn({ service: 'ssm', resource: 'parameter/cdk-bootstrap/hnb659fds/version' })]);
  allow(['ssm:GetParameter', 'ssm:PutParameter'], [stack.formatArn({ service: 'ssm', resource: `parameter${identity.ssm.parkState}` }),
    stack.formatArn({ service: 'ssm', resource: `parameter${identity.ssm.parkState}/backstop` })]);
  allow(['secretsmanager:GetSecretValue'], [stack.formatArn({ service: 'secretsmanager', resource: `secret:${ecs.originTokenSecretName}-*` })]);
  allow(['ec2:DescribeRouteTables', 'ec2:DescribeNatGateways', 'ec2:DescribeAddresses',
    'elasticloadbalancing:DescribeTargetHealth', 'cloudwatch:DescribeAlarms', 'cloudwatch:GetMetricStatistics', 'sns:ListSubscriptionsByTopic',
    'application-autoscaling:DescribeScalableTargets', 'application-autoscaling:RegisterScalableTarget',
    'bedrock-agentcore:ListAgentRuntimes'], ['*']);
  allow(['route53:GetHealthCheck'], ['*']);
  allow(['events:DescribeRule'], [stack.formatArn({ service: 'events', resource: 'rule', resourceName: '*' })]);
  allow(['ecs:DescribeServices', 'ecs:DescribeTasks', 'ecs:ListTasks', 'ecs:RunTask', 'ecs:StopTask'], ['*']);
  allow(['iam:PassRole'], [stack.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: `${ecs.previewOriginStackName}-ChatServiceReaperTask*` })]);
  allow(['logs:FilterLogEvents'], [stack.formatArn({ service: 'logs', arnFormat: ArnFormat.COLON_RESOURCE_NAME, resource: 'log-group', resourceName: `/${ecs.cluster}/*` }),
    stack.formatArn({ service: 'logs', arnFormat: ArnFormat.COLON_RESOURCE_NAME, resource: 'log-group', resourceName: `/aws/bedrock-agentcore/runtimes/${agentCore.runtime}-*` })]);
  allow(['lambda:GetProvisionedConcurrencyConfig', 'lambda:PutProvisionedConcurrencyConfig', 'lambda:DeleteProvisionedConcurrencyConfig', 'lambda:ListProvisionedConcurrencyConfigs', 'lambda:GetAlias', 'lambda:UpdateAlias'],
    [stack.formatArn({ service: 'lambda', arnFormat: ArnFormat.COLON_RESOURCE_NAME, resource: 'function', resourceName: agentCore.sessionApiFunction }),
      stack.formatArn({ service: 'lambda', arnFormat: ArnFormat.COLON_RESOURCE_NAME, resource: 'function', resourceName: `${agentCore.sessionApiFunction}:*` })]);
  // RegisterScalableTarget checks the caller can manage target-tracking alarms on any resource (run 5e5fb38a, 2026-11-12).
  allow(['cloudwatch:PutMetricAlarm', 'cloudwatch:DescribeAlarms', 'cloudwatch:DeleteAlarms'], ['*']);
  allow(['bedrock-agentcore:GetAgentRuntime', 'bedrock-agentcore:UpdateAgentRuntime'], ['*']);
  allow(['iam:PassRole'], [stack.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: identity.aws.iam.runtimeRole })]);
  const advance = new tasks.LambdaInvoke(stack, 'Advance', { lambdaFunction: worker, payloadResponseOnly: true, retryOnServiceExceptions: false });
  advance.addRetry({ errors: ['TransientServiceError', 'Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException'], interval: Duration.seconds(2), backoffRate: 2, maxAttempts: 3 });
  const wait = new sfn.Wait(stack, 'WaitForStack', { time: sfn.WaitTime.duration(Duration.seconds(5)) });
  const done = new sfn.Succeed(stack, 'Verified');
  advance.next(new sfn.Choice(stack, 'Finished')
    .when(sfn.Condition.booleanEquals('$.done', true), done)
    .when(sfn.Condition.booleanEquals('$.waiting', false), advance)
    .otherwise(wait));
  wait.next(advance);
  allow(['states:StartExecution', 'states:ListExecutions'], ['transition', 'backstop', 'monitoring'].map(name => stack.formatArn({ service: 'states', resource: `stateMachine:${ecs.parking.functionName}-${name}` })));
  const machine = new sfn.StateMachine(stack, 'TransitionStateMachine', {
    stateMachineName: `${ecs.parking.functionName}-transition`,
    definitionBody: sfn.DefinitionBody.fromChainable(advance), timeout: Duration.hours(2),
  });
  const expire = new tasks.LambdaInvoke(stack, 'ExpirePartialMode', { lambdaFunction: worker, payloadResponseOnly: true });
  expire.addRetry({ errors: ['TransientServiceError'], interval: Duration.minutes(1), backoffRate: 1, maxAttempts: 120 });
  const backstop = new sfn.StateMachine(stack, 'PartialModeBackstop', {
    stateMachineName: `${ecs.parking.functionName}-backstop`,
    definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Wait(stack, 'PartialModeDeadline', {
      time: sfn.WaitTime.duration(Duration.hours(1)),
    }).next(expire)), timeout: Duration.hours(4),
  });
  const alerts = sns.Topic.fromTopicArn(stack, 'TransitionAlerts', stack.formatArn({ service: 'sns', resource: ecs.alertsTopicName }));
  const observe = new tasks.LambdaInvoke(stack, 'EstablishMonitoring', {
    lambdaFunction: worker, payloadResponseOnly: true, retryOnServiceExceptions: false,
    taskTimeout: sfn.Timeout.duration(Duration.minutes(11)),
  });
  observe.addCatch(new tasks.SnsPublish(stack, 'ReportMonitoringFailure', {
    topic: alerts, subject: 'Production monitoring proof failed', resultPath: sfn.JsonPath.DISCARD,
    message: sfn.TaskInput.fromObject({ executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
      failure: sfn.JsonPath.objectAt('$.failure') }),
  }).next(new sfn.Fail(stack, 'MonitoringFailed', { errorPath: '$.failure.Error', causePath: '$.failure.Cause' })),
  { resultPath: '$.failure' });
  const monitoring = new sfn.StateMachine(stack, 'MonitoringProof', {
    stateMachineName: `${ecs.parking.functionName}-monitoring`,
    definitionBody: sfn.DefinitionBody.fromChainable(observe), timeout: Duration.minutes(12),
  });
  for (const [metric, backup, observation] of [
    [machine.metricFailed(), backstop.metricFailed(), monitoring.metricFailed()],
    [machine.metricTimedOut(), backstop.metricTimedOut(), monitoring.metricTimedOut()],
    [machine.metricAborted(), backstop.metricAborted(), monitoring.metricAborted()],
  ] as const) {
    const alarm = new cloudwatch.Alarm(stack, `Transition${metric.metricName}`, {
      metric: new cloudwatch.MathExpression({ expression: 'primary + backup + monitoring', usingMetrics: { primary: metric, backup, monitoring: observation }, period: Duration.minutes(1) }),
      threshold: 1, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new actions.SnsAction(alerts));
  }
  return worker;
}
