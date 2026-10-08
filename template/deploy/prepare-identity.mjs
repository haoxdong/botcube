import { format } from 'prettier';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const identity = read('identity.json');
if (typeof identity.name !== 'string' || !/^[A-Za-z][A-Za-z0-9]*(?:[ -][A-Za-z0-9]+)*$/.test(identity.name)) {
  throw new Error('Bot name must start with a letter and contain only words separated by spaces or hyphens.');
}
if (typeof identity.avatar !== 'string' || !identity.avatar || !identity.theme || typeof identity.theme !== 'object' || Array.isArray(identity.theme)) {
  throw new Error('Template identity requires an avatar and theme object.');
}
const kebab = identity.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[ -]+/g, '-').toLowerCase();
const underscore = kebab.replaceAll('-', '_');
const upper = underscore.toUpperCase();
const deployment = read('deploy/identity.json');
const nameFields =
{
  "aws.cloudFormation.stackFamily": "botcube",
  "aws.agentCore.runtime": "botcube_runtime",
  "aws.agentCore.runtimeNetworkParameter": "/botcube/agentcore/security-group-id",
  "aws.agentCore.memory": "botcube_memory",
  "aws.agentCore.sessionApiFunction": "botcube-session-api",
  "aws.agentCore.agentComputerBrowser.name": "botcube_agent_computer_managed",
  "aws.agentCore.agentComputerBrowser.profileNamePrefix": "botcube_",
  "aws.agentCore.privateNatBrowser.name": "botcube_provider_link",
  "aws.agentCore.privateNatBrowser.extension.prefix": "botcube/browser-extensions/provider-user-agent/v2.zip",
  "aws.ecs.privateNamespace": "botcube.internal",
  "aws.ecs.chatService.planUsageOwnerAccountParameter": "/botcube/plan-usage/owner-account-id",
  "aws.ecs.chatService.environmentKeys.filesBucket": "BOTCUBE_FILES_BUCKET",
  "aws.ecs.chatService.environmentKeys.filesFileSystemArn": "BOTCUBE_FILES_FILE_SYSTEM_ARN",
  "aws.ecs.chatService.environmentKeys.agentComputerPolicyBucket": "BOTCUBE_AGENT_COMPUTER_POLICY_S3_BUCKET",
  "aws.ecs.chatService.environmentKeys.agentComputerPolicyKey": "BOTCUBE_AGENT_COMPUTER_POLICY_S3_KEY",
  "aws.ecs.chatService.environmentKeys.filesSyncRoleArn": "BOTCUBE_FILES_SYNC_ROLE_ARN",
  "aws.ecs.cluster": "botcube",
  "aws.ecs.deployRoleName": "botcube-ecs-github-deploy",
  "aws.ecs.originPullClientSecretName": "/botcube/cloudflare/origin-pull-client",
  "aws.ecs.originTokenSecretName": "/botcube/cloudflare/origin-api-token",
  "aws.ecs.previewOriginStackName": "botcube-preview-origin",
  "aws.ecs.privateEgress.stackName": "botcube-private-egress",
  "aws.ecs.privateEgress.natGateway.name": "botcube-private-egress",
  "aws.ecs.apiHealth.stackName": "botcube-api-health",
  "aws.ecs.apiHealth.alarmName": "botcube-api-health",
  "aws.ecs.webLatency.stackName": "botcube-web-latency",
  "aws.ecs.webLatency.appMonitorName": "botcube-web",
  "aws.ecs.alertsTopicName": "botcube-alerts",
  "aws.ecr.repository": "botcube/runtime",
  "aws.codeBuild.project": "botcube-container-builder",
  "aws.lambda.family": "botcube-container-build-handler",
  "aws.cloudWatch.logGroup": "/aws/lambda/botcube-container-build-handler",
  "aws.iam.deployUser": "botcube-deploy",
  "aws.iam.runtimeRole": "botcube-runtime",
  "aws.iam.memoryRole": "botcube-memory",
  "aws.iam.lambdaRole": "botcube-container-build-handler",
  "aws.iam.codeBuildRole": "botcube-container-build",
  "aws.iam.sessionApiRole": "botcube-session-api",
  "aws.iam.invokePolicyFamily": "botcube-agentcore-invoke",
  "ssm.runtimeArn": "/botcube/agentcore/runtime-arn",
  "ssm.parkState": "/botcube/production/park-state",
  "github.environment": "botcube-production",
  "github.variables.ecsDeployRoleArn": "BOTCUBE_ECS_DEPLOY_ROLE_ARN"
};
// Runtime variable names belong to the Cartridge protocol, not its display name.
const runtimeFields = {
  "aws.ecs.credentialService.rpcPath": "",
  "aws.ecs.credentialService.environmentKeys.url": "TEMPLATE_CREDENTIAL_SERVICE_URL",
  "aws.ecs.credentialService.environmentKeys.invocationToken": "BOTCUBE_CREDENTIAL_INVOCATION_SECRET",
  "aws.ecs.credentialService.environmentKeys.port": "PORT",
  "aws.ecs.credentialService.environmentKeys.keyId": "BOTCUBE_VAULT_KMS_KEY_ID",
  "aws.ecs.credentialService.environmentKeys.vaultTable": "BOTCUBE_VAULT_TABLE",
  "aws.ecs.credentialService.environmentKeys.legacyVaultTable": "BOTCUBE_LEGACY_VAULT_TABLE",
  "aws.ecs.chatService.environmentKeys.planUsageOwnerAccountId": "BOTCUBE_PLAN_USAGE_OWNER_ACCOUNT_ID",
  "aws.ecs.chatService.environmentKeys.agentComputerCdpUrl": "TEMPLATE_COMPUTER_CDP_URL"
};
for (const [path, pattern] of Object.entries({ ...nameFields, ...runtimeFields })) {
  const parts = path.split('.');
  const key = parts.pop();
  const owner = parts.reduce((value, part) => value[part], deployment);
  owner[key] = path in runtimeFields ? pattern : pattern.replaceAll('BOTCUBE', upper).replace(/botcube(?=_)/g, underscore).replaceAll('botcube', kebab);
}
const agentcore = read('deploy/agentcore/agentcore.json');
agentcore.name = underscore.replaceAll('_', '');
agentcore.tags['agentcore:project-name'] = kebab;
for (const runtime of agentcore.runtimes) runtime.name = underscore;
for (const memory of agentcore.memories) memory.name = underscore;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const outputs = {
  'identity.ts': `export const TEMPLATE_IDENTITY = ${JSON.stringify(identity, null, 2)} as const;\n`,
  'src/botcube_template/identity.json': json(identity),
  'deploy/identity.json': json(deployment),
  'deploy/agentcore/agentcore.json': json(agentcore),
  'deploy/agentcore/aws-targets.json': json([{ name: 'template', account: deployment.aws.account, region: deployment.aws.region }]),
};
for (const [path, source] of Object.entries(outputs)) {
  const contents = await format(source, { parser: path.endsWith('.ts') ? 'typescript' : 'json', singleQuote: true, trailingComma: 'es5', printWidth: 80 });
  if (process.argv.includes('--check')) {
    if (readFileSync(join(root, path), 'utf8') !== contents) throw new Error(`Stale template identity output ${path}. Run node template/deploy/prepare-identity.mjs from the BotCube repository root.`);
  } else {
    writeFileSync(join(root, path), contents);
  }
}
