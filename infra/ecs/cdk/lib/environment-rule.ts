import { App, Stack } from 'aws-cdk-lib';

/** Use 1: the BotCube Config file's locator. */
const LOCATOR = ['BOTCUBE_CONFIG'];

/** Use 2: a secret's value. Every ECS `Secrets` entry is this use too. */
const SECRETS = [
  'BOTCUBE_CREDENTIAL_INVOCATION_SECRET', 'BOTCUBE_FILES_SIGNING_KEY', 'BOTCUBE_TURN_IDENTITY_KEYS',
  'CLOUDFLARE_ORIGIN_API_TOKEN', 'TEMPLATE_CREDENTIAL_INVOCATION', 'TEMPLATE_CREDENTIAL_SESSION',
];

/** Use 3: the name of a resource the deployment creates, hostnames included. */
const CREATED_RESOURCES = [
  'AGENTCORE_AGENT_COMPUTER_BROWSER_ID', 'AGENTCORE_BROWSER_ID', 'AGENTCORE_MEMORY_ID', 'AGENTCORE_RUNTIME_ARN',
  'AUDIT_LOG_GROUP', 'BACKSTOP_STATE_MACHINE', 'BOTCUBE_AGENT_COMPUTER_POLICY_S3_BUCKET', 'BOTCUBE_AGENT_COMPUTER_POLICY_S3_KEY',
  'BOTCUBE_CHAT_TABLE', 'BOTCUBE_CREDENTIAL_SERVICE_URL', 'BOTCUBE_FILES_EFS_ARN', 'BOTCUBE_FILES_MOUNT_ROLE_ARN',
  'BOTCUBE_FILES_MOUNT_TARGET_IP', 'BOTCUBE_FILES_POOL_MANIFEST', 'BOTCUBE_PARK_STATE_PARAMETER', 'BOTCUBE_PUBLIC_ORIGIN', 'BOTCUBE_WAKE_URL',
  'BOTCUBE_RAW_SERVICE_HOST', 'BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN', 'BOTCUBE_SCHEDULED_RUNS_QUEUE_URL',
  'BOTCUBE_SCHEDULER_ROLE_ARN', 'BOTCUBE_SCHEDULE_GROUP', 'BOTCUBE_SESSION_API_FUNCTION_ARN', 'BOTCUBE_SHEET_KMS_ALIAS',
  'BOTCUBE_USER_MEMORY_ROLE_ARN', 'BOTCUBE_VAULT_KMS_KEY_ID', 'BOTCUBE_VAULT_TABLE', 'BOTCUBE_WORKSPACE', 'CLIENT_SECRET',
  'HOSTNAMES', 'MONITORING_STATE_MACHINE', 'ORIGIN_OWNERSHIP', 'ORIGIN_SLOT_KEY', 'PARKED_WORKER_NAME',
  'PARK_STATE_PARAMETER', 'QUEUE_URL', 'SLOT_BUCKET', 'TOKEN_SECRET', 'TRANSITION_FUNCTION', 'TRANSITION_STATE_MACHINE',
  'USER_IS_COMPLETE_FUNCTION_ARN', 'USER_ON_EVENT_FUNCTION_ARN', 'WAITER_STATE_MACHINE_ARN',
];

/** Use 4: a name a standard SDK, tool or platform reads. */
const STANDARD = [
  'AGENT_BROWSER_SCREENSHOT_DIR', 'ECS_CONTAINER_METADATA_URI_V4', 'GOMEMLIMIT', 'MPLCONFIGDIR', 'NODE_EXTRA_CA_CERTS', 'PATH',
  'PLAYWRIGHT_BROWSERS_PATH', 'PORT', 'PYTHONPATH', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
  'UV_COMPILE_BYTECODE', 'UV_PYTHON', 'UV_PYTHON_INSTALL_DIR', 'XDG_CONFIG_HOME',
  // The AWS Distro for OpenTelemetry (aws-opentelemetry-distro) reads this.
  'AGENT_OBSERVABILITY_ENABLED',
  // Traceloop's OpenLLMetry LangChain instrumentation (opentelemetry-instrumentation-langchain) reads this.
  'TRACELOOP_TRACE_CONTENT',
  // The LangSmith SDK (langsmith) reads these two.
  'LANGSMITH_TRACING', 'LANGCHAIN_TRACING_V2',
];
const STANDARD_PREFIXES = ['AWS_', 'OTEL_'];

/** The operator's consent to command credentials, kept out of the editable BotCube Config on purpose. */
const OPERATOR_CONSENT = ['BOTCUBE_ALLOW_COMMAND_CREDENTIALS'];

export const ALLOWED: ReadonlySet<string> = new Set([...LOCATOR, ...SECRETS, ...CREATED_RESOURCES, ...STANDARD, ...OPERATOR_CONSENT]);

export const isAllowed = (name: string): boolean => ALLOWED.has(name) || STANDARD_PREFIXES.some(prefix => name.startsWith(prefix));

/** The variable names one process is deployed with: an ECS container, a Lambda or a Harness Runtime. */
export interface ProcessEnvironment { process: string; names: string[] }

interface Container { Name: string; Environment?: { Name: string }[] }
interface Resource {
  Type: string;
  Properties?: { ContainerDefinitions?: Container[]; Environment?: { Variables?: object }; EnvironmentVariables?: object };
}

/** Every process environment `app` declares, labelled `<label>/<stack path>/<logical ID>/<container, Lambda or Runtime>`. ECS secrets are left out. */
export function processEnvironments(app: App, label: string): ProcessEnvironment[] {
  const stacks = app.node.findAll().filter(Stack.isStack);
  const assembly = app.synth();
  return stacks.flatMap(stack => {
    const resources: Record<string, Resource> = assembly.getStackArtifact(stack.artifactId).template.Resources ?? {};
    return Object.entries(resources).flatMap(([id, { Type, Properties }]): ProcessEnvironment[] => {
      const process = `${label}/${stack.node.path}/${id}`;
      switch (Type) {
        case 'AWS::ECS::TaskDefinition':
          return (Properties?.ContainerDefinitions ?? []).map(container => ({
            process: `${process}/${container.Name}`, names: (container.Environment ?? []).map(({ Name }) => Name),
          }));
        case 'AWS::Lambda::Function':
          return [{ process: `${process}/Lambda`, names: Object.keys(Properties?.Environment?.Variables ?? {}) }];
        case 'AWS::BedrockAgentCore::Runtime':
          return [{ process: `${process}/Runtime`, names: Object.keys(Properties?.EnvironmentVariables ?? {}) }];
        default:
          return [];
      }
    });
  });
}

/** Each name a process sets outside the four uses and `exempt`. */
export function environmentViolations(
  environments: readonly ProcessEnvironment[],
  { exempt = [] }: { exempt?: readonly string[] } = {},
): string[] {
  return environments.flatMap(({ process, names }) => names
    .filter(name => !isAllowed(name) && !exempt.includes(name))
    .map(name => `${process} sets ${name}, outside the four uses: read it from the BotCube Config`));
}
