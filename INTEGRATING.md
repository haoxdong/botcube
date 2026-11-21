# Integrate BotCube with your application

BotCube gives you a web UI, a Chat Service, and a Harness. Your bot is configuration, not code (ADR 0091): its settings and skills in an image built on BotCube's Harness image, a Deployment Config, and a deploy root. Start from the public example, [`examples/bot/`](examples/bot/) and [`examples/public/`](examples/public/), then replace its inputs with your own. The example runs without external provider or AWS credentials.

## Run the example in a clean clone

Install Docker with Compose, Git, Python 3, curl, uv, Node.js 24 or newer, Corepack, and npm. Clone [the public BotCube repository](https://github.com/haoxdong/botcube) over HTTPS.

```bash
git clone https://github.com/haoxdong/botcube.git
cd botcube
bash infra/local/run.sh -d
```

Open `http://localhost:3001`. Send `hello cube` and expect `Echo: hello cube`. The example bot's echo model makes no tool calls and uses no AWS or model-provider credentials. DynamoDB Local stores Session Metadata, and SQLite stores Harness checkpoints in Docker volumes. [The local sandbox README](infra/local/README.md) lists what each service runs.

Run the same smoke check as CI.

```bash
bash infra/local/smoke.sh
```

The check verifies a turn, replay after Harness restart, deletion, rejection of an invalid request, and the UI. Stop the sandbox with `docker compose -f infra/local/compose.yml down`. Add `--volumes` only when you want to discard the sandbox's saved sessions.

## Build and test the public workspace

Use the pinned `pnpm@12.10.1` through Corepack. From the public repository root, install the workspace dependencies and build the web UI and Chat Service:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test:chat --reporter=verbose
```

`pnpm test:chat` runs generic Chat Service unit tests and the neutral HTTP smoke check; its pretest hook prepares the Harness and Credential Service Python environments and the Chat Service bundle. `pnpm test:chat:unit` runs only the unit tests. The container commands above verify the complete local application separately.

Run each CDK package's build and tests from its directory. Set `BOTCUBE_DEPLOY_ROOT` to your deploy root for composition and synthesis. The example's deployment settings are placeholders; replace them before using your AWS account.

## Build production artifacts

From the public repository root, build BotCube's Harness image, your bot's image on it, and the session API, Chat Service, and Credential Service images:

```bash
docker build -f harness/deepagents/Dockerfile --target harness -t botcube-harness harness/deepagents
docker build --build-context harness=docker-image://botcube-harness -t bot examples/bot
docker build -f harness/deepagents/session-api.Dockerfile -t session-api harness/deepagents
docker build -f chat/Dockerfile --build-arg BOTCUBE_ROOT=. -t chat .
docker build -f credential-service/Dockerfile --build-arg BOTCUBE_ROOT=. -t credential .
```

The Chat Service image is stock and ships the Deployment Configs under `examples/`; set `BOTCUBE_DEPLOYMENT_CONFIG` to the one it runs, such as `/opt/chat-service/examples/public/deployment-config.json`. The stock Credential Service serves OpenAI and any models Endpoint, with no site provider. It reads its Vault from `BOTCUBE_VAULT_TABLE` and `BOTCUBE_VAULT_KMS_KEY_ID` and its invocation secret from `BOTCUBE_CREDENTIAL_INVOCATION_SECRET`.

Export the static UI with the URL of your deployed Chat Service:

```bash
docker build -f ui/web/Dockerfile --target artifact \
  --build-arg NEXT_PUBLIC_CHAT_SERVICE_URL=https://your-chat.example \
  --output type=local,dest=ui-artifact .
```

The export writes the UI files to `ui-artifact/`. Omit `--target` and `--output` and add an image tag to build its static server image, which listens on port 3001. Set `CARTRIDGE_UI_PACKAGE` and, when needed, `CARTRIDGE_UI_BUILD_CONFIG` through build arguments to bind your UI plugin.

Exercise the production images against the neutral local infrastructure:

```bash
BOTCUBE_PRODUCTION_ARTIFACTS=1 bash infra/local/run.sh -d
BOTCUBE_PRODUCTION_ARTIFACTS=1 bash infra/local/smoke.sh
```

This builds the production Harness, example bot, Chat Service, session API, and UI images, keeping the local stand-in Credential Service and fake site, and verifies Turn, replay after Harness restart, delete, invalid-request rejection, and UI responses. Stop this stack with `docker compose -f infra/local/compose.yml -f infra/local/compose.production.yml down`.

For a build behind your organization's TLS proxy, pass its CA bundle with `--secret id=build_ca,src=<bundle>`. Compose accepts the same bundle through `BOTCUBE_BUILD_CA_CERTS`. Build trust does not configure runtime trust.

## Connect the three pieces

The UI sends AG-UI requests to the Chat Service at `POST /`. The Chat Service owns request identity and Session Metadata. It relays turns to the Harness's `POST /invocations`, which streams AG-UI server-sent events. A Harness exposes `GET /ping` for health on port 8080.

The Chat Service exposes `GET /threads`, `GET /threads/{id}`, and `DELETE /threads/{id}` for session listing, replay, and deletion. It gets session content from the Harness's separate session API, rather than keeping a second conversation record. See [the Chat Service contract](chat/README.md) and [the Harness contract](harness/deepagents/README.md).

The sandbox uses local plain HTTP. Memory IDs and runtime ARNs may be supported unresolved CDK resource references.

## Supply your bot

- **Bot settings and skills.** Copy [`examples/bot/`](examples/bot/). [`bot.json`](examples/bot/bot.json) follows [the bot settings schema](deployment-config/bot-settings.schema.json): agent identity, account key, models, skills, Memory, and Agent Computer. Each skill is a directory holding a `SKILL.md`.
- **Bot image.** The bot's [`Dockerfile`](examples/bot/Dockerfile) builds `FROM harness`, and copies the settings and skills to where the Deployment Config names them. Install your bot's CLIs there, on the `PATH`. The bot runs no code in BotCube's processes.
- **Deployment Config.** [`examples/public/deployment-config.json`](examples/public/deployment-config.json) names the bot settings and picks each External Service's adapter; see [the schema](deployment-config/deployment-config.schema.json). [`examples/enterprise/`](examples/enterprise/) shows supplied resources.
- **Deploy root.** Copy [`examples/public/deploy/`](examples/public/deploy/). [`identity.json`](examples/public/deploy/identity.json) owns account, region, resource names, domains, networking, and the tool-staging hook. [`agentcore/agentcore.json`](examples/public/deploy/agentcore/agentcore.json) and [`agentcore/aws-targets.json`](examples/public/deploy/agentcore/aws-targets.json) supply runtime, memory, and synthesis inputs. AgentCore's CodeBuild has no named build contexts, so [`stage-tools.sh`](examples/public/deploy/stage-tools.sh) writes one Dockerfile, the Harness's then the bot's, to `harness/deepagents/.tool-dist/`; point it at your bot.
- **Services.** The [stock Chat Service](chat/src/stock.ts) and stock Credential Service need no code. The stock Chat Service's `openai-compatible` `models` take `wire`: `chat-completions` (default), or `responses` for a Responses-only gateway; Turn summaries and the Harness use it, and `botcube footprint` prints it. A deploy root may ship its own `credential-service/Dockerfile`, for a site provider, or a `chat/Dockerfile` beside it; the ECS app builds those instead. [The local stand-ins](infra/local/stand-ins/) show a fake site provider.
- **UI.** [The default UI plugin](ui/web/src/cartridge/default.tsx) supplies neutral copy, auth, and theme through the [typed UI contract](ui/web/src/cartridge/types.ts). Bind your own plugin package with `CARTRIDGE_UI_PACKAGE` at build time.

## Run it in your AWS account

1. Copy `examples/bot/` and `examples/public/` into your application. Keep the echo model until the three pieces work together.
2. Set your account, region, names, and domains in `deploy/identity.json`, and the same account and region in `deploy/agentcore/aws-targets.json`.
3. Set the runtime and memory inputs in `deploy/agentcore/agentcore.json`. Configure your bot's models and the Deployment Config's model seam before enabling a real model.
4. Build the generic AgentCore CDK package and load your deploy root with `BOTCUBE_DEPLOY_ROOT`. An AWS target that disagrees with `identity.json` fails before synthesis.
5. Compose the CDK stacks in your application. Pass existing resources through the props in the reference below. Imported resources remain your application's responsibility, including trust policies, network routing, and access grants.
6. Synthesize with your overrides, inspect the templates, and compare with your deployed stack before your organization's deployment process runs. See [AgentCore CDK commands](infra/agentcore/cdk/README.md) and [ECS CDK commands](infra/ecs/cdk/README.md).
7. Set the Chat Service's Harness endpoint, signing choice, session API, storage, and origins. Build the UI with your plugin and its Chat Service URL. Verify a successful turn, session replay, and a rejected request.

From the root of the standalone mirror, use the pinned Corepack/pnpm workspace installation above, then synthesize the example.

```bash
export BOTCUBE_DEPLOY_ROOT="$PWD/examples/public/deploy"
corepack pnpm --dir infra/agentcore/cdk build
corepack pnpm --dir infra/agentcore/cdk cdk synth
```

The example uses the placeholder account `000000000000`. Set your account in both identity and target files before deployment. Synthesis runs the deploy root's tool-staging hook and may build Docker assets. It does not deploy resources.

[`infra/ecs/cdk/example/app.ts`](infra/ecs/cdk/example/app.ts) defines both CDK apps from a Deployment Config with `defineExample`. The Chat Service image must ship that config and the bot settings it names, so copy them in `chat/Dockerfile`.

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
    process.env.BOTCUBE_DEPLOY_ROOT,
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

Replace the placeholder IDs and ARNs with your resources. Run your deploy root's tool-staging hook before synthesizing a custom app. The imported execution role needs AgentCore trust and runtime infrastructure permissions, with no AgentCore Memory or cross-account data grants (ADR 0067). Its policies remain caller-owned; BotCube does not rewrite imported role policies. Supply security groups through `securityGroups` when your network policy requires them. The AgentCore memory key must permit the memory service, the session API role and the user Memory role; the Harness runtime reaches Memory only with each Turn's tagged credentials for that role (ADR 0067 §8). The subnet routes must reach the services the runtime uses, including STS.

The [example deploy identity](examples/public/deploy/identity.json) contains placeholder AgentCore and ECS inputs. For corporate ECS composition, replace its placeholders and supply your origin inputs, then pass `executionRole`, `vpc`, `publicSubnets`, `privateSubnets`, `kmsKey`, and `permissionsBoundary` to `defineProduction`. When you supply `vpc`, private consumers use that VPC's private subnets unless you set `privateSubnets`. An explicit subnet selection takes precedence, and an empty private selection fails synthesis. Pass service settings through `chat` and `credentials`. Pass origin, monitoring, and RUM settings through `originConfig`, `apiHealth`, and `webLatency`. Supply the UI's latency event names as `webLatency.moments` when no `latency-budgets.json` sits beside your deploy root. Omitted moments retain the file-based budget input and fail if it is absent. The generic entry point accepts the same names through the `webLatencyMoments` CDK context ([ECS CDK commands](infra/ecs/cdk/README.md)). The ECS execution role pulls images and writes logs. The task role owns application access. The imported Credential Vault key must authorize decrypt only for the Credential Service task role. Use a different key for AgentCore memory. Use the example identity as the shape reference, not as a deployable account configuration.

For bot-specific container settings, pass an `environment` map to `PreviewChatService` or `PrivateCredentialService`. Production composition forwards `chat.environment` and `credentials.environment`. Framework-owned values, including serving ports and regions, take precedence over caller entries. The Chat image installs Chromium, which the local Agent Computer runs with no configuration.

For the generic ECS CDK entry point, set `BOTCUBE_REPOSITORY_ROOT` to the absolute checkout root when running from a standalone BotCube mirror. This controls the image build context and deploy-root asset paths. If unset, it retains the current monorepo root; relative values resolve from `infra/ecs/cdk`.

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

Unset options preserve the current behavior. Names below are environment variables unless identified as CDK props or deploy-root fields. Timing and capacity limits must be positive. The OpenAI loopback port accepts `0` through `65535`. Provider endpoint overrides configure existing providers.

| Configuration                                                                                                                                 | Default                                                                                                 | Owner                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| AWS_REGION, AWS_ENDPOINT_URL_BEDROCK_AGENTCORE, AGENTCORE_RUNTIME_ARN                                                                         | us-east-1, regional AgentCore endpoint, no ARN                                                          | chat/src/upstream.ts                                                                    |
| BOTCUBE_LOCAL_HARNESS_URL, BOTCUBE_LOCAL_SESSION_API_URL, BOTCUBE_SESSION_API_FUNCTION_ARN, AWS_ENDPOINT_URL_LAMBDA                           | unset                                                                                                   | chat/src/server.ts                                                                      |
| BOTCUBE_CHAT_TABLE, BOTCUBE_CORS_ORIGINS, AGENTCORE_BROWSER_ID, PORT                                                                          | chat, local UI origins, aws.browser.v1, 8123                                                            | chat/src/server.ts                                                                      |
| BOTCUBE_CHROMIUM_PATH, BOTCUBE_AGENT_COMPUTER_CDP_URL                                                                                         | /usr/bin/chromium, ws://127.0.0.1:$PORT/agent-computer/cdp; the local Agent Computer                    | chat/src/local-agent-computer.ts                                                        |
| AWS_ENDPOINT_URL_BEDROCK_RUNTIME                                                                                                              | regional Bedrock Runtime URL                                                                            | chat/src/turn-summaries.ts                                                              |
| BOTCUBE_SCHEDULE_GROUP, BOTCUBE_SCHEDULER_ROLE_ARN, BOTCUBE_SCHEDULED_RUNS_QUEUE_ARN, BOTCUBE_SCHEDULED_RUNS_QUEUE_URL                        | unset; scheduling absent                                                                                | chat/src/scheduled-tasks.ts                                                             |
| AWS_DEFAULT_REGION                                                                                                                            | us-east-1                                                                                               | chat/src/agent-documents.ts, session-metadata.ts, scheduled-tasks.ts, scheduled-runs.ts |
| build_model model/region_name/max_tokens/effort args; the bot settings' first model                                                           | us.anthropic.claude-sonnet-4-6, medium, 128; a Turn runs on its bot's first model unless it names one   | harness/deepagents/src/botcube_harness_deepagents/llm.py                                |
| AWS_REGION, AWS_DEFAULT_REGION                                                                                                                | SDK region when neither set                                                                             | harness/deepagents/src/botcube_harness_deepagents/llm.py                                |
| BOTCUBE_WORKSPACE, BOTCUBE_CHECKPOINT_PATH                                                                                                    | home directory, unset                                                                                   | harness/deepagents/src/botcube_harness_deepagents/serving.py                            |
| BOTCUBE_DEPLOYMENT_CONFIG                                                                                                                     | required by the stock Chat Service                                                                      | chat/src/stock.ts                                                                       |
| PORT                                                                                                                                          | 8080 / 8081                                                                                             | harness/deepagents/src/botcube_harness_deepagents/serving.py; session_api.py            |
| BOTCUBE_ACTIVITY_SESSIONS_AT_ONCE                                                                                                             | 10                                                                                                      | harness/deepagents/src/botcube_harness_deepagents/session_api.py                        |
| AGENTCORE_MEMORY_ID, AWS_REGION                                                                                                               | unset, us-east-1                                                                                        | harness/deepagents/src/botcube_harness_deepagents/serving.py                            |
| BOTCUBE_USER_MEMORY_ROLE_ARN                                                                                                                  | unset                                                                                                   | `harness/deepagents/src/botcube_harness_deepagents/memory/agentcore/__init__.py`        |
| `BOTCUBE_LOCAL_DYNAMODB_IMAGE`                                                                                                                | `amazon/dynamodb-local:3.3.0`                                                                           | `infra/local/compose.yml`                                                               |
| `BOTCUBE_LOCAL_PYTHON_IMAGE`, `BOTCUBE_LOCAL_UV_IMAGE`                                                                                        | `public.ecr.aws/docker/library/python:3.13-slim`, `ghcr.io/astral-sh/uv:latest`                         | `infra/local/{compose.yml,harness.Dockerfile}`                                          |
| `BOTCUBE_LOCAL_NODE_IMAGE`                                                                                                                    | `public.ecr.aws/docker/library/node:24-slim`                                                            | `infra/local/{compose.yml,chat.Dockerfile,ui.Dockerfile}`                               |
| `BOTCUBE_LOCAL_CHAT_PORT`, `BOTCUBE_LOCAL_UI_PORT`                                                                                            | `8123`, `3001`                                                                                          | `infra/local/{compose.yml,smoke.sh}`                                                    |
| `BOTCUBE_LOCAL_CHAT_URL`, `BOTCUBE_LOCAL_UI_URL`                                                                                              | localhost URLs derived from published ports                                                             | `infra/local/smoke.sh`                                                                  |
| `NEXT_PUBLIC_CHAT_SERVICE_URL`                                                                                                                | `http://localhost:8123`, derived from published Chat port                                               | `infra/local/compose.yml`                                                               |
| `AWS_DEFAULT_REGION`, `BOTCUBE_CHAT_TABLE`, `BOTCUBE_CHECKPOINT_PATH`                                                                         | `us-east-1`, `chat`, `/var/lib/botcube-harness/checkpoints.sqlite3`                                     | `infra/local/compose.yml`                                                               |
| `BOTCUBE_BUILD_CA_CERTS`                                                                                                                      | system CA roots; optional combined CA bundle for host staging and BuildKit                              | `infra/local/run.sh`, `compose.build-ca.yml`, Dockerfiles                               |
| existing `WebUiPlugin.config`, `CARTRIDGE_UI_PACKAGE`, `CARTRIDGE_UI_BUILD_CONFIG`, `BOTCUBE_REPOSITORY_ROOT`, `NEXT_PUBLIC_CHAT_SERVICE_URL` | neutral BotCube branding and `http://localhost:8123`; default Cartridge                                 | `ui/web/{next.config.ts,src/cartridge/default.tsx,src/app/chat-surface.tsx}`            |
| `BOTCUBE_REPOSITORY_ROOT` (ECS CDK)                                                                                                           | four directories above the ECS CDK project (current monorepo root)                                      | `infra/ecs/cdk/bin/cdk.ts`                                                              |
| existing `NEXT_PUBLIC_RUM_*`; `NEXT_PUBLIC_RELEASE`, the release RUM events carry                                                             | disabled when app monitor config is absent; `unreleased`                                                | `ui/web/src/app/rum.ts`                                                                 |
| `BOTCUBE_OPENAI_SIGN_IN_TIMEOUT_SECONDS`, `BOTCUBE_OPENAI_LOOPBACK_PORT`                                                                      | `30`, `1455`                                                                                            | Credential Service OpenAI Sign-in                                                       |
| `BOTCUBE_OPENAI_AGENT_NAME`, `--agent-name`; Sign-in `--region`                                                                               | `BotCube Plan Usage`; SDK region                                                                        | Credential Service Sign-in                                                              |
| `CredentialAuditRecorder(decrypt_rate_limit=, decrypt_window_seconds=)`; `sign_credential_service_invocation(ttl_seconds=)`                   | `30`, `60`; `600` seconds                                                                               | Credential Service Python inputs                                                        |
| `CredentialServiceSettings`; `DynamoDbCredentialVault(table, kms)`; `KmsDataKeyProvider(key_id=, region_name=)`                               | Caller supplies service identity, headers, table, and key; SDK region                                   | Credential Service composition                                                          |
| `BOTCUBE_DEPLOY_ROOT`; deploy root `identity.json`, `agentcore.json`, `aws-targets.json`                                                      | Deploy root required; names, account, region, domains, ARNs, and build inputs come from the deploy root | `infra/agentcore/cdk/lib/deploy-config.ts`                                              |
| `executionRole`, `vpc`, `subnets`, `securityGroups`, `kmsKey`, `permissionsBoundary`                                                          | Role generated, public runtime or configured network, no Memory KMS key, no boundary                    | `AgentCoreStackProps`; `addAgentCoreStacks` overrides                                   |
| `executionRole`, `vpc`, `publicSubnets`, `privateSubnets`, `kmsKey`, `permissionsBoundary`                                                    | Execution role and Vault key generated, identity-based VPC and subnets, no boundary                     | `ProductionOptions`                                                                     |
| `chatTableName`, `turnSummaryModel`                                                                                                           | `chat`, `anthropic.claude-haiku-4-5-20251001-v1:0`                                                      | `ProductionOptions`                                                                     |
| `runtimeMaxLifetimeSeconds`                                                                                                                   | `3600`                                                                                                  | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `runtimeIdleTimeoutSeconds`                                                                                                                   | `900`                                                                                                   | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `workspace`                                                                                                                                   | `/mnt/workspace`                                                                                        | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `sessionApiLogRetention`                                                                                                                      | `logs.RetentionDays.ONE_MONTH`                                                                          | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `sessionApiMemoryMiB`                                                                                                                         | `1024`                                                                                                  | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `sessionApiTimeoutSeconds`                                                                                                                    | `900`                                                                                                   | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `sessionApiProvisionedConcurrency`                                                                                                            | `5`                                                                                                     | `infra/agentcore/cdk/lib/cdk-stack.ts` CDK prop                                         |
| `port`                                                                                                                                        | `8123`                                                                                                  | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `cpu`                                                                                                                                         | `512`                                                                                                   | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `memoryLimitMiB`                                                                                                                              | `1024`                                                                                                  | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `logRetention`                                                                                                                                | `logs.RetentionDays.ONE_WEEK`                                                                           | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `browserId`                                                                                                                                   | `'aws.browser.v1'`                                                                                      | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `containerStopTimeoutSeconds`                                                                                                                 | `120`                                                                                                   | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `scheduledRunVisibilitySeconds`                                                                                                               | `900`                                                                                                   | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `scheduledRunRetentionDays`                                                                                                                   | `14`                                                                                                    | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `scheduledRunMaxReceiveCount`                                                                                                                 | `3`                                                                                                     | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperCpu`                                                                                                                                   | `256`                                                                                                   | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperMemoryLimitMiB`                                                                                                                        | `512`                                                                                                   | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperLogRetention`                                                                                                                          | `logs.RetentionDays.ONE_WEEK`                                                                           | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperSchedule`                                                                                                                              | `'rate(5 minutes)'`                                                                                     | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperRetryAttempts`                                                                                                                         | `0`                                                                                                     | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `reaperMaxEventAgeSeconds`                                                                                                                    | `60`                                                                                                    | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `serviceName`                                                                                                                                 | `'chat-service-preview'`                                                                                | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `minHealthyPercent`                                                                                                                           | `100`                                                                                                   | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `maxHealthyPercent`                                                                                                                           | `200`                                                                                                   | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `healthGraceSeconds`                                                                                                                          | `60`                                                                                                    | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `alarmPeriodSeconds`                                                                                                                          | `60`                                                                                                    | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `alarmEvaluationPeriods`                                                                                                                      | `3`                                                                                                     | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `failureAlarmPeriodSeconds`                                                                                                                   | `300`                                                                                                   | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `healthIntervalSeconds`                                                                                                                       | `5`                                                                                                     | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `healthTimeoutSeconds`                                                                                                                        | `4`                                                                                                     | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `healthHealthyThreshold`                                                                                                                      | `2`                                                                                                     | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `healthUnhealthyThreshold`                                                                                                                    | `6`                                                                                                     | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `drainSeconds`                                                                                                                                | `3600`                                                                                                  | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `loadBalancerIdleSeconds`                                                                                                                     | `3600`                                                                                                  | `infra/ecs/cdk/lib/preview-chat-service.ts` CDK prop                                    |
| `cpu`                                                                                                                                         | `512`                                                                                                   | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `memoryLimitMiB`                                                                                                                              | `1024`                                                                                                  | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `invocationTokenLength`                                                                                                                       | `64`; integer of at least `32` characters                                                               | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `logRetention`                                                                                                                                | `logs.RetentionDays.ONE_MONTH`                                                                          | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `healthIntervalSeconds`                                                                                                                       | `10`                                                                                                    | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `healthTimeoutSeconds`                                                                                                                        | `5`                                                                                                     | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `healthRetries`                                                                                                                               | `9`                                                                                                     | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `healthStartPeriodSeconds`                                                                                                                    | `5`                                                                                                     | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `serviceName`                                                                                                                                 | `'credential-service'`                                                                                  | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `desiredCount`                                                                                                                                | `1`                                                                                                     | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `minHealthyPercent`                                                                                                                           | `100`                                                                                                   | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `maxHealthyPercent`                                                                                                                           | `200`                                                                                                   | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `dnsName`                                                                                                                                     | `'credentials'`                                                                                         | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `dnsTtlSeconds`                                                                                                                               | `10`                                                                                                    | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `errorAlarmPeriodSeconds`                                                                                                                     | `300`                                                                                                   | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `errorAlarmThreshold`                                                                                                                         | `1`                                                                                                     | `infra/ecs/cdk/lib/private-credential-service.ts` CDK prop                              |
| `connectionLogExpirationDays`                                                                                                                 | `30`                                                                                                    | `infra/ecs/cdk/lib/preview-origin-stack.ts` CDK prop                                    |
| `providerTimeoutSeconds`                                                                                                                      | `120`                                                                                                   | `infra/ecs/cdk/lib/preview-origin-stack.ts` CDK prop                                    |
| `providerLogRetention`                                                                                                                        | `logs.RetentionDays.ONE_WEEK`                                                                           | `infra/ecs/cdk/lib/preview-origin-stack.ts` CDK prop                                    |
| `clientKeepAliveSeconds`                                                                                                                      | `60`                                                                                                    | `infra/ecs/cdk/lib/preview-origin-stack.ts` CDK prop                                    |
| `requestIntervalSeconds`                                                                                                                      | `30`                                                                                                    | `infra/ecs/cdk/lib/api-health-stack.ts` CDK prop                                        |
| `failureThreshold`                                                                                                                            | `3`                                                                                                     | `infra/ecs/cdk/lib/api-health-stack.ts` CDK prop                                        |
| `evaluationPeriods`                                                                                                                           | `2`                                                                                                     | `infra/ecs/cdk/lib/api-health-stack.ts` CDK prop                                        |
| `sessionSampleRate`                                                                                                                           | `1`                                                                                                     | `infra/ecs/cdk/lib/web-latency-stack.ts` CDK prop                                       |
| `tableName`                                                                                                                                   | `'chat'`                                                                                                | `infra/ecs/cdk/lib/chat-storage-stack.ts` CDK prop                                      |

Runtime lifecycle overrides must be integer seconds from `60` through `3600` for `runtimeMaxLifetimeSeconds` and `60` through `900` for `runtimeIdleTimeoutSeconds`. ADR 0029 keeps these upper limits permanent.

`browserId` applies to standalone `PreviewChatService`. `defineProduction` binds the login browser from the deploy identity and creates its separate Agent Computer browser.

## Generic seams

### Agent Computer

With no AgentCore browser, the Chat Service runs BotCube's [local Agent Computer](chat/src/local-agent-computer.ts): it authorizes the owning Account and Session and runs a [local Chromium](chat/src/local-chromium.ts) with a private profile per Session, opened on `about:blank` unless given a start page, through the Deployment Config's `proxy` when it names one, with its `noProxy` hosts as Chromium's bypass list. Each Turn gets a signed CDP URL for its Account and Session, valid for an hour; the agent's connection wakes the Session's computer. The Harness exposes the URL as `AGENT_BROWSER_CDP`, with one `AGENT_BROWSER_SESSION` per Session, to its permitted browser commands. With no configuration it runs the `/usr/bin/chromium` the Chat image installs, and a Chromium missing there fails the computer's start with HTTP 503.

The same [CDP channel](chat/src/agent-computer-cdp.ts) as an AgentCore Agent Computer's filters credential-export commands and cookie data from network events. Retirement closes CDP channels and deletes the private profile. Under the Deployment Config's `liveView: none` the UI requests no live view and says it is off. The local computer has no Take-over; AWS browser acceptance remains a separate check.

### Sign-in and scheduled runs

The stock Chat Service lists no site Sign-ins. Local browsers receive opaque Account session cookies that expire after a day and reset when Chat Service restarts. When `BOTCUBE_CREDENTIAL_SERVICE_URL` is set, the Chat Service signs each Turn a Credential Service invocation bound to the Account and Session; scheduled Turns restore the task owner's Account and get the same binding. The generic [task routes](chat/src/scheduled-tasks.ts) and [run handler](chat/src/scheduled-runs.ts) remain in BotCube. The Harness [proposal tool](harness/deepagents/src/botcube_harness_deepagents/scheduled_tasks.py) proposes a task, and the user confirms it before creation.

The example's echo model does not propose or execute tools. Exercise your own bot's tool execution, scheduling, and Sign-in behavior with its configured model and providers. Local behavior and synthesized templates do not prove parity with a deployed AWS stack.
