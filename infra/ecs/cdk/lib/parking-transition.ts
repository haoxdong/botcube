import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArnFormat, AssetHashType, Duration, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { DeployIdentity } from './production-identity.js';

export function parkingTransition(stack: Stack, infraRoot: string, identity: DeployIdentity) {
  const { ecs, agentCore } = identity.aws;
  const worker = new lambda.Function(stack, 'Transition', {
    functionName: `${ecs.parking.functionName}-transition`,
    runtime: lambda.Runtime.PYTHON_3_12, handler: 'parking_transition.handler',
    timeout: Duration.minutes(15), memorySize: 512,
    environment: { PYTHONPATH: '/var/task/ecs', CARTRIDGE_DEPLOY_ROOT: '/var/task/cartridge', CARTRIDGE_REPOSITORY_ROOT: '/var/task', RUNNER_TEMP: '/tmp', TRANSITION_STATE_MACHINE: stack.formatArn({ service: 'states', resource: `stateMachine:${ecs.parking.functionName}-transition` }) },
    code: lambda.Code.fromAsset(infraRoot, { assetHashType: AssetHashType.OUTPUT, bundling: {
      image: lambda.Runtime.PYTHON_3_12.bundlingImage,
      local: { tryBundle(outputDir) {
        fs.mkdirSync(path.join(outputDir, 'cartridge'), { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'cartridge/identity.json'), JSON.stringify(identity));
        fs.copyFileSync(path.join(infraRoot, 'identity-defaults.json'), path.join(outputDir, 'identity-defaults.json'));
        fs.cpSync(path.join(infraRoot, 'ecs'), path.join(outputDir, 'ecs'), { recursive: true,
          filter: source => !['cdk', 'parking', '__pycache__'].includes(path.basename(source)),
        });
        return true;
      } },
    } }),
    logGroup: new logs.LogGroup(stack, 'TransitionLogs', { retention: logs.RetentionDays.ONE_MONTH }),
  });
  const allow = (actions: string[], resources: string[]) => worker.addToRolePolicy(new iam.PolicyStatement({ actions, resources }));
  const stackNames = [ecs.privateEgress.stackName, ecs.previewOriginStackName, ecs.apiHealth.stackName];
  allow(['cloudformation:DescribeStacks', 'cloudformation:DescribeStackResources', 'cloudformation:ListStackResources', 'cloudformation:UpdateStack'],
    stackNames.map(name => stack.formatArn({ service: 'cloudformation', resource: 'stack', resourceName: `${name}/*` })));
  allow(['iam:PassRole'], [stack.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: `cdk-hnb659fds-cfn-exec-role-${stack.account}-${stack.region}` })]);
  allow(['ssm:GetParameters'], [stack.formatArn({ service: 'ssm', resource: 'parameter/cdk-bootstrap/hnb659fds/version' })]);
  allow(['ssm:GetParameter', 'ssm:PutParameter'], [stack.formatArn({ service: 'ssm', resource: `parameter${identity.ssm.parkState}` })]);
  allow(['secretsmanager:GetSecretValue'], [stack.formatArn({ service: 'secretsmanager', resource: `secret:${ecs.originTokenSecretName}-*` })]);
  allow(['ec2:DescribeRouteTables', 'ec2:DescribeNatGateways', 'ec2:DescribeAddresses',
    'elasticloadbalancing:DescribeTargetHealth', 'cloudwatch:DescribeAlarms', 'cloudwatch:GetMetricStatistics', 'sns:ListSubscriptionsByTopic',
    'application-autoscaling:DescribeScalableTargets', 'application-autoscaling:RegisterScalableTarget',
    'bedrock-agentcore:ListAgentRuntimes'], ['*']);
  allow(['route53:GetHealthCheck'], ['*']);
  allow(['events:DescribeRule'], [stack.formatArn({ service: 'events', resource: 'rule', resourceName: '*' })]);
  allow(['ecs:DescribeServices', 'ecs:DescribeTasks', 'ecs:ListTasks', 'ecs:RunTask'], ['*']);
  allow(['iam:PassRole'], [stack.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: `${ecs.previewOriginStackName}-ChatServiceReaperTask*` })]);
  allow(['logs:FilterLogEvents'], [stack.formatArn({ service: 'logs', arnFormat: ArnFormat.COLON_RESOURCE_NAME, resource: 'log-group', resourceName: `/${ecs.cluster}/*` }),
    stack.formatArn({ service: 'logs', arnFormat: ArnFormat.COLON_RESOURCE_NAME, resource: 'log-group', resourceName: `/aws/bedrock-agentcore/runtimes/${agentCore.runtime}-*` })]);
  allow(['lambda:PutProvisionedConcurrencyConfig', 'lambda:DeleteProvisionedConcurrencyConfig', 'lambda:ListProvisionedConcurrencyConfigs', 'lambda:GetAlias', 'lambda:UpdateAlias'],
    [stack.formatArn({ service: 'lambda', arnFormat: ArnFormat.COLON_RESOURCE_NAME, resource: 'function', resourceName: agentCore.sessionApiFunction }),
      stack.formatArn({ service: 'lambda', arnFormat: ArnFormat.COLON_RESOURCE_NAME, resource: 'function', resourceName: `${agentCore.sessionApiFunction}:*` })]);
  allow(['bedrock-agentcore:GetAgentRuntime', 'bedrock-agentcore:UpdateAgentRuntime'], ['*']);
  allow(['iam:PassRole'], [stack.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: identity.aws.iam.runtimeRole })]);
  const advance = new tasks.LambdaInvoke(stack, 'Advance', { lambdaFunction: worker, payloadResponseOnly: true, retryOnServiceExceptions: false });
  advance.addRetry({ errors: ['TransientServiceError', 'Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException'], interval: Duration.seconds(2), backoffRate: 2, maxAttempts: 3 });
  const wait = new sfn.Wait(stack, 'WaitForStack', { time: sfn.WaitTime.duration(Duration.seconds(15)) });
  const done = new sfn.Succeed(stack, 'Verified');
  advance.next(new sfn.Choice(stack, 'Finished').when(sfn.Condition.booleanEquals('$.done', true), done).otherwise(wait));
  wait.next(advance);
  allow(['states:StartExecution', 'states:ListExecutions'], [stack.formatArn({ service: 'states', resource: `stateMachine:${ecs.parking.functionName}-transition` })]);
  const machine = new sfn.StateMachine(stack, 'TransitionStateMachine', {
    stateMachineName: `${ecs.parking.functionName}-transition`,
    definitionBody: sfn.DefinitionBody.fromChainable(advance), timeout: Duration.hours(2),
  });
  const alerts = sns.Topic.fromTopicArn(stack, 'TransitionAlerts', stack.formatArn({ service: 'sns', resource: ecs.alertsTopicName }));
  for (const metric of [machine.metricFailed(), machine.metricTimedOut(), machine.metricAborted()]) {
    const alarm = new cloudwatch.Alarm(stack, `Transition${metric.metricName}`, {
      metric: metric.with({ period: Duration.minutes(1), statistic: 'Sum' }), threshold: 1, evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(new actions.SnsAction(alerts));
  }
  return worker;
}
