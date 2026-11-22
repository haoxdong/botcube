import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployRootFile } from '../../config/read.cjs';

const identity = deployRootFile(process.env.BOTCUBE_DEPLOY_ROOT, 'identity.json');
const { account, region, ecs } = identity.aws;
const [mode, source] = process.argv.slice(2);
if (!['deploy', 'rollback'].includes(mode) || !source) throw new Error('Usage: managed-deploy-policies.mjs deploy|rollback POLICY_JSON');
const directory = mkdtempSync(join(tmpdir(), 'deploy-managed-policies-'));
try {
  migrate(JSON.parse(readFileSync(source, 'utf8')));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function aws(service, operation, ...args) {
  const result = spawnSync('aws', [service, operation, ...args, '--region', region, '--output', 'json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `aws ${service} ${operation} failed`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function migrate(document) {
  const inline = aws('iam', 'list-role-policies', '--role-name', ecs.deployRoleName).PolicyNames;
  const attached = aws('iam', 'list-attached-role-policies', '--role-name', ecs.deployRoleName).AttachedPolicies;
  const core = mode === 'deploy';
  const plans = [{ name: core ? ecs.deployPolicyName : ecs.rollbackPolicyName,
    documents: core ? deployGroups(document) : { Rollback: document } }];
  if (core && (inline.includes(ecs.rollbackPolicyName) || attached.some(policy => policy.PolicyName === `${ecs.rollbackPolicyName}-rollback`))) {
    const rollback = join(directory, 'rollback.json');
    const result = spawnSync('bash', [join(dirname(fileURLToPath(import.meta.url)), 'bootstrap-rollback-role.sh'), '--policy-file', rollback], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'Rollback policy rendering failed');
    plans.push({ name: ecs.rollbackPolicyName, documents: { Rollback: JSON.parse(readFileSync(rollback, 'utf8')) } });
  }
  for (const plan of plans) checkHeadroom(plan.documents);
  const statements = plans.flatMap(plan => Object.values(plan.documents).flatMap(policy => policy.Statement));
  const legacy = core ? inline : inline.filter(name => name === ecs.rollbackPolicyName);
  checkLegacy(legacy, statements);
  const wanted = plans.flatMap(plan => Object.keys(plan.documents).map(group => policyArn(plan.name, group)));
  const quota = aws('iam', 'get-account-summary').SummaryMap.AttachedPoliciesPerRoleQuota;
  if (!Number.isInteger(quota) || new Set([...attached.map(policy => policy.PolicyArn), ...wanted]).size > quota) throw new Error('Managed policy attachment quota exceeded');
  for (const plan of plans) deploy(plan);
  const actual = aws('iam', 'list-attached-role-policies', '--role-name', ecs.deployRoleName).AttachedPolicies.map(policy => policy.PolicyArn);
  for (const plan of plans) verify(plan, actual);
  const current = aws('iam', 'list-role-policies', '--role-name', ecs.deployRoleName).PolicyNames;
  const retire = core ? current : current.filter(name => name === ecs.rollbackPolicyName);
  checkLegacy(retire, statements);
  for (const name of retire) aws('iam', 'delete-role-policy', '--role-name', ecs.deployRoleName, '--policy-name', name);
}

function deployGroups(document) {
  const services = {
    Deployment: ['ecs', 'cloudformation', 'sts', 'ecr-public', 'iam', 'events', 's3'],
    Verification: ['ssm', 'bedrock-agentcore', 'route53', 'sns', 'ec2', 'dynamodb', 'elasticloadbalancing', 'logs', 'secretsmanager'],
    Parking: ['states', 'lambda', 'application-autoscaling', 'cloudwatch'],
  };
  const groups = Object.fromEntries(Object.keys(services).map(group => [group, { Version: document.Version, Statement: [] }]));
  for (const statement of document.Statement) {
    const service = [statement.Action].flat()[0].split(':')[0];
    const group = Object.keys(services).find(name => services[name].includes(service));
    if (!group) throw new Error(`No managed policy group for ${service}`);
    groups[group].Statement.push(statement);
  }
  return groups;
}

function checkHeadroom(documents) {
  for (const [group, policy] of Object.entries(documents)) {
    if (JSON.stringify(policy).length > 6144 - 2000) throw new Error(`${group} policy has less than 2000 characters of headroom`);
  }
}

function checkLegacy(names, statements) {
  for (const name of names) {
    const policy = aws('iam', 'get-role-policy', '--role-name', ecs.deployRoleName, '--policy-name', name).PolicyDocument;
    if (!policy.Statement.every(statement => covered(statement, statements))) throw new Error(`Inline policy ${name} has grants not represented in code`);
  }
}

function covered(statement, grants) {
  if (statement.Effect !== 'Allow' || Object.keys(statement).some(key => !['Effect', 'Action', 'Resource', 'Condition', 'Sid'].includes(key))) return false;
  return [statement.Action].flat().every(action => [statement.Resource].flat().every(resource => grants.some(grant =>
    grant.Effect === 'Allow' && [grant.Action].flat().includes(action)
    && ([grant.Resource].flat().includes('*') || [grant.Resource].flat().includes(resource))
    && (!grant.Condition || canonical(grant.Condition) === canonical(statement.Condition)))));
}

function canonical(value) {
  return JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

function policyArn(name, group) {
  return `arn:aws:iam::${account}:policy/${name}-${group.toLowerCase()}`;
}

function deploy(plan) {
  const resources = Object.fromEntries(Object.entries(plan.documents).map(([group, policy]) => [group, {
    Type: 'AWS::IAM::ManagedPolicy', Properties: {
      ManagedPolicyName: `${plan.name}-${group.toLowerCase()}`, Roles: [ecs.deployRoleName], PolicyDocument: policy,
    },
  }]));
  const template = join(directory, `${plan.name}.json`);
  writeFileSync(template, JSON.stringify({ AWSTemplateFormatVersion: '2010-09-09', Resources: resources }));
  const result = spawnSync('aws', ['cloudformation', 'deploy', '--stack-name', `${plan.name}-policies`, '--template-file', template,
    '--capabilities', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset', '--region', region], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Managed policy stack deployment failed');
}

function verify(plan, attached) {
  for (const [group, document] of Object.entries(plan.documents)) {
    const arn = policyArn(plan.name, group);
    if (!attached.includes(arn)) throw new Error(`Managed policy was not attached: ${arn}`);
    const version = aws('iam', 'get-policy', '--policy-arn', arn).Policy.DefaultVersionId;
    const actual = aws('iam', 'get-policy-version', '--policy-arn', arn, '--version-id', version).PolicyVersion.Document;
    if (canonical(actual) !== canonical(document)) throw new Error(`Managed policy readback differs: ${arn}`);
  }
}
