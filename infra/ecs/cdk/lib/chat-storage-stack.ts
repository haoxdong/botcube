import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, StreamViewType, Table, type ITable } from 'aws-cdk-lib/aws-dynamodb';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';

export interface ChatStorageProps extends StackProps {
  chatTable?: ITable;
  tableName?: string;
}

/** Durable shared Chat Service storage: the chat table, and every account's Files (ADR 0077). */
export class ChatStorageStack extends Stack {
  readonly chatTable: Table | ITable;
  /** The EFS file system that replaces S3 Files for every account's Files; each account is `/accounts/<hash>`. */
  readonly filesEfs: efs.CfnFileSystem;

  constructor(scope: Construct, id: string, props: ChatStorageProps) {
    super(scope, id, props);
    if (props.chatTable && props.tableName !== undefined) throw new Error('Choose chatTable and tableName separately: an imported table owns its name');
    this.chatTable = props.chatTable ?? new Table(this, 'ChatTable', {
      tableName: props.tableName ?? 'chat',
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      timeToLiveAttribute: 'turnQuotaExpiresAt',
      stream: StreamViewType.NEW_IMAGE,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    new CfnOutput(this, 'ChatTableName', { value: this.chatTable.tableName });

    // Files on EFS. Only IAM principals of this account mount it, over TLS, each through
    // an access point their policy names: nothing mounts it anonymously, and nothing gets root.
    this.filesEfs = new efs.CfnFileSystem(this, 'FilesEfs', {
      encrypted: true,
      performanceMode: 'generalPurpose',
      throughputMode: 'elastic',
      // Files are the user's own data: AWS Backup keeps daily recovery points for 35 days.
      backupPolicy: { status: 'ENABLED' },
      fileSystemPolicy: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { AWS: `arn:${this.partition}:iam::${this.account}:root` },
          Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
          Condition: { Bool: { 'aws:SecureTransport': 'true', 'elasticfilesystem:AccessedViaMountTarget': 'true' } },
        }],
      },
    });
    this.filesEfs.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new CfnOutput(this, 'FilesEfsArn', { value: this.filesEfs.attrArn });
  }
}
