import { AgentCoreApplication, type AgentCoreProjectSpec } from '@aws/agentcore-cdk';
import { CfnOutput, Duration, Stack, type CfnResource, type StackProps } from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { applyRuntimeNetwork, type RuntimeNetwork } from './runtime-network';
import { Construct } from 'constructs';

/**
 * Cap (seconds) on a runtime microVM's total lifetime — permanent
 * defense-in-depth per ADR 0029, so no idle-reaping regression can cause an
 * 8 h runaway again. ~1 h; the AgentCore API bound is 60..28800 s.
 */
export const RUNTIME_MAX_LIFETIME_SECONDS = 3600;
/** Idle timeout (seconds) after which an idle runtime microVM is reaped. */
export const RUNTIME_IDLE_TIMEOUT_SECONDS = 900;
/**
 * The session API function's timeout (seconds), Lambda's maximum. A purge deletes
 * events at 5 a second (DeleteEvent's per-Session limit), so this bounds a purge
 * to about 4,500 events; the Chat Service waits as long.
 */
export const SESSION_API_TIMEOUT_SECONDS = 900;
/**
 * Session API environments kept initialized behind its alias, so a page load waits on
 * no 5 s cold start. Sized from the 7 days to 2026-10-04, when 88% of
 * active minutes peaked at 5 or fewer concurrent calls; calls past 5 spill over to
 * on-demand environments. 5 x 1 GB costs $43.20 a month in us-east-1.
 */
export const SESSION_API_PROVISIONED_CONCURRENCY = 5;
/**
 * Where the agent's shell works: the runtime's per-session storage, which survives a
 * microVM stop (ADR 0077). The Harness syncs it with the account's Files on each Turn,
 * because session storage resets on every runtime version update.
 */
export const RUNTIME_WORKSPACE = '/mnt/workspace';
const MEMORY_STRATEGIES_NAMESPACE_PREFIX = '/strategies/';
const RUNTIME_MEMORY_ACTION =
  /^(bedrock-agentcore:.*Memory.*|bedrock-agentcore:(GetEvent|ListActors|ListEvents|ListSessions|CreateEvent|DeleteEvent))$/i;
const RUNTIME_REMOVED_ACTION =
  /^(bedrock-agentcore:.*Memory.*|bedrock-agentcore:(GetEvent|ListActors|ListEvents|ListSessions|CreateEvent|DeleteEvent|.*ConfigurationBundle.*)|logs:(GetLogEvents|FilterLogEvents|PutResourcePolicy))$/i;

function removeInvalidMemoryAlias(runtime: bedrockagentcore.CfnRuntime, generatedAlias: string): void {
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(generatedAlias)) return;
  const variables = { ...(runtime.environmentVariables as Record<string, string>) };
  delete variables[generatedAlias];
  runtime.environmentVariables = variables;
}

function restrictRuntimePolicy(stack: Stack, role: iam.IRole, retainLegacyRuntimeMemory: boolean): void {
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
        .filter(
          action =>
            !RUNTIME_REMOVED_ACTION.test(action) || (retainLegacyRuntimeMemory && RUNTIME_MEMORY_ACTION.test(action))
        );
      return actions.length ? [{ ...statement, Action: actions.length === 1 ? actions[0] : actions }] : [];
    }),
  };
}

/**
 * Set the AgentCore runtime lifecycle cap on the underlying L1.
 *
 * The `@aws/agentcore-cdk` L3 construct never sets `LifecycleConfiguration`, so
 * we set it on the `CfnRuntime` directly. `maxLifetime` bounds total VM lifetime
 * as a backstop; `idleRuntimeSessionTimeout` reaps idle microVMs. See ADR 0029.
 */
export function applyRuntimeLifecycleCap(cfnRuntime: bedrockagentcore.CfnRuntime): void {
  cfnRuntime.lifecycleConfiguration = {
    maxLifetime: RUNTIME_MAX_LIFETIME_SECONDS,
    idleRuntimeSessionTimeout: RUNTIME_IDLE_TIMEOUT_SECONDS,
  };
}

export interface AgentCorePhysicalIdentity {
  runtime: string;
  memory: string;
  sessionApiFunction: string;
  /** The alias the Chat Service calls the session API through. */
  sessionApiAlias: string;
  ecrRepository: string;
  codeBuildProject: string;
  lambdaFunction: string;
  roles: {
    memory: string;
    lambda: string;
    runtime: string;
    codeBuild: string;
    sessionApi: string;
  };
}

