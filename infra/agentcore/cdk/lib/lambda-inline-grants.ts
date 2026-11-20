import { ArnFormat, CfnResource, Lazy, Stack, Token, Tokenization } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { IConstruct } from 'constructs';

const OWN_LOGS = ['logs:CreateLogStream', 'logs:PutLogEvents'];
const BASIC_EXECUTION = 'service-role/AWSLambdaBasicExecutionRole';
const VPC_ACCESS = 'service-role/AWSLambdaVPCAccessExecutionRole';

/**
 * Give every Lambda function under `scope` whose role holds AWS's AWSLambdaBasicExecutionRole or
 * AWSLambdaVPCAccessExecutionRole, CDK's own handlers included, inline grants on its own log group and network in their
 * place, for accounts that refuse AWS managed policies. A function logging to Lambda's default group gets a group of its
 * own, kept a month.
 */
export function grantLambdasInline(scope: IConstruct): void {
  for (const fn of scope.node.findAll().filter(isFunctionResource)) {
    const role = executionRole(fn);
    if (!(role instanceof iam.Role)) continue;
    if (dropManagedPolicy(role, BASIC_EXECUTION)) {
      grantBeforeDeploying(fn, role, { actions: OWN_LOGS, resources: [logGroupArn(fn, ownLogGroupName(fn))] });
    }
    const network = fn instanceof lambda.CfnFunction ? fn.vpcConfig : undefined;
    if (dropManagedPolicy(role, VPC_ACCESS) && network && !Tokenization.isResolvable(network)) {
      grantNetwork(fn, network.subnetIds ?? [], network.securityGroupIds ?? []);
    }
  }
}

/**
 * Let the function's role attach it to the network: create its interfaces only in `subnetIds` with
 * `securityGroupIds`, and manage only this account's interfaces.
 */
export function grantNetwork(fn: CfnResource, subnetIds: readonly string[], securityGroupIds: readonly string[]): void {
  const role = executionRole(fn);
  if (!role) return;
  const ec2 = (resource: string, ids: readonly string[]) =>
    ids.map(id => Stack.of(fn).formatArn({ service: 'ec2', resource, resourceName: id }));
  const interfaces = ec2('network-interface', ['*']);
  grantBeforeDeploying(fn, role, {
    actions: ['ec2:DescribeNetworkInterfaces', 'ec2:DescribeSubnets'],
    resources: ['*'],
  });
  grantBeforeDeploying(fn, role, {
    actions: ['ec2:CreateNetworkInterface'],
    resources: [...interfaces, ...ec2('subnet', subnetIds), ...ec2('security-group', securityGroupIds)],
  });
  grantBeforeDeploying(fn, role, {
    actions: ['ec2:DeleteNetworkInterface', 'ec2:AssignPrivateIpAddresses', 'ec2:UnassignPrivateIpAddresses'],
    resources: interfaces,
  });
}

export function isFunctionResource(construct: IConstruct): construct is CfnResource {
  return construct instanceof CfnResource && construct.cfnResourceType === 'AWS::Lambda::Function';
}

/** The role the function runs as: its L2 function's, or the `ServiceRole` beside a raw handler such as LogRetention's. */
function executionRole(fn: CfnResource): iam.IRole | undefined {
  const owner = fn.node.scope;
  if (owner instanceof lambda.Function) return owner.role;
  const sibling = owner?.node.tryFindChild('ServiceRole');
  return sibling instanceof iam.Role ? sibling : undefined;
}

function grantBeforeDeploying(fn: CfnResource, role: iam.IRole, statement: iam.PolicyStatementProps): void {
  const { policyDependable } = role.addToPrincipalPolicy(new iam.PolicyStatement(statement));
  if (policyDependable) fn.node.addDependency(policyDependable);
}

function dropManagedPolicy(role: iam.Role, name: string): boolean {
  const stack = Stack.of(role);
  const cfn = role.node.defaultChild as iam.CfnRole;
  const dropped = JSON.stringify(stack.resolve(iam.ManagedPolicy.fromAwsManagedPolicyName(name).managedPolicyArn));
  const held = cfn.managedPolicyArns;
  const others = (arns: readonly unknown[] = []) => arns.filter(arn => JSON.stringify(arn) !== dropped);
  const resolved: unknown[] | undefined = stack.resolve(held);
  if (!resolved?.some(arn => JSON.stringify(arn) === dropped)) return false;
  cfn.managedPolicyArns = Token.asList(
    Lazy.any({ produce: () => others(stack.resolve(held)) }, { omitEmptyArray: true })
  );
  return true;
}

function ownLogGroupName(fn: CfnResource): string {
  const config = fn instanceof lambda.CfnFunction ? fn.loggingConfig : undefined;
  const configured = config && !Tokenization.isResolvable(config) ? config.logGroup : undefined;
  if (configured) return configured;
  const group = new logs.LogGroup(fn.node.scope ?? fn, 'OwnLogs', { retention: logs.RetentionDays.ONE_MONTH });
  fn.addPropertyOverride('LoggingConfig.LogGroup', group.logGroupName);
  return group.logGroupName;
}

function logGroupArn(fn: CfnResource, logGroupName: string): string {
  return Stack.of(fn).formatArn({
    service: 'logs',
    resource: 'log-group',
    resourceName: `${logGroupName}:*`,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
}
