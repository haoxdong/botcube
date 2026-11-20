import type { AgentCoreApplication } from '@aws/agentcore-cdk';
import type { Stack } from 'aws-cdk-lib';
import type * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { HarnessAuth, ModelsDeployment, RuntimeTelemetry } from '../../../../deployment-config/seams.js' with {
  'resolution-mode': 'import',
};

const RUNTIME_REMOVED_ACTION =
  /^(bedrock-agentcore:.*Memory.*|bedrock-agentcore:(GetEvent|ListActors|ListEvents|ListSessions|CreateEvent|DeleteEvent|.*ConfigurationBundle.*)|logs:(GetLogEvents|FilterLogEvents|PutResourcePolicy))$/i;

/** Bedrock model invocation, which a Runtime whose models run elsewhere does not keep. */
const BEDROCK_MODEL_ACTION = /^bedrock:(InvokeModel|InvokeModelWithResponseStream|CountTokens)$/i;
const XRAY_ACTION = /^xray:(PutTraceSegments|PutTelemetryRecords)$/i;

/**
 * The Runtime role keeps no Memory access: a Turn reaches Memory only with its tagged credentials (ADR 0067 §8).
 * Nor does it keep Bedrock's models when the Deployment Config puts them elsewhere, or X-Ray, which `@aws/agentcore-cdk`
 * always grants, when its telemetry is `none`.
 */
function restrictRuntimePolicy(
  stack: Stack,
  role: iam.IRole,
  models: ModelsDeployment | undefined,
  telemetry: RuntimeTelemetry | undefined
): void {
  if (!(role instanceof iam.Role)) return;
  const policy = role.node.findChild('DefaultPolicy').node.defaultChild;
  if (!(policy instanceof iam.CfnPolicy)) throw new Error('Runtime DefaultPolicy must be an IAM CfnPolicy');
  const document = policyDocument(stack.resolve(policy.policyDocument), policy.node.path);
  policy.policyDocument = {
    ...document,
    Statement: document.Statement.flatMap(statement => {
      const actions = [statement.Action]
        .flat()
        .filter((action): action is string => typeof action === 'string')
        .filter(
          action =>
            !RUNTIME_REMOVED_ACTION.test(action) &&
            !(models && BEDROCK_MODEL_ACTION.test(action)) &&
            !(telemetry?.kind === 'none' && XRAY_ACTION.test(action))
        );
      return actions.length ? [{ ...statement, Action: actions.length === 1 ? actions[0] : actions }] : [];
    }),
  };
}

/**
 * The Runtime admits only bearer tokens for one of the Trust's clients (AgentCore's inbound JWT authorizer): under
 * `botcube`, the Chat Service's tokens for one of their audiences; under an outside issuer, its tokens whose
 * `client_id` is one of them, so its other clients can't call the Harness.
 */
function jwtAuthorizer(
  { issuer, clients }: Extract<HarnessAuth, { kind: 'jwt-bearer' }>,
  chatServiceIssuer: string | undefined
): bedrockagentcore.CfnRuntime.AuthorizerConfigurationProperty {
  const clientIds = clients.map(({ clientId }) => clientId);
  return {
    customJwtAuthorizer:
      issuer === 'botcube'
        ? { discoveryUrl: chatServiceDiscoveryUrl(chatServiceIssuer), allowedAudience: clientIds }
        : { discoveryUrl: issuer, allowedClients: clientIds },
  };
}

function chatServiceDiscoveryUrl(chatServiceIssuer: string | undefined): string {
  if (chatServiceIssuer === undefined) throw new Error('A JWT bearer Harness auth needs the Chat Service issuer');
  return `${chatServiceIssuer}/.well-known/openid-configuration`;
}

type AgentCoreRuntime =
  ReturnType<AgentCoreApplication['environments']['values']> extends Iterator<infer E>
    ? E extends { runtime: infer R }
      ? R
      : never
    : never;
/**
 * The Deployment Config's wiring on one Runtime: where its models run, who may invoke it, and the secret its proxy
 * credential is read from. Absent, `harnessAuth` is
 * SigV4; a JWT bearer is checked against its issuer's OIDC discovery, the Chat Service's at `chatServiceIssuer` under
 * `botcube`, whatever the Turn credentials adapter.
 */
export function applyDeploymentSeams(
  stack: Stack,
  runtime: AgentCoreRuntime,
  cfnRuntime: bedrockagentcore.CfnRuntime,
  props: {
    models?: ModelsDeployment | undefined;
    harnessAuth?: HarnessAuth | undefined;
    chatServiceIssuer?: string | undefined;
    telemetry?: RuntimeTelemetry | undefined;
  }
): void {
  if (props.harnessAuth?.kind === 'jwt-bearer')
    cfnRuntime.authorizerConfiguration = jwtAuthorizer(props.harnessAuth, props.chatServiceIssuer);
  restrictRuntimePolicy(stack, runtime.role, props.models, props.telemetry);
}

/**
 * Encrypt each image repository with a supplied key, which carries its own grants. `@aws/agentcore-cdk` always creates
 * the repository's own key and grants it in the Runtime role's (already resolved) policy, so the key and its grants go.
 */
export function useSuppliedImageKey(stack: Stack, keyArn: string): void {
  const repositories = stack.node
    .findAll()
    .filter((child): child is ecr.CfnRepository => child instanceof ecr.CfnRepository);
  for (const repository of repositories) {
    const owner = repository.node.scope?.node.scope;
    const key = owner?.node.tryFindChild('EncryptionKey');
    if (!owner || !(key instanceof kms.Key))
      throw new Error(`Image repository ${repository.node.path} has no key of its own to replace`);
    const created = JSON.stringify(stack.resolve(key.keyArn));
    repository.encryptionConfiguration = { encryptionType: 'KMS', kmsKey: keyArn };
    for (const policy of stack.node
      .findAll()
      .filter((child): child is iam.CfnPolicy => child instanceof iam.CfnPolicy)) {
      const document: unknown = stack.resolve(policy.policyDocument);
      if (JSON.stringify(document).includes(created))
        policy.policyDocument = withoutResource(policyDocument(document, policy.node.path), created);
    }
    owner.node.tryRemoveChild('EncryptionKey');
  }
}

interface PolicyDocument {
  Statement: Record<string, unknown>[];
}

function policyDocument(document: unknown, path: string): PolicyDocument {
  if (
    typeof document === 'object' &&
    document !== null &&
    'Statement' in document &&
    Array.isArray(document.Statement) &&
    document.Statement.every(
      (statement): statement is Record<string, unknown> => typeof statement === 'object' && statement !== null
    )
  ) {
    return { ...document, Statement: document.Statement };
  }
  throw new Error(`${path}: its policy document has no Statement list`);
}

/** The document with `resource` (as resolved JSON) taken out of every statement, and a statement left with none dropped. */
function withoutResource(document: PolicyDocument, resource: string): PolicyDocument {
  const Statement = document.Statement.flatMap(statement => {
    const resources = [statement.Resource].flat();
    if (!resources.some(each => JSON.stringify(each) === resource)) return [statement];
    const kept = resources.filter(each => JSON.stringify(each) !== resource);
    return kept.length ? [{ ...statement, Resource: kept.length === 1 ? kept[0] : kept }] : [];
  });
  return { ...document, Statement };
}