export interface PrivateNatBrowserConfig {
  name: string;
  id: string;
  vpcId: string;
  browserSecurityGroupId: string;
  extension: {
    bucket: string;
    prefix: string;
    versionId: string;
  };
  subnets: Array<{
    id: string;
    availabilityZone: string;
    cidrBlock: string;
  }>;
}

export interface AgentCoreStackProps extends Omit<StackProps, 'permissionsBoundary'> {
  executionRole?: iam.IRole;
  vpc?: ec2.IVpc;
  subnets?: ec2.SubnetSelection;
  securityGroups?: ec2.ISecurityGroup[];
  /** Name for the fallback group created when securityGroups are omitted. */
  runtimeSecurityGroupName?: string;
  kmsKey?: kms.IKey;
  permissionsBoundary?: iam.IManagedPolicy;
  runtimeMaxLifetimeSeconds?: number;
  runtimeIdleTimeoutSeconds?: number;
  workspace?: string;
  sessionApiTimeoutSeconds?: number;
  sessionApiMemoryMiB?: number;
  sessionApiProvisionedConcurrency?: number;
  sessionApiLogRetention?: logs.RetentionDays;
  sessionApiLogGroupName?: string;
  /**
   * The AgentCore project specification containing agents and memories.
   */
  spec: AgentCoreProjectSpec;
  physicalIdentity: AgentCorePhysicalIdentity;
  /** Dedicated browser egressing through the ECS app's private NAT Gateway. */
  privateNatBrowser?: PrivateNatBrowserConfig | undefined;
  runtimeNetwork?: RuntimeNetwork | undefined;
  /** The Harness source, which also builds the session API function (ADR 0067 §5). */
  harnessCodeLocation?: string;
  /** The commit this stack deploys, output as `Commit` for `scripts/dev-status.sh`. */
  commit?: string;
  retainLegacyRuntimeMemory?: boolean;
}

function validateRuntimeLifecycle(props: AgentCoreStackProps): void {
  for (const [name, value, cap] of [
    ['runtimeMaxLifetimeSeconds', props.runtimeMaxLifetimeSeconds, RUNTIME_MAX_LIFETIME_SECONDS],
    ['runtimeIdleTimeoutSeconds', props.runtimeIdleTimeoutSeconds, RUNTIME_IDLE_TIMEOUT_SECONDS],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 60 || value > cap)) {
      throw new Error(`${name} must be an integer between 60 and ${cap} seconds (ADR 0029)`);
    }
  }
}

function configuredSpec(props: AgentCoreStackProps): AgentCoreProjectSpec {
  const { executionRole, kmsKey } = props;
  return {
    ...props.spec,
    runtimes: executionRole
      ? props.spec.runtimes.map(runtime => ({ ...runtime, executionRoleArn: executionRole.roleArn }))
      : props.spec.runtimes,
    memories: kmsKey
      ? props.spec.memories.map(memory => ({ ...memory, encryptionKeyArn: kmsKey.keyArn }))
      : props.spec.memories,
  };
}

/**
 * CDK Stack that deploys AgentCore infrastructure.
 *
 * This is a thin wrapper that instantiates L3 constructs.
 * All resource logic and outputs are contained within the L3 constructs.
 */
export class AgentCoreStack extends Stack {
  /** The AgentCore application containing all agent environments */
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    const { permissionsBoundary, ...stackProps } = props;
    super(scope, id, stackProps);
    validateRuntimeLifecycle(props);

    if (props.permissionsBoundary) iam.PermissionsBoundary.of(this).apply(props.permissionsBoundary);
    if (props.vpc && props.runtimeNetwork) throw new Error('Choose vpc or runtimeNetwork, not both');
    if (!props.vpc && (props.subnets || props.securityGroups))
      throw new Error('subnets and securityGroups require vpc');
    const { physicalIdentity, privateNatBrowser } = props;
    const spec = configuredSpec(props);

    this.application = new AgentCoreApplication(this, 'Application', { spec });
    this.applyPhysicalIdentity(
      physicalIdentity,
      spec,
      !!props.executionRole || spec.runtimes.some(runtime => !!runtime.executionRoleArn)
    );

    if (privateNatBrowser) {
      this.addPrivateNatBrowser(privateNatBrowser);
    }

    this.configureMemories(props);
    this.configureRuntimes(props);

