import { harnessAlarmEvents } from 'botcube-config/harness-alarm-events';
import type { AgentCoreApplication, AgentCoreProjectSpec } from '@aws/agentcore-cdk';
import { CfnOutput, Duration, Stack, type CfnResource, type StackProps } from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { sessionApiCode, sessionApiTimeout } from './predeploy-assets';
import { applyRuntimeNetwork, type RuntimeNetwork } from './runtime-network';
import { applyRuntimePlatform, type RuntimePlatformVersion } from './runtime-platform';
import { sessionApiExports } from 'botcube-infra-agentcore-cdk/exports';
import { Construct } from 'constructs';
import { configureRuntimeTelemetry } from './runtime-telemetry';
import { applyDeploymentSeams, useExistingImageKey } from './runtime-seams';
import type { HarnessAuth, ModelsDeployment, RuntimeTelemetry } from '../../../../config/seams.js' with {
  'resolution-mode': 'import',
};
import { addUserMemoryRole, type UserMemoryRole } from './user-memory-role';
import { runtimeApplication, type RuntimeEnvironment } from './bot-image-runtime';

/** Permanent lifetime cap in seconds (ADR 0029), bounding runaway microVM billing. */
export const RUNTIME_MAX_LIFETIME_SECONDS = 3600;
/** Idle timeout (seconds) after which an idle runtime microVM is reaped. */
export const RUNTIME_IDLE_TIMEOUT_SECONDS = 300;
const RUNTIME_IDLE_TIMEOUT_CAP_SECONDS = 900;
const RUNTIME_SESSION_STORAGE = '/mnt/workspace';
/** Every actor's long-term records: the trailing slashes refuse `/actors/` and an actor ID without its slash (ADR 0033). */
const MEMORY_ACTOR_NAMESPACES = { StringLike: { 'bedrock-agentcore:namespace': '/actors/*/' } };

/** The `@aws/agentcore-cdk` L3 also names each Memory as `MEMORY_<NAME>_ID`; the Harness reads only AGENTCORE_MEMORY_ID. */
function removeMemoryAlias(runtime: bedrockagentcore.CfnRuntime, generatedAlias: string): void {
  const variables = { ...(runtime.environmentVariables as Record<string, string>) };
  delete variables[generatedAlias];
  runtime.environmentVariables = variables;
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
  /** A existing Memory key, by ARN; no role is granted it. */
  existingMemoryKeyArn?: string;
  /** A existing image repository key, by ARN; no role is granted it. */
  existingImageKeyArn?: string;
  /** The registry, mirroring ECR Public's paths, images are built FROM. */
  imageRegistry?: string;
  /** agentCore.runtime.containerUri: the Bot Image to run, else built. */
  runtimeImage?: string | undefined;
  /** Variables every runtime gets, such as the proxy and the OTLP traces endpoint (BotCube Config plain parameters). */
  runtimeEnvironment?: Record<string, string>;
  permissionsBoundary?: iam.IManagedPolicy;
  runtimeMaxLifetimeSeconds?: number;
  runtimeIdleTimeoutSeconds?: number;
  platformVersion?: RuntimePlatformVersion;
  rollbackVersion?: string;
  /** The session-storage mount; the shell works in its files child. */
  workspace?: string;
  sessionApiMemoryMiB?: number;
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
  /** The Memory role each Turn's credentials come from (ADR 0067 §8). */
  userMemoryRole?: UserMemoryRole;
  /** The Chat Service's public origin, which serves the OIDC discovery for the tokens it signs with its Turn identity keys. */
  chatServiceIssuer?: string;
  /** How the Chat Service authenticates to the Runtime, the BotCube Config's `harnessAuth`; absent, SigV4. */
  harnessAuth?: HarnessAuth;
  /** The BotCube Config's `models` section off Bedrock, as `modelGatewayResources` in botcube/config gives it; absent, Bedrock. */
  models?: ModelsDeployment | undefined;
  /** The BotCube Config's `telemetry`; absent, X-Ray. */
  telemetry?: RuntimeTelemetry | undefined;
}

function validateRuntimeLifecycle(props: AgentCoreStackProps): void {
  for (const [name, value, cap] of [
    ['runtimeMaxLifetimeSeconds', props.runtimeMaxLifetimeSeconds, RUNTIME_MAX_LIFETIME_SECONDS],
    ['runtimeIdleTimeoutSeconds', props.runtimeIdleTimeoutSeconds, RUNTIME_IDLE_TIMEOUT_CAP_SECONDS],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 60 || value > cap)) {
      throw new Error(`${name} must be an integer between 60 and ${cap} seconds (ADR 0029)`);
    }
  }
}

const registryArgs = ({ imageRegistry }: AgentCoreStackProps): { REGISTRY?: string } =>
  imageRegistry ? { REGISTRY: imageRegistry } : {};

const memoryKeyArn = (props: AgentCoreStackProps): string | undefined =>
  props.kmsKey?.keyArn ?? props.existingMemoryKeyArn;

