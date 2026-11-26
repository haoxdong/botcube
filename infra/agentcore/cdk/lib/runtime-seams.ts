import { publishConfig } from 'botcube-infra-agentcore-cdk/config-publisher';
import type { AgentCoreApplication } from '@aws/agentcore-cdk';
import { createHash } from 'node:crypto';
import { ArnFormat, CfnResource, RemovalPolicy, type Stack } from 'aws-cdk-lib';
import type { DeployConfig } from './deploy-config';
import { TURN_IDENTITY_AUDIENCE } from './user-memory-role';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { HarnessAuth, ModelsDeployment, RuntimeTelemetry } from '../../../../config/seams.js' with {
  'resolution-mode': 'import',
};

const RUNTIME_REMOVED_ACTION =
  /^(bedrock-agentcore:.*Memory.*|bedrock-agentcore:(GetEvent|ListActors|ListEvents|ListSessions|CreateEvent|DeleteEvent|.*ConfigurationBundle.*)|logs:(GetLogEvents|FilterLogEvents|PutResourcePolicy))$/i;

/** Bedrock model invocation, which a Runtime whose models run elsewhere does not keep. */
const BEDROCK_MODEL_ACTION = /^bedrock:(InvokeModel|InvokeModelWithResponseStream|CountTokens)$/i;
const XRAY_ACTION = /^xray:(PutTraceSegments|PutTelemetryRecords)$/i;

