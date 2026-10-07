import { CreateBackupCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { backfillActivity } from './activity-backfill.js';
import { sessionApi } from './session-api.js';
import { DynamoDBSessionMetadata } from './session-metadata.js';

// The one-time Activity backfill, run by an operator with deploy credentials
// (docs/runbooks/preview-origin.md):
//   AWS_REGION=us-east-1 pnpm --filter botcube-chat backfill:activity <table> <session API function ARN> [--apply]
// Without --apply it writes nothing and reports what it would write. With --apply it first takes an
// on-demand backup of the table, then writes. It exits 1 when a Session or row is left without an entry.
const [table, functionArn, flag] = process.argv.slice(2).filter((arg) => arg !== '--');
const region = process.env.AWS_REGION;
if (table === undefined || functionArn === undefined || region === undefined || (flag !== undefined && flag !== '--apply')) {
  throw new Error('Usage: AWS_REGION=<region> backfill-activity.ts <table> <session API function ARN> [--apply]');
}
const apply = flag === '--apply';
const client = new DynamoDBClient({ region });
if (apply) {
  const { BackupDetails } = await client.send(
    new CreateBackupCommand({ TableName: table, BackupName: `${table}-activity-backfill-${Date.now()}` }),
  );
  console.log(`Backed up ${table}: ${BackupDetails?.BackupArn}`);
}
const report = await backfillActivity(new DynamoDBSessionMetadata(table, client), sessionApi({ functionArn, region }), { apply });
console.log(JSON.stringify(report, null, 2));
if (report.failed.length > 0 || report.unfilled.length > 0) process.exitCode = 1;