function configuredSpec(props: AgentCoreStackProps): AgentCoreProjectSpec {
  const { executionRole } = props;
  const keyArn = memoryKeyArn(props);
  return {
    ...props.spec,
    runtimes: props.spec.runtimes.map(runtime => ({
      ...runtime,
      customDockerBuildArgs: { ...runtime.customDockerBuildArgs, ...registryArgs(props) },
      ...(executionRole ? { executionRoleArn: executionRole.roleArn } : {}),
    })),
    memories: keyArn
      ? props.spec.memories.map(memory => ({ ...memory, encryptionKeyArn: keyArn }))
      : props.spec.memories,
  };
}

/** CDK Stack that deploys AgentCore infrastructure. */
export class AgentCoreStack extends Stack {
  /** The AgentCore application containing all agent environments */
  public readonly application: AgentCoreApplication;
  private readonly runtimes: RuntimeEnvironment[];

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    const { permissionsBoundary, ...stackProps } = props;
    super(scope, id, stackProps);
    validateRuntimeLifecycle(props);

    if (props.permissionsBoundary) iam.PermissionsBoundary.of(this).apply(props.permissionsBoundary);
    if (props.vpc && props.runtimeNetwork) throw new Error('Choose vpc or runtimeNetwork, not both');
    if (props.kmsKey && props.existingMemoryKeyArn) throw new Error('Choose kmsKey or existingMemoryKeyArn, not both');
    if (!props.vpc && (props.subnets || props.securityGroups))
      throw new Error('subnets and securityGroups require vpc');
    const { physicalIdentity, privateNatBrowser } = props;
    const spec = configuredSpec(props);

    [this.application, this.runtimes] = runtimeApplication(this, spec, props.runtimeImage);
    this.applyPhysicalIdentity(
      physicalIdentity,
      spec,
      !!props.executionRole || spec.runtimes.some(runtime => !!runtime.executionRoleArn),
      !props.runtimeImage
    );

    if (privateNatBrowser) {
      this.addPrivateNatBrowser(privateNatBrowser);
    }

    this.configureMemories(props);
    this.configureRuntimes(props);
    if (props.existingImageKeyArn) useExistingImageKey(this, props.existingImageKeyArn);

    // The Runtime role has no browser access: the agent reaches its Session's Agent
    // Computer only through the Chat Service's CDP filter (ADR 0075 decision 5).

