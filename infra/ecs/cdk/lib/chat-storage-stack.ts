import { CfnOutput, CfnWaitConditionHandle, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, StreamViewType, Table, type ITable } from 'aws-cdk-lib/aws-dynamodb';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';

export interface ChatStorageProps extends StackProps {
  chatTable?: ITable;
  tableName?: string;
  /** A existing chat table to import instead of creating one, with its grants: BotCube grants nothing on it. Parking reads its NEW_IMAGE stream. */
  existingChatTable?: { tableName: string; streamArn: string };
  /** A existing Files file system, its shared `/accounts` access point and the pool Users lease theirs from: BotCube creates and grants none of them. */
  existingFiles?: ExistingFiles;
}

/** As the BotCube Config's `existing.files` gives them. */
export interface ExistingFiles {
  fileSystemId: string;
  accountsAccessPointId: string;
  accessPoints: readonly { accessPointId: string; rootDirectory: string }[];
}

/** Durable shared Chat Service storage: the chat table, and every account's Files (ADR 0077). */
export class ChatStorageStack extends Stack {
  readonly chatTable: Table | ITable;
  /** The operator existing the chat table with its grants, so no BotCube policy names it. */
  readonly chatTableExisting: boolean;
  /** The EFS file system that replaces S3 Files for every account's Files; each account is `/accounts/<hash>`. */
  readonly filesEfs: Pick<efs.CfnFileSystem, 'ref' | 'attrArn'>;
  readonly existingFiles: ExistingFiles | undefined;

  constructor(scope: Construct, id: string, props: ChatStorageProps) {
    super(scope, id, props);
    if (props.chatTable && props.tableName !== undefined) throw new Error('Choose chatTable and tableName separately: an imported table owns its name');
    if (props.existingChatTable && (props.chatTable || props.tableName !== undefined)) throw new Error('A existing chat table owns its name; omit chatTable and tableName');
    const existing = props.existingChatTable;
    this.chatTableExisting = existing !== undefined;
    this.chatTable = props.chatTable ?? (existing ? Table.fromTableAttributes(this, 'ChatTable', { tableName: existing.tableName, tableStreamArn: existing.streamArn }) : undefined) ?? new Table(this, 'ChatTable', {
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

    this.existingFiles = props.existingFiles;
    if (props.existingFiles) {
      const { fileSystemId } = props.existingFiles;
      this.filesEfs = { ref: fileSystemId, attrArn: this.formatArn({ service: 'elasticfilesystem', resource: 'file-system', resourceName: fileSystemId }) };
      // CloudFormation refuses a template with no resource: everything here existing, the stack holds a no-op one.
      if (existing) new CfnWaitConditionHandle(this, 'Existing');
      return;
    }
    // Files on EFS. Only IAM principals of this account mount it, over TLS, each through
    // an access point their policy names: nothing mounts it anonymously, and nothing gets root.
    const filesEfs = new efs.CfnFileSystem(this, 'FilesEfs', {
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
    filesEfs.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.filesEfs = filesEfs;
    new CfnOutput(this, 'FilesEfsArn', { value: filesEfs.attrArn });
  }
}
