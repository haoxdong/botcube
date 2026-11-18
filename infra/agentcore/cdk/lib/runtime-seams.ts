import type { AgentCoreApplication } from '@aws/agentcore-cdk';
import type { Stack } from 'aws-cdk-lib';
import type * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { HarnessAuth, ModelsDeployment } from '../../../../deployment-config/seams.js' with {
  'resolution-mode': 'import',
};

const RUNTIME_REMOVED_ACTION =
  /^(bedrock-agentcore:.*Memory.*|bedrock-agentcore:(GetEvent|ListActors|ListEvents|ListSessions|CreateEvent|DeleteEvent|.*ConfigurationBundle.*)|logs:(GetLogEvents|FilterLogEvents|PutResourcePolicy))$/i;

/** Bedrock model invocation, which a Runtime whose models run elsewhere does not keep. */
const BEDROCK_MODEL_ACTION = /^bedrock:(InvokeModel|InvokeModelWithResponseStream|CountTokens)$/i;

/**
 * The Runtime role keeps no Memory access: a Turn reaches Memory only with its tagged credentials (ADR 0067 §8).
 * Nor does it keep Bedrock's models when the Deployment Config puts them elsewhere.
 */
function restrictRuntimePolicy(stack: Stack, role: iam.IRole, models: ModelsDeployment | undefined): void {
  if (!(role instanceof iam.Role)) return;
  const policy = role.node.findChild('DefaultPolicy').node.defaultChild;
  if (!(policy instanceof iam.CfnPolicy)) throw new Error('Runtime DefaultPolicy must be an IAM CfnPolicy');
  const document = stack.resolve(policy.policyDocument) as {
    Version: string;
    Statement: Array<{ Action: string | string[]; Effect: string; [key: string]: unknown }>;
  };
  policy.policyDocument = {
    ...document,
    Statement: document.Statement.flatMap(statement => {
      const actions = [statement.Action]
        .flat()
        .filter(action => !RUNTIME_REMOVED_ACTION.test(action) && !(models && BEDROCK_MODEL_ACTION.test(action)));
      return actions.length ? [{ ...statement, Action: actions.length === 1 ? actions[0] : actions }] : [];
    }),
  };
}

/** The Runtime admits only bearer tokens the Chat Service signs for this audience (AgentCore's inbound JWT authorizer). */
function jwtAuthorizer(
  audience: string,
  issuer: string | undefined
): bedrockagentcore.CfnRuntime.AuthorizerConfigurationProperty {
  if (issuer === undefined) throw new Error('A JWT bearer Harness auth needs the Chat Service issuer');
  return {
    customJwtAuthorizer: { discoveryUrl: `${issuer}/.well-known/openid-configuration`, allowedAudience: [audience] },
  };
}

/** The agent's models run on the Deployment Config's OpenAI-compatible endpoint, its API key read from its secret. */
type AgentCoreRuntime =
  ReturnType<AgentCoreApplication['environments']['values']> extends Iterator<infer E>
    ? E extends { runtime: infer R }
      ? R
      : never
    : never;
function applyModelsEndpoint(runtime: AgentCoreRuntime, models: ModelsDeployment | undefined): void {
  if (!models) return;
  for (const [name, value] of Object.entries(models.environment)) runtime.addEnvironmentVariable(name, value);
  runtime.role.addToPrincipalPolicy(
    new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [models.apiKeySecretArn] })
  );
}

/**
 * The Deployment Config's wiring on one Runtime: where its models run and who may invoke it. Absent, `harnessAuth` is
 * SigV4; a JWT bearer is checked against the Chat Service's OIDC discovery at `chatServiceIssuer`, whatever the Turn
 * credentials adapter.
 */
export function applyDeploymentSeams(
  stack: Stack,
  runtime: AgentCoreRuntime,
  cfnRuntime: bedrockagentcore.CfnRuntime,
  props: {
    models?: ModelsDeployment | undefined;
    harnessAuth?: HarnessAuth | undefined;
    chatServiceIssuer?: string | undefined;
  }
): void {
  applyModelsEndpoint(runtime, props.models);
  if (props.harnessAuth?.kind === 'jwt-bearer')
    cfnRuntime.authorizerConfiguration = jwtAuthorizer(props.harnessAuth.audience, props.chatServiceIssuer);
  restrictRuntimePolicy(stack, runtime.role, props.models);
}

/**
 * Encrypt each image repository with an existing key. `@aws/agentcore-cdk` always creates the repository's own key,
 * so the key is removed, and the repository and the Runtime role's (already resolved) policy name the existing one.
 */
export function useImageKey(stack: Stack, keyArn: string): void {
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
      const document = JSON.stringify(stack.resolve(policy.policyDocument));
      if (document.includes(created))
        policy.policyDocument = JSON.parse(document.split(created).join(JSON.stringify(keyArn)));
    }
    owner.node.tryRemoveChild('EncryptionKey');
  }
}
