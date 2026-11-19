import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, StreamViewType, Table, type ITable } from 'aws-cdk-lib/aws-dynamodb';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';

export interface ChatStorageProps extends StackProps {
  chatTable?: ITable;
  tableName?: string;
  /** A supplied chat table to import instead of creating one, with its grants: BotCube grants nothing on it. Parking reads its NEW_IMAGE stream. */
  suppliedChatTable?: { tableName: string; streamArn: string };
}

/** Durable shared Chat Service storage: the chat table, and every account's Files (ADR 0077). */
export class ChatStorageStack extends Stack {
  readonly chatTable: Table | ITable;
  /** The operator supplied the chat table with its grants, so no BotCube policy names it. */
  readonly chatTableSupplied: boolean;
  /** The EFS file system that replaces S3 Files for every account's Files; each account is `/accounts/<hash>`. */
  readonly filesEfs: efs.CfnFileSystem;

  constructor(scope: Construct, id: string, props: ChatStorageProps) {
    super(scope, id, props);
    if (props.chatTable && props.tableName !== undefined) throw new Error('Choose chatTable and tableName separately: an imported table owns its name');
    if (props.suppliedChatTable && (props.chatTable || props.tableName !== undefined)) throw new Error('A supplied chat table owns its name; omit chatTable and tableName');
    const supplied = props.suppliedChatTable;
    this.chatTableSupplied = supplied !== undefined;
    this.chatTable = props.chatTable ?? (supplied ? Table.fromTableAttributes(this, 'ChatTable', { tableName: supplied.tableName, tableStreamArn: supplied.streamArn }) : undefined) ?? new Table(this, 'ChatTable', {
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