/**
 * The Runtime role keeps no Memory access: a Turn reaches Memory only with its tagged credentials (ADR 0067 §8).
 * Nor does it keep Bedrock's models when the BotCube Config puts them elsewhere, or X-Ray, which `@aws/agentcore-cdk`
 * always grants, unless the deployment selects X-Ray (the default).
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
            !(telemetry && telemetry.kind !== 'xray' && XRAY_ACTION.test(action))
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
export function publishRuntimeConfig(
  stack: Stack,
  runtimes: readonly { runtime: AgentCoreRuntime }[],
  { botcubeConfigPath, executionRole }: { botcubeConfigPath?: string | undefined; executionRole?: iam.IRole },
  connectorGatewayUrl?: string
): void {
  if (botcubeConfigPath === undefined || runtimes.length === 0) return;
  const published = publishConfig(stack, botcubeConfigPath, connectorGatewayUrl);
  for (const { runtime } of runtimes) {
    const definition = runtime.node.defaultChild;
    if (!(definition instanceof bedrockagentcore.CfnRuntime))
      throw new Error('Config readers need an AgentCore Runtime definition');
    runtime.addEnvironmentVariable('BOTCUBE_CONFIG', published.locator);
    published.grantRead(executionRole ?? runtime.role, definition);
  }
}

export type DeployedResources = Record<string, { Type: string; Properties?: Record<string, unknown> }>;

export function addConnectorGateway(
  stack: Stack,
  {
    connectors = [],
    signIn,
    chatServiceIssuer,
    deployedResources = {},
  }: Pick<DeployConfig, 'connectors' | 'signIn'> & { chatServiceIssuer?: string; deployedResources?: DeployedResources }
): string {
  if (!chatServiceIssuer) throw new Error('Connectors need the Chat Service issuer');
  const deploymentId = createHash('sha256').update(stack.stackName).digest('hex').slice(0, 16);
  const name = `connectors-${deploymentId}`;
  const resourcePrefix = `${stack.stackName.toLowerCase()}/connectors/`;
  const role = new iam.Role(stack, 'ConnectorGatewayRole', {
    assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
      conditions: {
        StringEquals: { 'aws:SourceAccount': stack.account },
        ArnLike: {
          'aws:SourceArn': stack.formatArn({
            service: 'bedrock-agentcore',
            resource: 'gateway',
            resourceName: `${name}-*`,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        },
      },
    }),
  });
  const customJwtAuthorizer =
    signIn?.kind === 'oidc'
      ? {
          discoveryUrl: `${signIn.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
          allowedClients: signIn.clients.map(client => client.clientId),
        }
      : {
          discoveryUrl: `${chatServiceIssuer}/.well-known/openid-configuration`,
          allowedAudience: [TURN_IDENTITY_AUDIENCE],
        };
  const gateway = new bedrockagentcore.CfnGateway(stack, 'ConnectorGateway', {
    name,
    roleArn: role.roleArn,
    authorizerType: 'CUSTOM_JWT',
    authorizerConfiguration: { customJwtAuthorizer },
    protocolType: 'MCP',
    protocolConfiguration: { mcp: { supportedVersions: ['2025-03-26', '2025-06-18', '2025-11-25'] } },
  });
  const identityArn = (resource: string) => stack.formatArn({ service: 'bedrock-agentcore', resource });
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:GetWorkloadAccessToken',
        'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
        'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
        'bedrock-agentcore:GetApiKeyCredential',
        'bedrock-agentcore:GetResourceApiKey',
        'bedrock-agentcore:GetResourceOauth2Token',
      ],
      resources: [
        identityArn(`token-vault/default/apikeycredentialprovider/${name}-*`),
        identityArn(`token-vault/default/oauth2credentialprovider/${name}-*`),
        identityArn('token-vault/default'),
        identityArn('workload-identity-directory/default'),
        identityArn(`workload-identity-directory/default/workload-identity/${gateway.attrGatewayIdentifier}`),
      ],
    })
  );
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        stack.formatArn({
          service: 'secretsmanager',
          resource: 'secret',
          resourceName: `${resourcePrefix}*`,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    })
  );
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [stack.formatArn({ service: 's3', region: '', account: '', resource: `*/${resourcePrefix}*` })],
      conditions: { StringEquals: { 's3:ResourceAccount': stack.account } },
    })
  );
  for (const connector of connectors) {
    validateConnectorResourceNames(stack, connector, resourcePrefix);
    const credential = connectorCredential(stack, connector, name);
    const target = new bedrockagentcore.CfnGatewayTarget(stack, `ConnectorTarget-${connector.name}`, {
      name: connector.name,
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      targetConfiguration: { mcp: connectorTarget(connector) },
      ...(credential && { credentialProviderConfigurations: [credential] }),
    });
    target.node.addDependency(role.node.findChild('DefaultPolicy'));
  }
  retainConnectorProviders(stack, name, deployedResources);
  return gateway.attrGatewayUrl;
}

function validateConnectorResourceNames(
  stack: Stack,
  connector: NonNullable<DeployConfig['connectors']>[number],
  resourcePrefix: string
): void {
  const { access } = connector;
  if (access.kind !== 'none') {
    const { secretId } = access.kind === 'api-key' ? access.credential : access.oauthClient.clientSecret;
    const secretName = secretId.startsWith('arn:')
      ? stack.splitArn(secretId, ArnFormat.COLON_RESOURCE_NAME).resourceName
      : secretId;
    if (!secretName?.startsWith(resourcePrefix)) {
      throw new Error(`Connector ${connector.name}: secret name must start with ${resourcePrefix}`);
    }
  }
  const s3 =
    'openApi' in connector
      ? connector.openApi
      : connector.toolSchema && 's3' in connector.toolSchema
        ? connector.toolSchema.s3.uri
        : undefined;
  if (s3 && !s3.slice(s3.indexOf('/', 5) + 1).startsWith(resourcePrefix)) {
    throw new Error(`Connector ${connector.name}: S3 object key must start with ${resourcePrefix}`);
  }
}

function connectorTarget(
  connector: NonNullable<DeployConfig['connectors']>[number]
): bedrockagentcore.CfnGatewayTarget.McpTargetConfigurationProperty {
  if ('openApi' in connector) return { openApiSchema: { s3: { uri: connector.openApi } } };
  const { url, toolSchema, access } = connector;
  const schema =
    toolSchema && 's3' in toolSchema
      ? {
          s3: {
            uri: toolSchema.s3.uri,
            ...(toolSchema.s3.bucketOwnerAccountId && { bucketOwnerAccountId: toolSchema.s3.bucketOwnerAccountId }),
          },
        }
      : toolSchema;
  return {
    mcpServer: {
      endpoint: url,
      ...(schema && { mcpToolSchema: schema }),
      ...(access.kind === 'on-behalf-of' && { listingMode: 'DYNAMIC' }),
    },
  };
}

function retainConnectorProviders(stack: Stack, name: string, deployedResources: DeployedResources): void {
  const configuredIds = new Set(
    stack.node.children
      .filter(
        (child): child is CfnResource => child instanceof CfnResource && child.node.id.startsWith('ConnectorProvider-')
      )
      .map(resource => stack.getLogicalId(resource))
  );
  for (const [logicalId, { Type, Properties }] of Object.entries(deployedResources)) {
    if (configuredIds.has(logicalId) || !logicalId.startsWith('ConnectorProvider')) continue;
    if (
      Type !== bedrockagentcore.CfnApiKeyCredentialProvider.CFN_RESOURCE_TYPE_NAME &&
      Type !== bedrockagentcore.CfnOAuth2CredentialProvider.CFN_RESOURCE_TYPE_NAME
    )
      continue;
    if (typeof Properties?.Name !== 'string' || !Properties.Name.startsWith(`${name}-`)) continue;
    const provider = new CfnResource(stack, `Retained${logicalId}`, { type: Type, properties: Properties });
    provider.overrideLogicalId(logicalId);
    provider.applyRemovalPolicy(RemovalPolicy.RETAIN);
  }
}

function connectorCredential(
  stack: Stack,
  connector: NonNullable<DeployConfig['connectors']>[number],
  gatewayName: string
) {
  const { access } = connector;
  if (access.kind === 'none') return undefined;
  const name = `${gatewayName}-${connector.name}`;
  if (access.kind === 'api-key') {
    const provider = new bedrockagentcore.CfnApiKeyCredentialProvider(stack, `ConnectorProvider-${connector.name}`, {
      name,
      apiKeySecretSource: 'EXTERNAL',
      apiKeySecretConfig: { secretId: access.credential.secretId, jsonKey: 'apiKey' },
    });
    provider.applyRemovalPolicy(RemovalPolicy.RETAIN);
    return {
      credentialProviderType: 'API_KEY',
      credentialProvider: {
        apiKeyCredentialProvider: {
          providerArn: provider.attrCredentialProviderArn,
          credentialLocation: 'HEADER',
          credentialParameterName: access.header,
        },
      },
    };
  }
  const { clientId, clientSecret, discoveryUrl, scopes } = access.oauthClient;
  const provider = new bedrockagentcore.CfnOAuth2CredentialProvider(stack, `ConnectorProvider-${connector.name}`, {
    name,
    credentialProviderVendor: 'CustomOauth2',
    oauth2ProviderConfigInput: {
      customOauth2ProviderConfig: {
        ...(clientId === undefined ? {} : { clientId }),
        clientSecretSource: 'EXTERNAL',
        clientSecretConfig: { secretId: clientSecret.secretId, jsonKey: 'clientSecret' },
        clientAuthenticationMethod: 'CLIENT_SECRET_BASIC',
        oauthDiscovery: { discoveryUrl },
        ...(access.kind === 'on-behalf-of' && {
          onBehalfOfTokenExchangeConfig: { grantType: 'JWT_AUTHORIZATION_GRANT' },
        }),
      },
    },
  });
  provider.applyRemovalPolicy(RemovalPolicy.RETAIN);
  const grantType = {
    'linked-account': 'AUTHORIZATION_CODE',
    'client-credentials': 'CLIENT_CREDENTIALS',
    'on-behalf-of': 'TOKEN_EXCHANGE',
  }[access.kind];
  return {
    credentialProviderType: 'OAUTH',
    credentialProvider: {
      oauthCredentialProvider: { providerArn: provider.attrCredentialProviderArn, grantType, scopes },
    },
  };
}

/**
 * The BotCube Config's wiring on one Runtime: where its models run, who may invoke it, and the secret its proxy
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
 * Encrypt each image repository with a existing key, which carries its own grants. `@aws/agentcore-cdk` always creates
 * the repository's own key and grants it in the Runtime role's (already resolved) policy, so the key and its grants go.
 */
export function useExistingImageKey(stack: Stack, keyArn: string): void {
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
