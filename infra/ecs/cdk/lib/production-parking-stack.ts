import { join } from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { parkingTransition } from './parking-transition.js';
import type { DeployIdentity } from './production-identity.js';
import type { Construct } from 'constructs';

export interface ProductionParkingProps extends StackProps {
  parkingPath: string;
  identity: DeployIdentity;
  /** The registry the transition's bundling image comes from, a mirror of Amazon ECR Public's paths; absent, ECR Public. */
  imageRegistry?: string | undefined;
  chatTable: ITable;
  /** The operator supplied the chat table with its grants: the functions are granted nothing on it or its stream. */
  chatTableSupplied: boolean;
  parkStateParameter: string;
  hostname: string;
  parking: { slotBucket: string; originSlotKey: string };
  functionName: string;
  autoPark: boolean;
}

const PARTITION = 'PRODUCTION_PARKING';

export class ProductionParkingStack extends Stack {
  readonly wakeUrl: string;

  constructor(scope: Construct, id: string, props: ProductionParkingProps) {
    super(scope, id, props);
    const { chatTable } = props;
    if (chatTable.tableStreamArn === undefined) throw new Error('Parking needs the chat table stream, which ChatStorage enables');
    const fn = (name: string, handler: string, environment: Record<string, string>) => new lambda.Function(this, handler, {
      functionName: name,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: `${handler}.handler`,
      code: lambda.Code.fromAsset(props.parkingPath, { exclude: ['*.test.ts'] }),
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: { BOTCUBE_CHAT_TABLE: chatTable.tableName, HEALTH_URL: `https://${props.hostname}/health`, ...environment },
      logGroup: new logs.LogGroup(this, `${handler}Logs`, { logGroupName: `/aws/lambda/${name}`, retention: logs.RetentionDays.ONE_MONTH }),
    });
    const grantItems = (fn: lambda.Function, actions: string[]) => props.chatTableSupplied || fn.addToRolePolicy(new iam.PolicyStatement({
      actions, resources: [chatTable.tableArn], conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [PARTITION] } },
    }));

    const wake = fn(`${props.functionName}-wake`, 'wake', {});
    (wake.node.defaultChild as lambda.CfnFunction).reservedConcurrentExecutions = 5;
    grantItems(wake, ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem']);
    const url = wake.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    const transition = parkingTransition(this, join(props.parkingPath, '../..'), props.identity, props.imageRegistry);
    const dispatcher = fn(props.functionName, 'dispatcher', {
      PARK_STATE_PARAMETER: props.parkStateParameter,
      SLOT_BUCKET: props.parking.slotBucket,
      ORIGIN_SLOT_KEY: props.parking.originSlotKey,
      TRANSITION_FUNCTION: transition.functionName,
    });
    grantItems(dispatcher, ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem']);
    dispatcher.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'], resources: [this.formatArn({ service: 'ssm', resource: `parameter${props.parkStateParameter}` })],
    }));
    dispatcher.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'], resources: [`arn:${this.partition}:s3:::${props.parking.slotBucket}/${props.parking.originSlotKey}`],
    }));
    // S3 answers a missing key with NoSuchKey only to a caller who may list the bucket; otherwise AccessDenied.
    dispatcher.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [`arn:${this.partition}:s3:::${props.parking.slotBucket}`] }));
    (dispatcher.node.defaultChild as lambda.CfnFunction).reservedConcurrentExecutions = 1;
    transition.grantInvoke(dispatcher);
    const dispatches = {
      startingPosition: lambda.StartingPosition.LATEST, retryAttempts: 0, batchSize: 1,
      filters: [lambda.FilterCriteria.filter({
        eventName: lambda.FilterRule.isEqual('INSERT'),
        dynamodb: { Keys: { pk: { S: lambda.FilterRule.isEqual(PARTITION) }, sk: { S: lambda.FilterRule.beginsWith('DISPATCH#') } } },
      })],
    };
    // DynamoEventSource grants the stream read; a supplied table's stream carries that grant itself.
    if (props.chatTableSupplied) dispatcher.addEventSourceMapping('SuppliedChatTableDispatches', { ...dispatches, eventSourceArn: chatTable.tableStreamArn });
    else dispatcher.addEventSource(new DynamoEventSource(chatTable, dispatches));
    new events.Rule(this, 'IdleCheck', {
      enabled: props.autoPark,
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(dispatcher, { event: events.RuleTargetInput.fromObject({ op: 'check' }), retryAttempts: 0 })],
    });
    this.wakeUrl = url.url;
    // Only the Parked PreviewOrigin imports it; keeping the export lets unpark update this stack before PreviewOrigin drops the import.
    this.exportValue(url.url);
    new CfnOutput(this, 'WakeUrl', { value: url.url });
  }
}

export function createProductionParking(scope: Construct, cubeRoot: string, chatTable: ITable, chatTableSupplied: boolean, identity: DeployIdentity, imageRegistry?: string): ProductionParkingStack {
  const { functionName, autoPark, slotBucket, originSlotKey } = identity.aws.ecs.parking;
  return new ProductionParkingStack(scope, 'ProductionParking', {
    env: { account: identity.aws.account, region: identity.aws.region },
    parkingPath: join(cubeRoot, 'infra/ecs/parking'), hostname: new URL(identity.domains.chatService).hostname,
    chatTable, chatTableSupplied, parkStateParameter: identity.ssm.parkState, parking: { slotBucket, originSlotKey }, functionName, autoPark, identity, imageRegistry,
  });
}
