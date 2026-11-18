import * as path from 'node:path';
import { CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as custom from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export class FilesAccessPointPool extends Construct {
  readonly bucket: s3.Bucket;
  readonly manifest: { bucket: string; key: string };
  readonly ready: CustomResource;

  constructor(scope: Construct, id: string, props: { fileSystemId: string; fileSystemArn: string; capacity: number; source: string; retain?: boolean; alertsTopic?: sns.ITopic }) {
    super(scope, id);
    const removalPolicy = props.retain === false ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    this.bucket = new s3.Bucket(this, 'Manifest', { encryption: s3.BucketEncryption.S3_MANAGED, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, removalPolicy });
    const dead = new sqs.Queue(this, 'FailedBuilds', { fifo: true, enforceSSL: true });
    const queue = new sqs.Queue(this, 'Builds', { fifo: true, enforceSSL: true, deliveryDelay: Duration.seconds(5), visibilityTimeout: Duration.minutes(12), deadLetterQueue: { queue: dead, maxReceiveCount: 5 } });
    const buildFailure = new cloudwatch.Alarm(this, 'BuildFailed', { metric: dead.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1, alarmDescription: 'Files pool background build failed; retry the queued deployment job after checking its error.' });
    if (props.alertsTopic) buildFailure.addAlarmAction(new actions.SnsAction(props.alertsTopic));
    const functions = ['onEvent', 'isComplete', 'worker'].map(handler => {
      const fn = new lambda.Function(this, handler, {
        runtime: lambda.Runtime.NODEJS_24_X, handler: `index.${handler}`, code: lambda.Code.fromAsset(path.resolve(props.source), { exclude: ['*.test.ts'] }),
        memorySize: 512, timeout: Duration.minutes(2), environment: { QUEUE_URL: queue.queueUrl }, ...(handler === 'worker' ? { reservedConcurrentExecutions: 1, recursiveLoop: lambda.RecursiveLoop.ALLOW } : {}),
      });
      this.bucket.grantReadWrite(fn);
      queue.grantSendMessages(fn);
      if (handler === 'worker') fn.addEventSource(new events.SqsEventSource(queue, { batchSize: 1 }));
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['elasticfilesystem:CreateAccessPoint'], resources: [props.fileSystemArn] }));
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['elasticfilesystem:DescribeAccessPoints'], resources: ['*'] }));
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['elasticfilesystem:DeleteAccessPoint'], resources: [Stack.of(this).formatArn({ service: 'elasticfilesystem', resource: 'access-point', resourceName: '*' })] }));
      return fn;
    });
    const [onEvent, isComplete] = functions;
    if (!onEvent || !isComplete) throw new Error('Files pool requires both deployment handlers');
    const provider = new custom.Provider(this, 'Provider', { onEventHandler: onEvent, isCompleteHandler: isComplete, queryInterval: Duration.seconds(5), totalTimeout: Duration.minutes(55), disableWaiterStateMachineLogging: true });
    this.manifest = { bucket: this.bucket.bucketName, key: `slots-${props.capacity}.json` };
    this.ready = new CustomResource(this, 'Pool', { serviceToken: provider.serviceToken, properties: { FileSystemId: props.fileSystemId, Bucket: this.bucket.bucketName, ManifestKey: this.manifest.key, Count: props.capacity, ProtocolVersion: 2 } });
    const worker = functions[2];
    const mapping = worker?.node.findAll().find(child => child instanceof lambda.EventSourceMapping);
    if (!worker || !mapping) throw new Error('Files pool requires its background queue consumer');
    this.ready.node.addDependency(worker, mapping);
    this.ready.applyRemovalPolicy(removalPolicy);
  }
}