    // The Runtime role has no browser access: the agent reaches its Session's Agent
    // Computer only through the Chat Service's CDP filter (ADR 0075 decision 5).

    // Stack-level output
    new CfnOutput(this, 'StackNameOutput', {
      description: 'Name of the CloudFormation Stack',
      value: this.stackName,
    });
    new CfnOutput(this, 'LegacyRuntimeMemoryRetained', { value: String(props.retainLegacyRuntimeMemory === true) });
    if (props.commit) new CfnOutput(this, 'Commit', { value: props.commit });
  }

  private configureMemories(props: AgentCoreStackProps): void {
    const { physicalIdentity } = props;
    for (const memory of this.application.memories.values()) {
      if (props.kmsKey) {
        for (const role of memory.node.findAll().filter((child): child is iam.Role => child instanceof iam.Role)) {
          role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
              resources: [props.kmsKey.keyArn],
            })
          );
        }
      }
      // The Harness persists each Session in this memory (ADR 0067 §1).
      for (const env of this.application.environments.values()) {
        env.runtime.addEnvironmentVariable('AGENTCORE_MEMORY_ID', memory.memoryId);
        removeInvalidMemoryAlias(env.runtime.node.defaultChild as bedrockagentcore.CfnRuntime, memory.getEnvVarName());
      }
      if (props.retainLegacyRuntimeMemory) {
        for (const env of this.application.environments.values()) {
          env.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: ['bedrock-agentcore:ListMemoryRecords', 'bedrock-agentcore:RetrieveMemoryRecords'],
              resources: [memory.memoryArn],
              conditions: { StringEquals: { 'bedrock-agentcore:namespacePath': MEMORY_STRATEGIES_NAMESPACE_PREFIX } },
            })
          );
        }
      }
      if (props.harnessCodeLocation) {
        this.addSessionApi(props.harnessCodeLocation, memory, physicalIdentity, props);
      }
    }
  }

  private configureRuntimes(props: AgentCoreStackProps): void {
    // Cap each runtime's lifecycle (ADR 0029 defense-in-depth). The
    // agentcore-cdk L3 construct doesn't expose LifecycleConfiguration, so set
    // it on the underlying CfnRuntime (the runtime's default child).
    for (const env of this.application.environments.values()) {
      const cfnRuntime = env.runtime.node.defaultChild as bedrockagentcore.CfnRuntime;
      cfnRuntime.lifecycleConfiguration = {
        maxLifetime: props.runtimeMaxLifetimeSeconds ?? RUNTIME_MAX_LIFETIME_SECONDS,
        idleRuntimeSessionTimeout: props.runtimeIdleTimeoutSeconds ?? RUNTIME_IDLE_TIMEOUT_SECONDS,
      };
      cfnRuntime.filesystemConfigurations = [{ sessionStorage: { mountPath: props.workspace ?? RUNTIME_WORKSPACE } }];
      env.runtime.addEnvironmentVariable('BOTCUBE_WORKSPACE', props.workspace ?? RUNTIME_WORKSPACE);
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
          resources: ['*'],
        })
      );
      if (props.runtimeNetwork) applyRuntimeNetwork(cfnRuntime, props.runtimeNetwork);
      restrictRuntimePolicy(this, env.runtime.role, props.retainLegacyRuntimeMemory === true);
      if (props.vpc) {
        const subnetIds = props.vpc.selectSubnets(props.subnets).subnetIds;
        if (!subnetIds.length) throw new Error('Runtime VPC requires at least one subnet');
        const groups = props.securityGroups ?? [
          new ec2.SecurityGroup(this, 'RuntimeSecurityGroup', {
            vpc: props.vpc,
            ...(props.runtimeSecurityGroupName !== undefined
              ? { securityGroupName: props.runtimeSecurityGroupName }
              : {}),
          }),
        ];
        if (!groups.length) throw new Error('Runtime VPC requires at least one security group');
        cfnRuntime.networkConfiguration = {
          networkMode: 'VPC',
          networkModeConfig: { subnets: subnetIds, securityGroups: groups.map(group => group.securityGroupId) },
        };
      }
    }
  }

  /**
   * The session API reads and purges Sessions without waking a Sandbox (ADR 0067 §5).
   * It has no function URL and no resource policy: only a principal granted
   * lambda:InvokeFunction on it — the Chat Service's task role — can call it.
   */
  private addSessionApi(
    codeLocation: string,
    memory: { memoryId: string; memoryArn: string },
    identity: AgentCorePhysicalIdentity,
    props: AgentCoreStackProps
  ): void {
    const role = new iam.Role(this, 'SessionApiRole', {
      roleName: identity.roles.sessionApi,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    // Scheduled runs post their result to the member's Main Chat as an event.
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:ListEvents', 'bedrock-agentcore:CreateEvent', 'bedrock-agentcore:DeleteEvent'],
        resources: [memory.memoryArn],
      })
    );
    // A member's Memory document: their strategy records, listed, edited, and deleted.
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:ListMemoryRecords'],
        resources: [memory.memoryArn],
        conditions: {
          StringEquals: { 'bedrock-agentcore:namespacePath': MEMORY_STRATEGIES_NAMESPACE_PREFIX },
        },
      })
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:BatchUpdateMemoryRecords', 'bedrock-agentcore:DeleteMemoryRecord'],
        resources: [memory.memoryArn],
      })
    );
    const logGroup = new logs.LogGroup(this, 'SessionApiLogs', {
      logGroupName: props.sessionApiLogGroupName ?? `/aws/lambda/${identity.sessionApiFunction}`,
      retention: props.sessionApiLogRetention ?? logs.RetentionDays.ONE_MONTH,
    });
    const sessionApi = new lambda.DockerImageFunction(this, 'SessionApi', {
      functionName: identity.sessionApiFunction,
      code: lambda.DockerImageCode.fromImageAsset(codeLocation, {
        file: 'session-api.Dockerfile',
        platform: Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.sessionApiMemoryMiB ?? 1024,
      timeout: Duration.seconds(props.sessionApiTimeoutSeconds ?? SESSION_API_TIMEOUT_SECONDS),
      role,
      logGroup,
      environment: {
        AGENTCORE_MEMORY_ID: memory.memoryId,
        AGENTCORE_REGION: this.region,
      },
    });
    sessionApi.addAlias(identity.sessionApiAlias, {
      provisionedConcurrentExecutions: props.sessionApiProvisionedConcurrency ?? SESSION_API_PROVISIONED_CONCURRENCY,
    });
    new CfnOutput(this, 'SessionApiFunctionArn', { value: sessionApi.functionArn });
  }

  // The Runtime role gets no S3 access: the agent's shell can use that role (ADR 0077).
  private addPrivateNatBrowser(config: PrivateNatBrowserConfig): void {
    new CfnOutput(this, 'PrivateNatBrowserId', {
      value: config.id,
      description: 'AgentCore browser ID using private NAT egress',
    });
  }

  private applyPhysicalIdentity(
    identity: AgentCorePhysicalIdentity,
    spec: AgentCoreProjectSpec,
    externalExecutionRole: boolean
  ): void {
    const resources = this.node.findAll();
    const requireOne = <T extends CfnResource>(
      type: (new (...args: never[]) => T) & { CFN_RESOURCE_TYPE_NAME: string },
      pathFragment = ''
    ): T => {
      const matches = resources.filter(
        (resource): resource is T => resource instanceof type && resource.node.path.includes(pathFragment)
      );
      const [match, ...others] = matches;
      if (!match || others.length > 0) {
        throw new Error(`Expected one ${type.CFN_RESOURCE_TYPE_NAME}${pathFragment} resource, found ${matches.length}`);
      }
      return match;
    };

    if (spec.memories.length > 0) {
      requireOne(bedrockagentcore.CfnMemory).name = identity.memory;
      requireOne(iam.CfnRole, '/Memory').roleName = identity.roles.memory;
    }

    if (spec.runtimes.length > 0) {
      requireOne(bedrockagentcore.CfnRuntime).agentRuntimeName = identity.runtime;
      requireOne(ecr.CfnRepository).repositoryName = identity.ecrRepository;
      requireOne(codebuild.CfnProject).name = identity.codeBuildProject;
      requireOne(lambda.CfnFunction).functionName = identity.lambdaFunction;
      requireOne(iam.CfnRole, '/ContainerBuildHandler/ServiceRole/').roleName = identity.roles.lambda;
      if (!externalExecutionRole) requireOne(iam.CfnRole, '/Runtime/ExecutionRole/').roleName = identity.roles.runtime;
      requireOne(iam.CfnRole, '/ContainerBuildProject/ContainerBuildExecutionRole/').roleName =
        identity.roles.codeBuild;
    }
  }
}
