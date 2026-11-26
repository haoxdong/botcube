const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ArnFormat, RemovalPolicy } = require('aws-cdk-lib');
const { Grant } = require('aws-cdk-lib/aws-iam');
const { BlockPublicAccess, Bucket, BucketEncryption } = require('aws-cdk-lib/aws-s3');
const { BucketDeployment, Source } = require('aws-cdk-lib/aws-s3-deployment');
const { configBucketName } = require('botcube-config/config-bucket');

function publishConfig(stack, configPath, connectorGatewayUrl) {
  const json = execFileSync(process.execPath, [require.resolve('botcube-config/cli'), 'resolve', configPath], {
    encoding: 'utf8',
  });
  const hash = createHash('sha256').update(json);
  if (connectorGatewayUrl !== undefined) hash.update('connector-gateway');
  const digest = hash.digest('hex');
  const filename = `${digest}.json`;
  const source =
    connectorGatewayUrl === undefined
      ? Source.data(filename, json)
      : Source.jsonData(filename, withConnectorGateway(json, connectorGatewayUrl));
  const key = `resolved/${digest}.json`;
  const bucketName = configBucketName(stack.account, stack.region, stack.stackName);
  const bucket = new Bucket(stack, 'BotCubeConfig', {
    bucketName,
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    encryption: BucketEncryption.S3_MANAGED,
    removalPolicy: RemovalPolicy.RETAIN,
    enforceSSL: true,
  });
  const publish = new BucketDeployment(stack, 'PublishBotCubeConfig', {
    destinationBucket: bucket,
    destinationKeyPrefix: 'resolved',
    sources: [source],
    prune: false,
    retainOnDelete: true,
    outputObjectKeys: false,
  });
  return {
    locator: `s3://${bucketName}/${key}`,
    grantRead(role, consumer) {
      // A rollback can start an old revision with the same execution role.
      const grant = Grant.addToPrincipal({
        grantee: role,
        actions: ['s3:GetObject'],
        resourceArns: [
          stack.formatArn({
            service: 's3',
            region: '',
            account: '',
            resource: bucketName,
            resourceName: 'resolved/*',
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      });
      grant.applyBefore(consumer);
      consumer.node.addDependency(publish);
    },
  };
}

function withConnectorGateway(json, url) {
  const resolved = JSON.parse(json);
  resolved.config.integrations.connectorGateway = { url };
  return resolved;
}

module.exports = { publishConfig };
