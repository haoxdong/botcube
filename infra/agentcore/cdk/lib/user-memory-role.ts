import type { AgentCoreApplication } from '@aws/agentcore-cdk';
import { CfnOutput, Duration, type Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { TokenAudiences } from '../../../../config/seams.js' with { 'resolution-mode': 'import' };

/** The audience of the Chat Service's per-Turn JWT. */
const TURN_IDENTITY_AUDIENCE: TokenAudiences['turnIdentity'] = 'sts.amazonaws.com';

/**
 * The Memory role each Turn's credentials come from (ADR 0067 §8). With `issuer`, the Chat Service's public origin
 * registered as an IAM OIDC provider, the Harness assumes it with the per-Turn JWT (`web-identity`). With
 * `assume-role`, the Chat Service assumes it with a session policy, so the role trusts only the Chat Service's task
 * role, named `chatServiceTaskRole`, and holds no tags.
 */
export type UserMemoryRole = { roleName: string } & (
  { issuer: string } | { awsAccess: 'assume-role'; chatServiceTaskRole: string }
);

/** The Memory role each Turn's credentials come from (ADR 0067 §8), by the Turn credentials adapter. */
export function addUserMemoryRole(
  stack: Stack,
  application: AgentCoreApplication,
  memoryArn: string,
  config: UserMemoryRole
): void {
  if ('issuer' in config) webIdentityMemoryRole(stack, application, memoryArn, config);
  else assumedMemoryRole(stack, memoryArn, config);
}

/**
 * The role a Turn's JWT turns into Memory credentials for one user (ADR 0067 §8). The Chat Service
 * tags each JWT with the Turn's actor, the Session's filing actor, the Session and its writes prefix.
 */
function webIdentityMemoryRole(
  stack: Stack,
  application: AgentCoreApplication,
  memoryArn: string,
  config: { issuer: string; roleName: string }
): void {
  const issuer = URL.canParse(config.issuer) ? new URL(config.issuer) : undefined;
  if (issuer?.protocol !== 'https:' || issuer.port || issuer.origin !== config.issuer) {
    throw new Error('The Memory role issuer must be an https origin without a port');
  }
  const provider = new iam.OidcProviderNative(stack, 'TurnIdentityProvider', {
    url: config.issuer,
    clientIds: [TURN_IDENTITY_AUDIENCE],
  });
  const role = new iam.Role(stack, 'UserMemoryRole', {
    roleName: config.roleName,
    maxSessionDuration: Duration.hours(1),
    assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
      StringEquals: { [`${issuer.host}:aud`]: TURN_IDENTITY_AUDIENCE },
    }).withSessionTags(),
  });
  const tag = (key: string) => `\${aws:PrincipalTag/${key}}`;
  const events = ['CreateEvent', 'GetEvent', 'ListEvents', 'DeleteEvent'].map(action => `bedrock-agentcore:${action}`);
  const statements = [
    // The Session's own checkpoints, and their writes sessions, under its filing ID.
    new iam.PolicyStatement({
      sid: 'SessionUnderFilingId',
      actions: events,
      conditions: {
        StringEquals: { 'bedrock-agentcore:actorId': tag('filingActorId') },
        StringLike: { 'bedrock-agentcore:sessionId': [tag('sessionId'), `${tag('writesPrefix')}-*`] },
      },
    }),
    new iam.PolicyStatement({
      sid: 'OwnActorEvents',
      actions: events,
      conditions: { StringEquals: { 'bedrock-agentcore:actorId': tag('actorId') } },
    }),
    new iam.PolicyStatement({
      sid: 'OwnRecords',
      actions: ['bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:RetrieveMemoryRecords'],
      conditions: { StringLike: { 'bedrock-agentcore:namespace': `/actors/${tag('actorId')}/*` } },
    }),
    new iam.PolicyStatement({
      sid: 'OwnRecordHierarchies',
      actions: ['bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:RetrieveMemoryRecords'],
      conditions: { StringLike: { 'bedrock-agentcore:namespacePath': `/actors/${tag('actorId')}/*` } },
    }),
    // Unconditioned (ADR 0031), though both evaluate bedrock-agentcore:namespace from the request's namespace, checked live.
    // Scoping this to /actors/<actorId>/* is possible now that the Harness names each record's namespace.
    new iam.PolicyStatement({
      sid: 'RecordsById',
      actions: ['bedrock-agentcore:GetMemoryRecord', 'bedrock-agentcore:DeleteMemoryRecord'],
    }),
  ];
  for (const statement of statements) {
    statement.addResources(memoryArn);
    role.addToPolicy(statement);
  }
  for (const env of application.environments.values()) {
    env.runtime.addEnvironmentVariable('BOTCUBE_USER_MEMORY_ROLE_ARN', role.roleArn);
  }
  new CfnOutput(stack, 'UserMemoryRoleArn', { value: role.roleArn });
}

/**
 * The role the Chat Service assumes for each Turn (the `assume-role` adapter). The role grants the
 * Memory's event and record actions; each Turn's session policy narrows them to its own actor, Session and records.
 * Only the Chat Service's task role can assume it.
 */
function assumedMemoryRole(
  stack: Stack,
  memoryArn: string,
  { roleName, chatServiceTaskRole }: { roleName: string; chatServiceTaskRole: string }
): void {
  const taskRoleArn = stack.formatArn({
    service: 'iam',
    region: '',
    resource: 'role',
    resourceName: chatServiceTaskRole,
  });
  const role = new iam.Role(stack, 'UserMemoryRole', {
    roleName,
    maxSessionDuration: Duration.hours(1),
    // IAM refuses a trust policy whose principal role does not exist yet, and this stack deploys before the Chat
    // Service's; matching the principal's ARN also survives the task role being replaced.
    assumedBy: new iam.AccountRootPrincipal().withConditions({ ArnEquals: { 'aws:PrincipalArn': taskRoleArn } }),
  });
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: [
        'CreateEvent',
        'GetEvent',
        'ListEvents',
        'DeleteEvent',
        'ListMemoryRecords',
        'RetrieveMemoryRecords',
        'GetMemoryRecord',
        'DeleteMemoryRecord',
      ].map(action => `bedrock-agentcore:${action}`),
      resources: [memoryArn],
    })
  );
  new CfnOutput(stack, 'UserMemoryRoleArn', { value: role.roleArn });
}
