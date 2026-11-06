import { join } from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export interface ProductionParkingProps extends StackProps {
  parkingPath: string;
  chatTable: ITable;
  parkStateParameter: string;
  hostname: string;
  parking: { repository: string; appSecretName: string; slotBucket: string; originSlotKey: string };
  functionName: string;
  autoPark: boolean;
}

const PARTITION = 'PRODUCTION_PARKING';

export type ParkingIdentity = ProductionParkingProps['parking'] & { functionName: string; automationUserAgents: string[]; autoPark: boolean };

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
      environment: { CHAT_TABLE: chatTable.tableName, HEALTH_URL: `https://${props.hostname}/health`, ...environment },
      logGroup: new logs.LogGroup(this, `${handler}Logs`, { logGroupName: `/aws/lambda/${name}`, retention: logs.RetentionDays.ONE_MONTH }),
    });
    const items = (actions: string[]) => new iam.PolicyStatement({
      actions, resources: [chatTable.tableArn], conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [PARTITION] } },
    });

    const wake = fn(`${props.functionName}-wake`, 'wake', {});
    (wake.node.defaultChild as lambda.CfnFunction).reservedConcurrentExecutions = 5;
    wake.addToRolePolicy(items(['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem']));
    const url = wake.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    const dispatcher = fn(props.functionName, 'dispatcher', {
      PARK_STATE_PARAMETER: props.parkStateParameter,
      SLOT_BUCKET: props.parking.slotBucket,
      ORIGIN_SLOT_KEY: props.parking.originSlotKey,
      GITHUB_APP_SECRET: props.parking.appSecretName,
      REPOSITORY: props.parking.repository,
    });
    dispatcher.addToRolePolicy(items(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem']));
    dispatcher.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'], resources: [this.formatArn({ service: 'ssm', resource: `parameter${props.parkStateParameter}` })],
    }));
    dispatcher.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'], resources: [`arn:${this.partition}:s3:::${props.parking.slotBucket}/${props.parking.originSlotKey}`],
    }));
    // S3 answers a missing key with NoSuchKey only to a caller who may list the bucket; otherwise AccessDenied.
    dispatcher.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [`arn:${this.partition}:s3:::${props.parking.slotBucket}`] }));
    secretsmanager.Secret.fromSecretNameV2(this, 'GithubApp', props.parking.appSecretName).grantRead(dispatcher);
    dispatcher.addEventSource(new DynamoEventSource(chatTable, {
      startingPosition: lambda.StartingPosition.LATEST, retryAttempts: 0, batchSize: 1,
      filters: [lambda.FilterCriteria.filter({
        eventName: lambda.FilterRule.isEqual('INSERT'),
        dynamodb: { Keys: { pk: { S: lambda.FilterRule.isEqual(PARTITION) }, sk: { S: lambda.FilterRule.beginsWith('DISPATCH#') } } },
      })],
    }));
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

export function createProductionParking(scope: Construct, cubeRoot: string, chatTable: ITable, identity: {
  aws: { account: string; region: string; ecs: { parking: ParkingIdentity } };
  ssm: { parkState: string };
  domains: { chatService: string };
}): ProductionParkingStack {
  const { functionName, autoPark, automationUserAgents: _, ...parking } = identity.aws.ecs.parking;
  return new ProductionParkingStack(scope, 'ProductionParking', {
    env: { account: identity.aws.account, region: identity.aws.region },
    parkingPath: join(cubeRoot, 'infra/ecs/parking'), hostname: new URL(identity.domains.chatService).hostname,
    chatTable, parkStateParameter: identity.ssm.parkState, parking, functionName, autoPark,
  });
}
