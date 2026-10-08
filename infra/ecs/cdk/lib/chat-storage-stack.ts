import { optionalPhysicalName } from './physical-name.js';
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table, type ITable } from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { CfnFileSystem } from 'aws-cdk-lib/aws-s3files';
import { Construct } from 'constructs';

export interface ChatStorageProps extends StackProps {
  chatTable?: ITable;
  filesBucket?: s3.IBucket;
  tableName?: string;
  filesBucketName?: string;
  filesSyncRoleName?: string;
  /** Web origins for a created Files bucket; imported buckets keep adopter-owned CORS. */
  corsOrigins: string[];
}

/** Durable shared Chat Service storage: the chat table, and every account's Files (ADR 0077). */
export class ChatStorageStack extends Stack {
  readonly chatTable: Table | ITable;
  /** The bucket behind the Files file system; each account's files live under `accounts/<hash>/`. */
  readonly filesBucket: s3.Bucket | s3.IBucket;
  readonly filesFileSystem: CfnFileSystem;

  constructor(scope: Construct, id: string, props: ChatStorageProps) {
    super(scope, id, props);
    if (props.chatTable && props.tableName !== undefined) throw new Error('Choose chatTable and tableName separately: an imported table owns its name');
    if (props.filesBucket && props.filesBucketName !== undefined) throw new Error('Choose filesBucket and filesBucketName separately: an imported bucket owns its name');
    this.chatTable = props.chatTable ?? new Table(this, 'ChatTable', {
      tableName: props.tableName ?? 'chat',
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new CfnOutput(this, 'ChatTableName', { value: this.chatTable.tableName });

    // S3 Files needs a versioned bucket with SSE-S3 or SSE-KMS.
    this.filesBucket = props.filesBucket ?? new s3.Bucket(this, 'FilesBucket', {
      ...optionalPhysicalName('bucketName', props.filesBucketName),
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [{ allowedOrigins: props.corsOrigins, allowedMethods: [s3.HttpMethods.PUT], allowedHeaders: ['*'] }],
    });
    // The role S3 Files assumes to sync the file system with the bucket.
    const sync = new iam.Role(this, 'FilesSyncRole', {
      ...optionalPhysicalName('roleName', props.filesSyncRoleName),
      assumedBy: new iam.ServicePrincipal('elasticfilesystem.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:${this.partition}:s3files:${this.region}:${this.account}:file-system/*` },
        },
      }),
    });
    this.filesBucket.grantReadWrite(sync);
    sync.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucketVersions', 's3:GetObjectVersion*', 's3:DeleteObjectVersion'],
      resources: [this.filesBucket.bucketArn, this.filesBucket.arnForObjects('*')],
    }));
    sync.addToPolicy(new iam.PolicyStatement({
      actions: ['events:DeleteRule', 'events:DisableRule', 'events:EnableRule', 'events:PutRule', 'events:PutTargets', 'events:RemoveTargets'],
      resources: [`arn:${this.partition}:events:*:*:rule/DO-NOT-DELETE-S3-Files*`],
      conditions: { StringEquals: { 'events:ManagedBy': 'elasticfilesystem.amazonaws.com' } },
    }));
    sync.addToPolicy(new iam.PolicyStatement({
      actions: ['events:DescribeRule', 'events:ListRuleNamesByTarget', 'events:ListRules', 'events:ListTargetsByRule'],
      resources: [`arn:${this.partition}:events:*:*:rule/*`],
    }));
    this.filesFileSystem = new CfnFileSystem(this, 'FilesFileSystem', {
      bucket: this.filesBucket.bucketArn,
      roleArn: sync.roleArn,
    });
    this.filesFileSystem.node.addDependency(sync);
    this.filesFileSystem.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new CfnOutput(this, 'FilesFileSystemArn', { value: this.filesFileSystem.attrFileSystemArn });
  }
}