    // Stack-level output
    new CfnOutput(this, 'StackNameOutput', {
      description: 'Name of the CloudFormation Stack',
      value: this.stackName,
    });
    if (props.commit) new CfnOutput(this, 'Commit', { value: props.commit });
  }

  private configureMemories(props: AgentCoreStackProps): void {
    const { physicalIdentity } = props;
    const grantedKeyArn = props.kmsKey?.keyArn;
    for (const memory of this.application.memories.values()) {
      if (grantedKeyArn) {
        for (const role of memory.node.findAll().filter((child): child is iam.Role => child instanceof iam.Role)) {
          role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
              resources: [grantedKeyArn],
            })
          );
        }
      }
      // The Harness persists each Session in this memory (ADR 0067 §1).
      for (const env of this.runtimes) {
        env.runtime.addEnvironmentVariable('AGENTCORE_MEMORY_ID', memory.memoryId);
        removeMemoryAlias(env.runtime.node.defaultChild as bedrockagentcore.CfnRuntime, memory.getEnvVarName());
      }
      if (props.harnessCodeLocation) {
        this.addSessionApi(props.harnessCodeLocation, memory, physicalIdentity, props);
      }
      if (props.userMemoryRole)
        addUserMemoryRole(this, this.runtimes, memory.memoryArn, props.userMemoryRole, memoryKeyArn(props));
    }
  }

  private configureRuntimes(props: AgentCoreStackProps): void {
    // agentcore-cdk does not expose lifecycle or request-header settings.
    for (const env of this.runtimes) {
      const cfnRuntime = env.runtime.node.defaultChild as bedrockagentcore.CfnRuntime;
      const platformVersion = props.platformVersion === undefined ? 'V2' : props.platformVersion;
      applyRuntimePlatform(cfnRuntime, platformVersion, props.rollbackVersion);
      new CfnOutput(this, 'RuntimePlatformVersion', { value: platformVersion });
      if (props.rollbackVersion !== undefined)
        new CfnOutput(this, 'V1RollbackVersion', { value: props.rollbackVersion });
      cfnRuntime.requestHeaderConfiguration = { requestHeaderAllowlist: ['X-BotCube-Credential-Invocation'] };
      cfnRuntime.lifecycleConfiguration = {
        maxLifetime: props.runtimeMaxLifetimeSeconds ?? RUNTIME_MAX_LIFETIME_SECONDS,
        idleRuntimeSessionTimeout: props.runtimeIdleTimeoutSeconds ?? RUNTIME_IDLE_TIMEOUT_SECONDS,
      };
      const storage = props.workspace ?? RUNTIME_SESSION_STORAGE;
      cfnRuntime.filesystemConfigurations = [{ sessionStorage: { mountPath: storage } }];
      env.runtime.addEnvironmentVariable('BOTCUBE_WORKSPACE', `${storage}/files`);
      for (const [name, value] of Object.entries(props.runtimeEnvironment ?? {}))
        env.runtime.addEnvironmentVariable(name, value);
      configureRuntimeTelemetry(
        this,
        `${env.node.id}LogRetention`,
        cfnRuntime.attrAgentRuntimeId,
        env.runtime.role,
        props.telemetry ?? { kind: 'xray', secretIds: [] }
      );
      if (props.runtimeNetwork) applyRuntimeNetwork(cfnRuntime, props.runtimeNetwork);
      applyDeploymentSeams(this, env.runtime, cfnRuntime, props);
      this.placeRuntimeInVpc(cfnRuntime, props);
    }
  }

  /** Put the Runtime in the adopter's VPC, when there is one, on its subnets and security groups. */
  private placeRuntimeInVpc(cfnRuntime: bedrockagentcore.CfnRuntime, props: AgentCoreStackProps): void {
    if (!props.vpc) return;
    const subnetIds = props.vpc.selectSubnets(props.subnets).subnetIds;
    if (!subnetIds.length) throw new Error('Runtime VPC requires at least one subnet');
    const groups = props.securityGroups ?? [
      new ec2.SecurityGroup(this, 'RuntimeSecurityGroup', {
        vpc: props.vpc,
        ...(props.runtimeSecurityGroupName !== undefined ? { securityGroupName: props.runtimeSecurityGroupName } : {}),
      }),
    ];
    if (!groups.length) throw new Error('Runtime VPC requires at least one security group');
    cfnRuntime.networkConfiguration = {
      networkMode: 'VPC',
      networkModeConfig: { subnets: subnetIds, securityGroups: groups.map(group => group.securityGroupId) },
    };
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
    });
    // Scheduled runs post their result to the member's Main Chat as an event. A purge lists the
    // Session's checkpoint writes sessions (ListSessions) and deletes their events.
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:ListEvents',
          'bedrock-agentcore:GetEvent',
          'bedrock-agentcore:CreateEvent',
          'bedrock-agentcore:DeleteEvent',
          'bedrock-agentcore:ListSessions',
        ],
        resources: [memory.memoryArn],
      })
    );
    // A member's Memory document: their records, listed under their actor prefix, edited, and deleted.
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:ListMemoryRecords'],
        resources: [memory.memoryArn],
        conditions: MEMORY_ACTOR_NAMESPACES,
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
    logGroup.grantWrite(role);
    // A Session's purge logs a line per page it deletes; the Chat Service logs one only when the whole
    // Session finishes. Both count as progress on the Chat Service's account-deletion stalled alarm.
    new logs.MetricFilter(this, 'SessionPurgeProgress', {
      logGroup,
      filterPattern: logs.FilterPattern.allTerms(harnessAlarmEvents.sessionPurgeDeleted),
      metricNamespace: 'BotCube/ChatService',
      metricName: 'AccountDeletionProgress',
      metricValue: '1',
    });
    const sessionApi = new lambda.DockerImageFunction(this, 'SessionApi', {
      functionName: identity.sessionApiFunction,
      code: sessionApiCode(codeLocation, registryArgs(props)),
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.sessionApiMemoryMiB ?? 1024,
      timeout: Duration.seconds(sessionApiTimeout(codeLocation)),
      role,
      logGroup,
      // Lambda sets AWS_REGION, the function's region, and reserves the name.
      environment: { AGENTCORE_MEMORY_ID: memory.memoryId },
    });
    const sessionApiAlias = sessionApiExports(this, identity.sessionApiFunction).addAlias(sessionApi);
    for (const env of this.runtimes) env.runtime.node.addDependency(sessionApiAlias);
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
    externalExecutionRole: boolean,
    builds: boolean
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
      const runtime = requireOne(bedrockagentcore.CfnRuntime);
      runtime.agentRuntimeName = identity.runtime;
      new CfnOutput(this, 'AgentRuntimeVersion', { value: runtime.attrAgentRuntimeVersion });
      if (!externalExecutionRole) requireOne(iam.CfnRole, '/Runtime/ExecutionRole/').roleName = identity.roles.runtime;
      if (!builds) return;
      requireOne(ecr.CfnRepository).repositoryName = identity.ecrRepository;
      requireOne(codebuild.CfnProject).name = identity.codeBuildProject;
      requireOne(lambda.CfnFunction).functionName = identity.lambdaFunction;
      requireOne(iam.CfnRole, '/ContainerBuildHandler/ServiceRole/').roleName = identity.roles.lambda;
      requireOne(iam.CfnRole, '/ContainerBuildProject/ContainerBuildExecutionRole/').roleName =
        identity.roles.codeBuild;
    }
  }
}
