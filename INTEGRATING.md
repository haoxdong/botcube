# Integrate BotCube with your application

BotCube gives you a web UI, a Chat Service, and a Harness. Your Cartridge supplies your application's identity, tools, sign-in routes, and branding. Start with the neutral `template/` Cartridge, then replace its inputs with your own. The template runs without external provider or AWS credentials.

## Run the template in a clean clone

Install Docker with Compose, Git, Python 3, curl, uv, Node.js 24 or newer, Corepack, and npm. Browser staging needs access to the npm registry or a populated npm cache. Clone [the public BotCube repository](https://github.com/haoxdong/botcube) over HTTPS.

```bash
git clone https://github.com/haoxdong/botcube.git
cd botcube
bash infra/local/run.sh -d
```

Open `http://localhost:3001`. Send `hello cube` and expect `Echo: hello cube`. The template echo model makes no tool calls and uses no AWS or model-provider credentials. DynamoDB Local stores Session Metadata, and SQLite stores Harness checkpoints in Docker volumes.

Run the same smoke check as CI.

```bash
bash infra/local/smoke.sh
```

The check verifies a turn, replay after Harness restart, deletion, rejection of an invalid request, and the UI. Stop the sandbox with `docker compose -f infra/local/compose.yml down`. Add `--volumes` only when you want to discard the sandbox's saved sessions.

## Build and test the public workspace

Use the pinned `pnpm@12.10.1` through Corepack. From the public repository root, install the shipped workspace dependencies and build the neutral web UI and template Chat Service:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test:chat --reporter=verbose
```

`pnpm test:chat` runs generic Chat Service unit tests and the neutral HTTP smoke check. `pnpm test:chat:unit` runs only the generic unit tests. The pretest hook prepares the template Python environment, Chat Service bundle, and staged tools. The container startup and smoke commands above verify the complete local application separately.

Run each CDK package's build and tests from its directory. Set `CARTRIDGE_DEPLOY_ROOT` to your Cartridge's deploy directory for composition and synthesis. The template's deployment settings are placeholders; replace them before using your AWS account.

## Build production artifacts

The public repository ships source-build Dockerfiles. From its root, stage the
Cartridge tools, then build Chat, Credential Service, Harness, and session API
images:

```bash
bash template/deploy/stage-tools.sh
docker build -f template/chat/Dockerfile --build-arg BOTCUBE_ROOT=. -t chat .
docker build -f template/deploy/credential-service/Dockerfile --build-arg BOTCUBE_ROOT=. -t credential .
docker build -f harness/deepagents/Dockerfile -t harness harness/deepagents
docker build -f harness/deepagents/session-api.Dockerfile -t session-api harness/deepagents
```

Export the static UI with the URL of your deployed Chat Service:

```bash
docker build -f ui/web/Dockerfile --target artifact \
  --build-arg NEXT_PUBLIC_CHAT_SERVICE_URL=https://your-chat.example \
  --output type=local,dest=ui-artifact .
```

The export writes the UI files to `ui-artifact/`. Omit `--target` and `--output`
and add an image tag to build its static server image, which listens on port 3001. Set `CARTRIDGE_UI_PACKAGE` and, when needed, `CARTRIDGE_UI_BUILD_CONFIG`
through build arguments to bind your UI Cartridge. Chat and Credential Service
Dockerfiles above bind the neutral template; supply your own Cartridge build
inputs when replacing it. The neutral Chat image's default Computer configuration and the Credential
Service need `TEMPLATE_SITE_URL` at runtime. Set it to your reachable, caller-owned HTTPS site URL. Configure the
Credential Vault and invocation settings as described in the
[template README](template/README.md).

Exercise the production images against the neutral local infrastructure:

```bash
BOTCUBE_PRODUCTION_ARTIFACTS=1 bash infra/local/run.sh -d
BOTCUBE_PRODUCTION_ARTIFACTS=1 bash infra/local/smoke.sh
```

This builds all five images and verifies Turn, replay after Harness restart,
delete, invalid-request rejection, and UI responses. Stop this stack with
`docker compose -f infra/local/compose.yml -f infra/local/compose.production.yml down`.

For a build behind your organization's TLS proxy, pass its CA bundle with
`--secret id=build_ca,src=<bundle>`. Compose accepts the same bundle through
`BOTCUBE_BUILD_CA_CERTS`. Build trust does not configure runtime trust.

## Connect the three pieces

The UI sends AG-UI requests to the Chat Service at `POST /`. The Chat Service owns request identity and Session Metadata. It relays turns to the Harness's `POST /invocations`, which streams AG-UI server-sent events. A Harness exposes `GET /ping` for health on port 8080.

The Chat Service exposes `GET /threads`, `GET /threads/{id}`, and `DELETE /threads/{id}` for session listing, replay, and deletion. It gets session content from the Harness's separate session API, rather than keeping a second conversation record. See [the Chat Service contract](chat/README.md) and [the Harness contract](harness/deepagents/README.md).

A corporate HTTPS wrapper must preserve the invocation body and streaming response. Configure its complete invocation URL and select whether the Chat Service signs requests with SigV4. Local plain HTTP remains available for the sandbox. Memory IDs and runtime ARNs may be supported unresolved CDK resource references. Harness endpoint URLs must be concrete HTTPS URLs without credentials or fragments. In ECS CDK composition, signed endpoints require a valid `runtimeArn` so the task receives its AgentCore invocation grant. Only `harnessSigv4: false` allows an endpoint without that ARN.

## Supply your Cartridge

Use [the template Harness definition](template/src/botcube_template/harness.py) as the starting point. The `botcube.cartridge` Python entry point supplies skills, agent copy, invocation identity, shell validation and environment, root preparation, and the session variable. The Harness adapts these values to DeepAgents. Your Cartridge does not import the agent framework.

Import `HarnessDefinition`, `InvocationAuth`, and `ModelRelay` from the shared
[`botcube-cartridge` package](cartridge/README.md). Declare it as a runtime
dependency of your Cartridge. The template and product Cartridge use the same
definitions; keep sign-in, skills, and model policy in your own Cartridge.

Use [the template Chat Cartridge](template/chat/src/cartridge.ts) to supply request identity, Session ownership, invocation policy, routes, and browser authorization. Its [entry point](template/chat/src/main.ts) calls `serveChatService` with the Cartridge factory.

Use [the template UI plugin](template/ui/web/src/index.ts) to supply copy, Chat Service URL, auth UI, views, and theme through the [typed UI contract](ui/web/src/cartridge/types.ts). Bind the plugin with `CARTRIDGE_UI_PACKAGE` at build time.

Your [tool staging hook](template/deploy/stage-tools.sh) prepares your CLI package and Cartridge wheel for the Harness image. Deployment identity belongs in your Cartridge's `deploy/` directory.

## Run it in your AWS account

1. Copy `template/` into your application and rename its Python, Chat, and UI packages. Keep its local echo model until the three pieces work together.
2. Set your account, region, names, and domains in [deploy/identity.json](template/deploy/identity.json). Set the same account and region in [agentcore/aws-targets.json](template/deploy/agentcore/aws-targets.json).
3. Set the runtime, memory, and artifact inputs in [agentcore/agentcore.json](template/deploy/agentcore/agentcore.json). Configure your Cartridge's model and tool policy before enabling a real model.
4. Build the generic AgentCore CDK package and load your deploy directory with `CARTRIDGE_DEPLOY_ROOT`. An AWS target that disagrees with `identity.json` fails before synthesis.
5. Compose the CDK stacks in your application. Pass existing resources through the props in the reference below. Imported resources remain your application's responsibility, including trust policies, network routing, and access grants.
6. Synthesize with your overrides, inspect the templates, and compare with your deployed stack before your organization's deployment process runs. See [AgentCore CDK commands](infra/agentcore/cdk/README.md) and [ECS CDK commands](infra/ecs/cdk/README.md).
7. Set the Chat Service's Harness endpoint, signing choice, session API, storage, and origins. Build the UI with your Cartridge and its Chat Service URL. Verify a successful turn, session replay, and a rejected request.

From the root of the standalone mirror, use the pinned Corepack/pnpm workspace installation above, then run the template synth.

```bash
export CARTRIDGE_DEPLOY_ROOT="$PWD/template/deploy"
corepack pnpm --dir infra/agentcore/cdk build
corepack pnpm --dir infra/agentcore/cdk cdk synth
```

The template uses the placeholder account `000000000000`. Set your account in both identity and target files before deployment. Synthesis stages the template wheel and may build Docker assets. It does not deploy resources.

For an existing-resource composition, use a custom CDK entry point instead of the default `bin/cdk.ts`. Import resources into a stack with the same account and region as your target, then pass them to `addAgentCoreStacks`.

```ts
import { App, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { addAgentCoreStacks } from './lib/agentcore-app';
import { loadDeployConfig } from './lib/deploy-config';

async function main() {
  const app = new App();
  const config = await loadDeployConfig(
    process.env.CARTRIDGE_DEPLOY_ROOT,
    process.cwd()
  );
  const target = config.targets[0];
  const imports = new Stack(app, 'CorporateResources', {
    env: { account: target.account, region: target.region },
  });
  const vpc = ec2.Vpc.fromVpcAttributes(imports, 'Vpc', {
    vpcId: 'vpc-fixture0123456789abcdef0',
    availabilityZones: [`${target.region}a`],
    privateSubnetIds: ['subnet-fixture0123456789abcdef0'],
  });
  addAgentCoreStacks(app, config, 'integration-example', {
    executionRole: iam.Role.fromRoleArn(
      imports,
      'ExecutionRole',
      `arn:aws:iam::${target.account}:role/corporate-agent-execution`
    ),
    vpc,
    subnets: { subnets: vpc.privateSubnets },
    kmsKey: kms.Key.fromKeyArn(
      imports,
      'Key',
      `arn:aws:kms:${target.region}:${target.account}:key/00000000-0000-0000-0000-000000000000`
    ),
    permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(
      imports,
      'Boundary',
      `arn:aws:iam::${target.account}:policy/corporate-boundary`
    ),
  });
  app.synth();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

Replace the placeholder IDs and ARNs with your resources. Stage tools through your Cartridge hook before synthesizing a custom app. The imported execution role needs AgentCore trust and runtime infrastructure permissions, with no AgentCore Memory or cross-account data grants (ADR 0067). Its policies remain caller-owned; BotCube does not rewrite imported role policies. Supply security groups through `securityGroups` when your network policy requires them. The AgentCore memory key must permit the memory service and the Chat Service and session API roles; the Harness runtime accesses Memory through the Chat Service broker. The subnet routes must reach the services the runtime uses.

The [template deploy identity](template/deploy/identity.json) contains placeholder AgentCore and ECS inputs. For corporate ECS composition, replace its placeholders and supply your origin inputs, then pass `executionRole`, `vpc`, `publicSubnets`, `privateSubnets`, `kmsKey`, and `permissionsBoundary` to `defineProduction`. When you supply `vpc`, private consumers use that VPC's private subnets unless you set `privateSubnets`. An explicit subnet selection takes precedence, and an empty private selection fails synthesis. Pass service settings through `chat` and `credentials`. Pass origin, monitoring, and RUM settings through `originConfig`, `apiHealth`, and `webLatency`. Supply the UI's latency event names as `webLatency.moments` when the Cartridge has no `latency-budgets.json` beside its deploy directory. Omitted moments retain the file-based budget input and fail if it is absent. The generic entry point accepts the same names through the [template's `webLatencyMoments` CDK context](template/IDENTITY.md). The ECS execution role pulls images and writes logs. The task role owns application access. The imported Credential Vault key must authorize decrypt only for the Credential Service task role. Use a different key for AgentCore memory. Use the template identity as the shape reference, not as a deployable account configuration.

For Cartridge-specific container settings, pass an `environment` map to
`PreviewChatService` or `PrivateCredentialService`. Production composition
forwards `chat.environment` and `credentials.environment`. For the neutral
serving images' default configuration, set `TEMPLATE_SITE_URL` in both maps to your reachable HTTPS
site URL. Framework-owned values, including serving ports and regions, take
precedence over caller entries. The Chat image enables Chromium by default;
its Computer configuration requires the site URL and Chromium path together.
An echo-only API fixture can disable Computer by setting
`TEMPLATE_CHROMIUM_PATH` to an empty string and omitting `TEMPLATE_SITE_URL`.

For the generic ECS CDK entry point, set `BOTCUBE_REPOSITORY_ROOT` to the absolute checkout root when running from a standalone BotCube mirror. This controls the image build context and Cartridge asset paths. If unset, it retains the current monorepo root; relative values resolve from `infra/ecs/cdk`.

## Use an existing load balancer and listener

`PreviewChatService` accepts an ordinary CDK construct scope and a
`ChatServiceIngress` interface from `infra/ecs/cdk/lib/preview-chat-service`.
Supply your ALB, listener, and ingress security group, including imported CDK
interfaces. The remaining `chatProps` are your application's Chat Service
configuration from the reference below.

```ts
new PreviewChatService(stack, 'ChatService', {
  ...chatProps,
  ingress: {
    loadBalancer,
    listener,
    securityGroup,
    cdpRulePriority: 101,
    chatRulePriority: 102,
  },
});
```

Reserve two unused listener priorities in `1..50000`, with the CDP denial
before Chat forwarding. The example numbers are placeholders. Both rules apply
only to your configured Chat hostnames.

You own TLS, listener default actions, and the shared ALB idle timeout. Set a
streaming timeout appropriate for your application on the ALB; the provided
origin defaults to 3600 seconds. Omit `loadBalancerIdleSeconds` from `chatProps`
when supplying `ingress`, or synthesis fails. Ensure the ALB security group can
send traffic to the Chat Service's `network` security group on the configured
Chat port, which defaults to 8123. BotCube adds its task ingress and reserved
listener rules without changing the supplied security group's outbound rules.
Use distinct resource names, hostnames, and priorities for separate services.

You own ALB-wide alarms for shared ingress. BotCube retains the Chat Service's
target-group alarms alongside its task and application alarms.

See [resource names and imports](RESOURCE-NAMES.md) for physical name inputs,
existing-resource examples, and ownership constraints.

## Configuration reference

Unset options preserve the current behavior. Names below are environment variables unless identified as CDK props or Cartridge fields. Timing and capacity limits must be positive. The OpenAI loopback port accepts `0` through `65535`. Provider endpoint overrides configure existing providers.

| Configuration                                                                                                                                             | Default                                                                                                             | Owner                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| AGENTCORE_REGION, AWS_ENDPOINT_URL_BEDROCK_AGENTCORE, AGENTCORE_RUNTIME_ARN                                                                               | us-east-1, regional AgentCore endpoint, no ARN                                                                      | chat/src/upstream.ts                                                                    |
| BOTCUBE_HARNESS_ENDPOINT, BOTCUBE_HARNESS_SIGV4                                                                                                           | unset; true when endpoint set. Complete HTTPS invocation URL, no path appended. Region comes from AGENTCORE_REGION. | chat/src/upstream.ts; server.ts                                                         |
| BOTCUBE_LOCAL_HARNESS_URL, BOTCUBE_LOCAL_SESSION_API_URL, BOTCUBE_SESSION_API_FUNCTION_ARN, AWS_ENDPOINT_URL_LAMBDA                                       | unset                                                                                                               | chat/src/server.ts                                                                      |
| BOTCUBE_HARNESS_CONNECT_TIMEOUT_MS, BOTCUBE_WARMUP_TIMEOUT_MS                                                                                             | 30000, 60000                                                                                                        | chat/src/server.ts                                                                      |
| BOTCUBE_CHAT_TABLE, BOTCUBE_CORS_ORIGINS, AGENTCORE_BROWSER_ID, PORT, BOTCUBE_CHAT_HOST                                                                   | chat, Cartridge origins, aws.browser.v1, 8123, 0.0.0.0                                                              | chat/src/server.ts                                                                      |
| BOTCUBE_LIVE_VIEW_URL_EXPIRES_SECONDS                                                                                                                     | 300                                                                                                                 | chat/src/server.ts                                                                      |
| BOTCUBE_TURN_SUMMARY_MODEL, AWS_ENDPOINT_URL_BEDROCK_RUNTIME                                                                                              | us.anthropic.claude-haiku-4-5-20251001-v1:0, regional Bedrock Runtime URL                                           | chat/src/turn-summaries.ts                                                              |
| BOTCUBE_CHAT_KEEPALIVE_MS                                                                                                                                 | 15000                                                                                                               | chat/src/turn-stream.ts                                                                 |
| BOTCUBE_TURN_BOUND_MS                                                                                                                                     | 3600000; match runtime maxLifetime                                                                                  | chat/src/sessions.ts                                                                    |
| BOTCUBE_SESSION_API_CALLS_AT_ONCE                                                                                                                         | 5; match provisioned concurrency                                                                                    | chat/src/session-api.ts                                                                 |
| BOTCUBE_SCHEDULED_TASK_CAP                                                                                                                                | 10                                                                                                                  | chat/src/scheduled-tasks.ts                                                             |
| BOTCUBE_MAX_PICTURE_BYTES                                                                                                                                 | 262144; keep below DynamoDB's 400 KB item cap                                                                       | chat/src/pictures.ts                                                                    |
| BOTCUBE_SCHEDULE_GROUP, BOTCUBE_SCHEDULER_ROLE_ARN, BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN, BOTCUBE_SCHEDULED_RUNS_QUEUE_URL                                    | unset; scheduling absent                                                                                            | chat/src/scheduled-tasks.ts                                                             |
| AWS_DEFAULT_REGION                                                                                                                                        | us-east-1                                                                                                           | chat/src/agent-documents.ts, session-metadata.ts, scheduled-tasks.ts, scheduled-runs.ts |
| BOTCUBE_MODEL, BOTCUBE_EFFORT, BOTCUBE_MAX_TOKENS; build_model model/region_name/max_tokens/effort args                                                   | us.anthropic.claude-sonnet-4-6, medium, 128; args take precedence                                                   | harness/deepagents/src/botcube_harness_deepagents/llm.py                                |
| BOTCUBE_SONNET_MODEL_ID, BOTCUBE_OPUS_MODEL_ID                                                                                                            | us.anthropic.claude-sonnet-4-6, us.anthropic.claude-opus-4-6-v1                                                     | harness/deepagents/src/botcube_harness_deepagents/llm.py                                |
| BOTCUBE_OPENROUTER_BASE_URL, OPENROUTER_API_KEY                                                                                                           | https://openrouter.ai/api/v1, required when provider chosen                                                         | harness/deepagents/src/botcube_harness_deepagents/llm.py                                |
| OPENAI_API_BASE / OPENAI_BASE_URL, BOTCUBE_OPENAI_MODEL_PREFIX; OPENAI_API_KEY / ANTHROPIC_API_KEY                                                        | SDK default endpoint (OPENAI_API_BASE takes precedence over OPENAI_BASE_URL), openai.; SDK credentials              | harness/deepagents/src/botcube_harness_deepagents/llm.py                                |
| AWS_REGION, AWS_DEFAULT_REGION                                                                                                                            | SDK region when neither set                                                                                         | harness/deepagents/src/botcube_harness_deepagents/llm.py                                |
| BOTCUBE_ENV_FILE                                                                                                                                          | .env at repository root; process env wins                                                                           | harness/deepagents/src/botcube_harness_deepagents/_env.py                               |
| BOTCUBE_WORKSPACE, BOTCUBE_CHECKPOINT_PATH, BOTCUBE_CARTRIDGE_MODULE                                                                                      | home directory, unset, exactly one installed `botcube.cartridge` entry point; module env overrides discovery        | harness/deepagents/src/botcube_harness_deepagents/serving.py                            |
| BOTCUBE_HARNESS_HOST / BOTCUBE_SESSION_API_HOST, PORT                                                                                                     | 0.0.0.0, 8080 / 8081                                                                                                | harness/deepagents/src/botcube_harness_deepagents/serving.py; session_api.py            |
| BOTCUBE_HARNESS_KEEPALIVE_SECONDS, BOTCUBE_LTM_PREFERENCE_LIMIT, BOTCUBE_LTM_FACT_LIMIT                                                                   | 15, 50, 50                                                                                                          | harness/deepagents/src/botcube_harness_deepagents/serving.py                            |
| BOTCUBE_ACTIVITY_SESSIONS_AT_ONCE                                                                                                                         | 10                                                                                                                  | harness/deepagents/src/botcube_harness_deepagents/session_api.py                        |
| BOTCUBE_MEMORY_SAVE_WINDOW_SECONDS, BOTCUBE_PENDING_MEMORY_WINDOW_SECONDS                                                                                 | 300, 900                                                                                                            | harness/deepagents/src/botcube_harness_deepagents/memory_document.py; pending_memory.py |
| BOTCUBE_TURN_MESSAGE_LOG_LIMIT                                                                                                                            | 2000                                                                                                                | harness/deepagents/src/botcube_harness_deepagents/prompt_cache_observability.py         |
| AGENTCORE_MEMORY_ID, AGENTCORE_REGION                                                                                                                     | unset, us-east-1                                                                                                    | harness/deepagents/src/botcube_harness_deepagents/serving.py                            |
| `BOTCUBE_MEMORY_PATH`; `memory_path`, `repo_root` args                                                                                                    | .tmp/botcube-harness-deepagents/memory.md in repository, tmp/botcube-harness-deepagents/memory.md standalone        | harness/deepagents/src/botcube_harness_deepagents/memory_files.py                       |
| `BOTCUBE_LOCAL_DYNAMODB_IMAGE`                                                                                                                            | `amazon/dynamodb-local:3.3.0`                                                                                       | `infra/local/compose.yml`                                                               |
| `BOTCUBE_LOCAL_PYTHON_IMAGE`, `BOTCUBE_LOCAL_UV_IMAGE`                                                                                                    | `public.ecr.aws/docker/library/python:3.13-slim`, `ghcr.io/astral-sh/uv:latest`                                     | `infra/local/{compose.yml,harness.Dockerfile}`                                          |
| `BOTCUBE_LOCAL_NODE_IMAGE`                                                                                                                                | `public.ecr.aws/docker/library/node:24-slim`                                                                        | `infra/local/{compose.yml,chat.Dockerfile,ui.Dockerfile}`                               |
| `BOTCUBE_LOCAL_CHAT_PORT`, `BOTCUBE_LOCAL_UI_PORT`                                                                                                        | `8123`, `3001`                                                                                                      | `infra/local/{compose.yml,smoke.sh}`                                                    |
| `BOTCUBE_LOCAL_CHAT_URL`, `BOTCUBE_LOCAL_UI_URL`                                                                                                          | localhost URLs derived from published ports                                                                         | `infra/local/smoke.sh`                                                                  |
| `NEXT_PUBLIC_CHAT_SERVICE_URL`                                                                                                                            | `http://localhost:8123`, derived from published Chat port                                                           | `infra/local/compose.yml`                                                               |
| `AWS_DEFAULT_REGION`, `BOTCUBE_CHAT_TABLE`, `BOTCUBE_MODEL`, `BOTCUBE_CHECKPOINT_PATH`                                                                    | `us-east-1`, `chat`, `echo`, `/var/lib/botcube-harness/checkpoints.sqlite3`                                         | `infra/local/compose.yml`                                                               |
| `BOTCUBE_BUILD_CA_CERTS`                                                                                                                                  | system CA roots; optional combined CA bundle for host staging and BuildKit                                          | `infra/local/run.sh`, `compose.build-ca.yml`, Dockerfiles                               |
| existing `WebUiPlugin.config`, `CARTRIDGE_UI_PACKAGE`, `CARTRIDGE_UI_BUILD_CONFIG`, `BOTCUBE_REPOSITORY_ROOT`, `NEXT_PUBLIC_CHAT_SERVICE_URL`             | neutral BotCube branding and `http://localhost:8123`; default Cartridge                                             | `ui/web/{next.config.ts,src/cartridge/default.tsx,src/app/chat-surface.tsx}`            |
| `BOTCUBE_REPOSITORY_ROOT` (ECS CDK)                                                                                                                       | four directories above the ECS CDK project (current monorepo root)                                                  | `infra/ecs/cdk/bin/cdk.ts`                                                              |
| existing `NEXT_PUBLIC_RUM_*`                                                                                                                              | disabled when app monitor config is absent                                                                          | `ui/web/src/app/rum.ts`                                                                 |
| `BOTCUBE_OPENAI_ISSUER`, `BOTCUBE_OPENAI_RESOURCE`, `BOTCUBE_OPENAI_API_ORIGIN`, `BOTCUBE_OPENAI_DYNAMIC_CLIENT_ID`                                       | `https://auth.openai.com`, `https://api.openai.com/v1`, `https://api.openai.com`, `dynamic_agent_client`            | `credential-service/src/botcube_credential_service/config.py`                           |
| `BOTCUBE_OPENAI_EXPIRY_MARGIN_SECONDS`, `BOTCUBE_OPENAI_REFRESH_LEASE_SECONDS`, `BOTCUBE_OPENAI_LEASE_WAIT_SECONDS`, `BOTCUBE_OPENAI_LEASE_POLL_SECONDS`  | `60`, `30`, `45`, `0.2`                                                                                             | `credential-service/src/botcube_credential_service/openai.py`                           |
| `BOTCUBE_OPENAI_READ_TIMEOUT_SECONDS`, `BOTCUBE_OPENAI_CONNECT_TIMEOUT_SECONDS`, `BOTCUBE_OPENAI_SIGN_IN_TIMEOUT_SECONDS`, `BOTCUBE_OPENAI_LOOPBACK_PORT` | `300`, `30`, `30`, `1455`                                                                                           | Credential Service OpenAI relay and Sign-in                                             |
| `BOTCUBE_OPENAI_AGENT_NAME`, `--agent-name`; Sign-in `--region`                                                                                           | `BotCube Plan Usage`; SDK region                                                                                    | Credential Service Sign-in                                                              |
| `CredentialAuditRecorder(decrypt_rate_limit=, decrypt_window_seconds=)`; `sign_credential_service_invocation(ttl_seconds=)`                               | `30`, `60`; `600` seconds                                                                                           | Credential Service Python inputs                                                        |
| `CredentialServiceSettings`; `DynamoDbCredentialVault(table, kms)`; `KmsDataKeyProvider(key_id=, region_name=)`                                           | Caller supplies service identity, headers, table, and key; SDK region                                               | Credential Service composition                                                          |
| `BOTCUBE_TURN_MAX_TOKENS`                                                                                                                                 | `16000` live-turn model budget                                                                                      | `harness/deepagents/src/botcube_harness_deepagents/serving.py`                          |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`                                                                                               | Provider SDK endpoint and credentials                                                                               | Harness existing provider SDKs                                                          |
| `CARTRIDGE_DEPLOY_ROOT`; Cartridge `identity.json`, `agentcore.json`, `aws-targets.json`                                                                  | Deploy root required; names, account, region, domains, ARNs, and build inputs come from the Cartridge               | `infra/agentcore/cdk/lib/deploy-config.ts`                                              |
| `executionRole`, `vpc`, `subnets`, `securityGroups`, `kmsKey`, `permissionsBoundary`                                                                      | Role generated, public runtime or configured network, no Memory KMS key, no boundary                                | `AgentCoreStackProps`; `addAgentCoreStacks` overrides                                   |
| `executionRole`, `vpc`, `publicSubnets`, `privateSubnets`, `kmsKey`, `permissionsBoundary`                                                                | Execution role and Vault key generated, identity-based VPC and subnets, no boundary                                 | `ProductionOptions`                                                                     |
| `chatTableName`, `turnSummaryModel`                                                                                                                       | `chat`, `anthropic.claude-haiku-4-5-20251001-v1:0`                                                                  | `ProductionOptions`                                                                     |
| `runtimeMaxLifetimeSeconds`                                                                                                                               | `3600`                                                                                                              | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `runtimeIdleTimeoutSeconds`                                                                                                                               | `900`                                                                                                               | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `workspace`                                                                                                                                               | `/mnt/workspace`                                                                                                    | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `sessionApiLogRetention`                                                                                                                                  | `logs.RetentionDays.ONE_MONTH`                                                                                      | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `sessionApiMemoryMiB`                                                                                                                                     | `1024`                                                                                                              | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `sessionApiTimeoutSeconds`                                                                                                                                | `900`                                                                                                               | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `sessionApiProvisionedConcurrency`                                                                                                                        | `5`                                                                                                                 | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `port`                                                                                                                                                    | `8123`                                                                                                              | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `cpu`                                                                                                                                                     | `512`                                                                                                               | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `memoryLimitMiB`                                                                                                                                          | `1024`                                                                                                              | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `logRetention`                                                                                                                                            | `logs.RetentionDays.ONE_WEEK`                                                                                       | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `browserId`                                                                                                                                               | `'aws.browser.v1'`                                                                                                  | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `containerStopTimeoutSeconds`                                                                                                                             | `120`                                                                                                               | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `scheduledRunVisibilitySeconds`                                                                                                                           | `900`                                                                                                               | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `scheduledRunRetentionDays`                                                                                                                               | `14`                                                                                                                | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `scheduledRunMaxReceiveCount`                                                                                                                             | `3`                                                                                                                 | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperCpu`                                                                                                                                               | `256`                                                                                                               | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperMemoryLimitMiB`                                                                                                                                    | `512`                                                                                                               | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperLogRetention`                                                                                                                                      | `logs.RetentionDays.ONE_WEEK`                                                                                       | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperSchedule`                                                                                                                                          | `'rate(5 minutes)'`                                                                                                 | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperRetryAttempts`                                                                                                                                     | `0`                                                                                                                 | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperMaxEventAgeSeconds`                                                                                                                                | `60`                                                                                                                | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `serviceName`                                                                                                                                             | `'chat-service-preview'`                                                                                            | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `desiredCount`                                                                                                                                            | `1`                                                                                                                 | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `minHealthyPercent`                                                                                                                                       | `100`                                                                                                               | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `maxHealthyPercent`                                                                                                                                       | `200`                                                                                                               | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `healthGraceSeconds`                                                                                                                                      | `60`                                                                                                                | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `alarmPeriodSeconds`                                                                                                                                      | `60`                                                                                                                | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `alarmEvaluationPeriods`                                                                                                                                  | `3`                                                                                                                 | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `failureAlarmPeriodSeconds`                                                                                                                               | `300`                                                                                                               | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `healthIntervalSeconds`                                                                                                                                   | `5`                                                                                                                 | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `healthTimeoutSeconds`                                                                                                                                    | `4`                                                                                                                 | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `healthHealthyThreshold`                                                                                                                                  | `2`                                                                                                                 | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `healthUnhealthyThreshold`                                                                                                                                | `6`                                                                                                                 | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `drainSeconds`                                                                                                                                            | `3600`                                                                                                              | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `loadBalancerIdleSeconds`                                                                                                                                 | `3600`                                                                                                              | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `cpu`                                                                                                                                                     | `512`                                                                                                               | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `memoryLimitMiB`                                                                                                                                          | `1024`                                                                                                              | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `invocationTokenLength`                                                                                                                                   | `64`; integer of at least `32` characters                                                                           | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `logRetention`                                                                                                                                            | `logs.RetentionDays.ONE_YEAR`                                                                                       | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `healthIntervalSeconds`                                                                                                                                   | `10`                                                                                                                | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `healthTimeoutSeconds`                                                                                                                                    | `5`                                                                                                                 | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `healthRetries`                                                                                                                                           | `9`                                                                                                                 | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `healthStartPeriodSeconds`                                                                                                                                | `5`                                                                                                                 | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `serviceName`                                                                                                                                             | `'credential-service'`                                                                                              | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `desiredCount`                                                                                                                                            | `1`                                                                                                                 | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `minHealthyPercent`                                                                                                                                       | `100`                                                                                                               | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `maxHealthyPercent`                                                                                                                                       | `200`                                                                                                               | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `dnsName`                                                                                                                                                 | `'credentials'`                                                                                                     | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `dnsTtlSeconds`                                                                                                                                           | `10`                                                                                                                | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `errorAlarmPeriodSeconds`                                                                                                                                 | `300`                                                                                                               | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `errorAlarmThreshold`                                                                                                                                     | `1`                                                                                                                 | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `connectionLogExpirationDays`                                                                                                                             | `30`                                                                                                                | `infra/ecs/cdk/lib/preview-origin-stack.ts` CDK prop                                    |
| `providerTimeoutSeconds`                                                                                                                                  | `120`                                                                                                               | `infra/ecs/cdk/lib/preview-origin-stack.ts` CDK prop                                    |
| `providerLogRetention`                                                                                                                                    | `logs.RetentionDays.ONE_WEEK`                                                                                       | `infra/ecs/cdk/lib/preview-origin-stack.ts` CDK prop                                    |
| `clientKeepAliveSeconds`                                                                                                                                  | `60`                                                                                                                | `infra/ecs/cdk/lib/preview-origin-stack.ts` CDK prop                                    |
| `requestIntervalSeconds`                                                                                                                                  | `30`                                                                                                                | `infra/ecs/cdk/lib/api-health-stack.ts` CDK prop                                        |
| `failureThreshold`                                                                                                                                        | `3`                                                                                                                 | `infra/ecs/cdk/lib/api-health-stack.ts` CDK prop                                        |
| `evaluationPeriods`                                                                                                                                       | `2`                                                                                                                 | `infra/ecs/cdk/lib/api-health-stack.ts` CDK prop                                        |
| `sessionSampleRate`                                                                                                                                       | `1`                                                                                                                 | `infra/ecs/cdk/lib/web-latency-stack.ts` CDK prop                                       |
| `tableName`                                                                                                                                               | `'chat'`                                                                                                            | `infra/ecs/cdk/lib/chat-storage-stack.ts` CDK prop                                      |

Runtime lifecycle overrides must be integer seconds from `60` through `3600` for `runtimeMaxLifetimeSeconds` and `60` through `900` for `runtimeIdleTimeoutSeconds`. ADR 0029 keeps these upper limits permanent.

`browserId` applies to standalone `PreviewChatService`. `defineProduction` binds the login browser from the Cartridge deployment identity and creates its separate Agent Computer browser.

## Follow the template Cartridge seams

The [template README](template/README.md) describes the local stack and its limits. The files below show where to replace each seam for your application.

### Supply a CLI and skills through bash

The [Harness definition](template/src/botcube_template/harness.py) exports `CARTRIDGE`. It prepares the [packaged skill](template/src/botcube_template/skills/SKILL.md), validates shell commands, and forwards invocation-scoped environment variables. Its policy accepts `echo`, `template-cli data`, and documented `agent-browser` commands.

The [staging hook](template/deploy/stage-tools.sh) packages the Cartridge wheel, offline CLI, and browser tools for the [Harness image](harness/deepagents/Dockerfile). The [fake CLI](template/src/botcube_template/fake_cli.py) calls the Credential Service with the invocation binding. It receives data rather than site credentials. Replace this executable, skill, and command policy together.

### Bind site Sign-in to an Account

The [Chat Cartridge](template/chat/src/cartridge.ts) composes the [Account policy](template/chat/src/account.ts) and [Sign-in routes](template/chat/src/sign-in.ts). Local browsers receive opaque Account session cookies that expire after a day and reset when Chat Service restarts.

The [fake site](template/src/botcube_template/fake_site.py) issues a Durable Credential after a button click. The [site provider](template/src/botcube_template/site_provider.py), registered by the [Credential Service entry point](template/src/botcube_template/credential_service.py), captures and stores it in the encrypted Vault. Configure that service and the Chat Service as described in the template README.

For each Turn, `invocationPayload` signs a Credential Service invocation bound to the Account and Session. The Harness forwards that invocation and service URL to the CLI. The Credential Service mints short-lived access and attaches it to the site request. Unlinking deletes the vaulted credential, and the next CLI call fails with Sign-in needed. Use your provider's Sign-in flow and Account policy at these same boundaries.

### Connect the Agent Computer

The [computer adapter](template/chat/src/computer.ts) authorizes the owning Account and Session. Its [local implementation](template/chat/src/local-computer.ts) manages Chromium with a private profile and issues a ten-minute signed CDP URL. The Harness exposes the URL as `AGENT_BROWSER_CDP` to its permitted browser commands.

The adapter filters credential-export commands and cookie data from network events. Retirement closes CDP channels, deletes the private profile, and invalidates its signed URL. The [Computer view](template/ui/web/src/computer-view.tsx) uses the owner-authorized live-view endpoint. This local adapter has no Take-over; AWS browser acceptance remains a separate check.

### Bind scheduled runs to the Account

The Chat Cartridge's `scheduledRequester` restores the task owner's Account. Its `invocationPayload` creates the same scoped Credential Service binding for scheduled and interactive Turns. The generic [task routes](chat/src/scheduled-tasks.ts) and [run handler](chat/src/scheduled-runs.ts) remain in BotCube. The Harness [proposal tool](harness/deepagents/src/botcube_harness_deepagents/scheduled_tasks.py) proposes a task, and the user confirms it before creation.

The template echo model does not propose or execute tools. Run `pnpm test:chat --reporter=verbose` for generic Chat Service tests and neutral HTTP smoke. Exercise your own Cartridge's tool execution, scheduling, and Sign-in behavior with its configured model and providers.

### Bind the UI slots

The [UI plugin](template/ui/web/src/index.ts) exports `webUiPlugin`. It supplies the auth provider, Sign-ins tab, Computer view, browser panels, site-data renderer, file links, and theme through the [typed UI contract](ui/web/src/cartridge/types.ts). Replace those slots in your Cartridge and bind its package with `CARTRIDGE_UI_PACKAGE`.

### Keep deployment choices in the Cartridge

The [identity guide](template/IDENTITY.md) covers renaming and generating the template's shared identity. The [deploy identity](template/deploy/identity.json) owns account, region, resource names, domains, networking, and environment-key bindings. Its AWS resource values are placeholders. The [AgentCore project](template/deploy/agentcore/agentcore.json) and [AWS targets](template/deploy/agentcore/aws-targets.json) supply runtime, artifact, and synthesis inputs.

Replace those inputs before deployment. Use the generic CDK composition above when supplying existing resources. Local template behavior and synthesized templates do not prove parity with a deployed AWS stack.
