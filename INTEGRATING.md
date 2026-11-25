# Integrate BotCube with your application

BotCube gives you a web UI, a Chat Service, and a Harness. Your bot is configuration, not code (ADR 0091): a deployment is one BotCube Config, `botcube.yaml`, plus the images it names. The Bot Image, built on BotCube's Harness image, carries the bot's settings and skills. Start from the public example, [`examples/bot/`](examples/bot/) and [`examples/public/`](examples/public/), then replace its inputs with your own. The example runs without external provider or AWS credentials.

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

Run each CDK package's build and tests from its directory. For synthesis, set `BOTCUBE_DEPLOY_ROOT` to the `deploy/` directory beside your `botcube.yaml`; the CDK apps read the `botcube.yaml` beside it ([`infra/ecs/cdk/lib/deploy-root.ts`](infra/ecs/cdk/lib/deploy-root.ts), [`infra/agentcore/cdk/lib/deploy-config.ts`](infra/agentcore/cdk/lib/deploy-config.ts)). The example's values are placeholders; replace them before using your AWS account.

## Build production artifacts

From the public repository root, build BotCube's Harness image, your bot's image on it, and the session API, Chat Service, and Credential Service images:

```bash
docker build -f harness/deepagents/Dockerfile --target harness -t botcube-harness .
docker build --build-context harness=docker-image://botcube-harness -f examples/bot/Dockerfile -t bot .
docker build -f harness/deepagents/session-api.Dockerfile -t session-api .
docker build -f chat/Dockerfile --build-arg BOTCUBE_ROOT=. -t chat .
docker build -f credential-service/Dockerfile --build-arg BOTCUBE_ROOT=. -t credential .
```

The Chat Service image is stock and ships the BotCube Configs under `examples/`; set `BOTCUBE_CONFIG` to the one it runs, such as `/opt/chat-service/examples/public/botcube.yaml`. The stock Credential Service serves OpenAI and any models Endpoint, with no site provider. It reads its Vault from `BOTCUBE_VAULT_TABLE` and `BOTCUBE_VAULT_KMS_KEY_ID` and its invocation secret from `BOTCUBE_CREDENTIAL_INVOCATION_SECRET`.

Export the static UI with the URL of your deployed Chat Service:

```bash
docker build -f ui/web/Dockerfile --target artifact \
  --build-arg NEXT_PUBLIC_CHAT_SERVICE_URL=https://your-chat.example \
  --output type=local,dest=ui-artifact .
```

The export writes the UI files to `ui-artifact/`. Omit `--target` and `--output` and add an image tag to build its static server image, which listens on port 3001. Set `BOTCUBE_UI_PACKAGE` and, when needed, `BOTCUBE_UI_BUILD_CONFIG` through build arguments to bind your UI plugin.

Exercise the production images against the neutral local infrastructure:

```bash
BOTCUBE_PRODUCTION_ARTIFACTS=1 bash infra/local/run.sh -d
BOTCUBE_PRODUCTION_ARTIFACTS=1 bash infra/local/smoke.sh
```

This builds the production Harness, example bot, Chat Service, session API, and UI images, keeping the local stand-in Credential Service and fake site, and verifies Turn, replay after Harness restart, delete, invalid-request rejection, and UI responses. Stop this stack with `docker compose -f infra/local/compose.yml -f infra/local/compose.production.yml down`.

For a build behind your organization's TLS proxy, pass its CA bundle with `--secret id=build_ca,src=<bundle>`. Compose accepts the same bundle through `BOTCUBE_BUILD_CA_CERTS`. Build trust does not configure runtime trust: the BotCube Config's `caBundle` does, a PEM file every process loads at startup.

## Connect the three pieces

The UI sends AG-UI requests to the Chat Service at `POST /`. The Chat Service owns request identity and Session Metadata. It relays turns to the Harness's `POST /invocations`, which streams AG-UI server-sent events. A Harness exposes `GET /ping` for health on port 8080.

The Chat Service exposes `GET /threads`, `GET /threads/{id}`, and `DELETE /threads/{id}` for session listing, replay, and deletion. It gets session content from the Harness's separate session API, rather than keeping a second conversation record. See [the Chat Service contract](chat/README.md) and [the Harness contract](harness/deepagents/README.md).

The sandbox uses local plain HTTP. Memory IDs and runtime ARNs may be supported unresolved CDK resource references.

## Supply your bot

- **Bot settings and skills.** Copy [`examples/bot/`](examples/bot/). [`bot.yaml`](examples/bot/bot.yaml) follows [the bot settings schema](config/bot.schema.json): agent identity, account key, models, skills, Written Memory and Extracted Memory (`writtenMemory.enabled` and `extractedMemory.enabled`, each on unless false; `memory` was renamed to them), and Agent Computer. Each skill is a directory holding a `SKILL.md`.
- **Bot image.** The bot's [`Dockerfile`](examples/bot/Dockerfile) builds `FROM harness`, and copies the settings to `/bot/bot.yaml` and the skills beside them. Install your bot's CLIs there, on the `PATH`. The bot runs no code in BotCube's processes.
- **BotCube Config.** Copy [`examples/public/botcube.yaml`](examples/public/botcube.yaml), a complete deployment: its name, account and region, domains, the AgentCore and network resources BotCube creates, and the existing VPC, link browser and slot bucket it uses. [The Configuration section](#configuration) describes each key; [`examples/enterprise/botcube.yaml`](examples/enterprise/botcube.yaml) replaces every integration default.
- **Deploy directory.** Copy [`examples/public/deploy/`](examples/public/deploy/) for its acceptance hook [`ecs/acceptance.py`](examples/public/deploy/ecs/acceptance.py). Build images from their own Dockerfiles before synthesis.
- **Services.** The [stock Chat Service](chat/src/stock.ts) and stock Credential Service need no code. An `openai-compatible` `modelGateway` takes `providers`, each provider's URL with an optional credential and headers; each model in the bot settings names its `provider` (`anthropic` or `openai`), whose own API the Harness calls, and `botcube footprint --bot` prints it. A bot may build its own Credential Service, for a site provider, or its own Chat Service, each from its own directory: its ECS app names their Dockerfiles (`images`), which the ECS app builds instead. `services.chatService.image` and `services.credentialService.image` name a built image to run in place of either build, pinned by digest in production. [The local stand-ins](infra/local/stand-ins/) show a fake site provider.
- **UI.** [The default UI plugin](ui/web/src/plugin/default.tsx) supplies neutral copy, auth, and theme through the [typed UI contract](ui/web/src/plugin/types.ts). Bind your own plugin package with `BOTCUBE_UI_PACKAGE` at build time.

## Run it in your AWS account

1. Copy `examples/bot/` and `examples/public/` into your application. Keep the echo model until the three pieces work together.
2. In `botcube.yaml`, set `name`, `env.account` and `env.region`, and your `domains`. Every physical name derives from `name`; set a `names` entry only for a resource whose name must differ. Replace the example's `existing` resources with your own.
3. Configure your bot's models in `bot.yaml` and the BotCube Config's `integrations.modelGateway` before enabling a real model.
4. Build the generic AgentCore CDK package and point `BOTCUBE_DEPLOY_ROOT` at the `deploy/` directory beside your `botcube.yaml`. Synthesis builds the AgentCore project and its one target from `botcube.yaml`, and fails before synthesizing when `env` is missing.
5. Use the standard deploy entry to compose the stacks from `botcube.yaml`. Put existing resources under `existing`. Their trust policies, network routing, and access grants remain your responsibility.
6. Synthesize from your BotCube Config, inspect the templates, and compare with your deployed stack before your organization's deployment process runs. See [AgentCore CDK commands](infra/agentcore/cdk/README.md) and [ECS CDK commands](infra/ecs/cdk/README.md).
7. Configure the Chat Service through `botcube.yaml`. Build the UI with your plugin and its Chat Service URL. Verify a successful turn, session replay, and a rejected request.

From the root of the standalone mirror, use the pinned Corepack/pnpm workspace installation above, then synthesize the example.

```bash
export BOTCUBE_DEPLOY_ROOT="$PWD/examples/public/deploy"
corepack pnpm --dir infra/agentcore/cdk build
corepack pnpm --dir infra/agentcore/cdk cdk synth
```

The example uses the placeholder account `000000000000`. Set your account in `env.account` and publish the images named by `agentCore.runtime.containerUri` and `services` before deployment. Publish your Bot Image and name it in `agentCore.runtime.containerUri` before synthesis. Synthesis does not deploy resources.

[`infra/ecs/cdk/example/app.ts`](infra/ecs/cdk/example/app.ts) defines both CDK apps from a BotCube Config with `defineExample`. The Chat Service reads the resolved BotCube Config from S3 and the bot settings from `/bot/bot.yaml` in its image.

Lower-level construct users composing their own CDK applications can use a custom entry point instead of the default `bin/cdk.ts`. Import resources into a stack with the same account and region as your target, then pass them to `addAgentCoreStacks`.

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

Replace the placeholder IDs and ARNs with your resources. Name your published Bot Image in `agentCore.runtime.containerUri` before synthesis. The imported execution role needs AgentCore trust and runtime infrastructure permissions, with no AgentCore Memory or cross-account data grants (ADR 0067). Its policies remain caller-owned; BotCube does not rewrite imported role policies. Supply security groups through `securityGroups` when your network policy requires them. The AgentCore memory key must permit the memory service, the session API role and the user Memory role; the Harness runtime reaches Memory only with each Turn's tagged credentials for that role (ADR 0067 §8). The subnet routes must reach the services the runtime uses, including STS.

Operators configure a deployment through one `botcube.yaml`, using the [public and enterprise examples](examples/) as shape references. Set existing resources under `existing`, service settings under `services`, and deployment settings under `agentCore`, `alarms`, `cloudflare`, and `network`. The standard deploy entry reads these settings and composes the CDK stacks. The custom CDK composition above is for lower-level construct users.

`PreviewChatService` and `PrivateCredentialService` take an `environment` map, and production composition forwards `chat.environment` and `credentials.environment`. Its names must be among the [four uses](#environment-variables); bot settings belong in the Bot Image and deployment settings in the BotCube Config. Framework-owned values, including serving ports and regions, take precedence over caller entries. The Chat image installs Chromium, which the local Agent Computer runs with no configuration.

For the generic ECS CDK entry point, set `BOTCUBE_REPOSITORY_ROOT` to the absolute checkout root when running from a standalone BotCube mirror. This controls the image build context. `cloudflare.originPull.caCertificate` names an S3 bundle by `bucket`, `key`, and optional `versionId`. If unset, it retains the current monorepo root; relative values resolve from `infra/ecs/cdk`.

## Use an existing load balancer and listener

`PreviewChatService` accepts an ordinary CDK construct scope and a
`ChatServiceIngress` interface from `infra/ecs/cdk/lib/preview-chat-service`.
Supply your ALB, listener, and ingress security group, including imported CDK
interfaces. The remaining `chatProps` are your application's Chat Service
configuration; see [CDK props](#cdk-props).

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
listener rules without changing the existing security group's outbound rules.
Use distinct resource names, hostnames, and priorities for separate services.

You own ALB-wide alarms for shared ingress. BotCube retains the Chat Service's
target-group alarms alongside its task and application alarms.

See [resource names and imports](RESOURCE-NAMES.md) for physical name inputs,
existing-resource examples, and ownership constraints.

## Configuration

A deployment is one BotCube Config, `botcube.yaml`, plus the images it names (ADR 0091). Environment variables are limited to four uses and one operator consent. Nothing else configures a deployment: synthesis fails on any other configuration file in the bot directory, the directory that holds `botcube.yaml` and the `deploy/` directory ([Migrate from deploy-root files](#migrate-from-deploy-root-files)).

### The BotCube Config

The BotCube Config is `botcube.yaml`, YAML 1.2 against [`botcube.schema.json`](config/botcube.schema.json), emitted from [`config/schema.ts`](config/schema.ts). The deployment's keys are defined in [`config/deployment.ts`](config/deployment.ts), [`config/existing.ts`](config/existing.ts) and [`config/images.ts`](config/images.ts). Unknown keys stop loading and name the key's path, including inside `names` and `tags`. A key you leave out takes BotCube's default.

A deployment needs four keys:

- `name`: the deployment's name, lowercase letters, digits and hyphens. It prefixes the CloudFormation stacks, and every physical name derives from it. Synthesis fails without it.
- `env`: `account` and `region`, as a CDK `Environment`. AgentCore synthesis fails without it.
- `domains.web`: the web UI's origin.
- `domains.chatService`: the Chat Service's origin. Its hostname, over https, issues the per-Turn JWT.

The optional keys follow, in the order the file lists them:

| Key                              | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tags`                           | AWS tags, as CDK `Tags`, today on the AgentCore project only. A key starting `aws:` fails.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `names`                          | A physical name that differs from the derived one, keyed by role and CloudFormation name property, such as `clusterName` or `runtimeRoleName`. `DERIVED_NAMES` in [`config/deployment.ts`](config/deployment.ts) lists every role and its default.                                                                                                                                                                                                                                          |
| `domains`                        | Besides `web` and `chatService`: `webAliases`, the further UI origins CORS allows; `chatServicePreview`; `credentialService`, the Credential Service's public origin; `productService`. Each is a web origin, with no path.                                                                                                                                                                                                                                                                 |
| `integrations`                   | The outside services: `signIn`, `modelGateway`, `harnessAuth`, `awsAccess`, `imageRegistry`, `telemetry`, `relayProviders` and `proxy`, each with a `kind` where there are options. A service reached at a URL is an Endpoint: `url`, `credential`, `headers`, `tls` and `proxy: integrations.proxy` when it is reached through the proxy. An OIDC `signIn` issuer takes `proxy` too, and so does each Credential Service Relay provider under `relayProviders`, by name, such as `openai`. |
| `services`                       | The images the Chat and Credential Services run, and the Credential Service's `http.path`, `http.publicPaths` and `leadingKeyPrefixes`.                                                                                                                                                                                                                                                                                                                                                     |
| `agentCore`                      | The Runtime's `platformVersion`, `containerUri` and `rollbackEndpoint`, and the link browser's `extension`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `network`                        | `natGateways`, as CDK `VpcProps.natGateways`: `1` creates and parks a NAT in `existing.vpc`, and `0` or absent means the VPC brings its own egress. `publicIp` is the NAT's Elastic IP.                                                                                                                                                                                                                                                                                                     |
| `cloudflare`                     | The `zone` the origins are records in, and `originPull`: the authenticated origin pull CA as a PEM file relative to `botcube.yaml`, and the client certificate's `organization`.                                                                                                                                                                                                                                                                                                            |
| `existing`                       | Resources BotCube uses instead of creating them, each as its CDK `from…Attributes` object: `vpc`, `browsers.link`, `kmsKeys`, `tables`, `buckets`, `files` and `credentialService`.                                                                                                                                                                                                                                                                                                         |
| `schedules`, `liveView`          | How scheduled tasks fire, and whether the Agent Computer streams a live view.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `planUsage`, `parking`, `alarms` | The Account linked plans run on; which User-Agents don't wake a parked deployment, and `autoPark`; the Runtime's error alarms.                                                                                                                                                                                                                                                                                                                                                              |
| `allowCommandCredentials`        | Whether a credential may come from a command. Loading fails on a command credential without it, and the deploy also needs the operator's consent ([Environment variables](#environment-variables)).                                                                                                                                                                                                                                                                                         |

A key for an AWS value uses its CloudFormation or CDK name. A key with no outside standard has a description starting "BotCube-owned:" in the schema.

The Bot Image carries the bot's own settings at `/bot/bot.yaml`, against [`bot.schema.json`](config/bot.schema.json): agent identity, models, skills, `productName` and `productService`. The BotCube Config contains no bot settings, so the settings and the image roll back together.

`BOTCUBE_CONFIG` locates the resolved BotCube Config by S3 URL or local file path. The CDK apps publish the JSON before the Chat Service and Credential Service task definitions and AgentCore Runtime revisions use it. Each revision names its own retained object. Allow the S3 reads reported by `botcube footprint` when you supply the network or proxy. The local Compose stacks resolve to a mounted JSON file before starting the services.

### The images

`botcube.yaml` names each image a deployment runs. A pinned image is a tag or a digest; pin by digest in production.

- **Bot Image.** `agentCore.runtime.containerUri` is an Amazon ECR image URI, built `FROM` the Harness image. Before migrating an existing CodeBuild deployment, run `python3 infra/agentcore/retain-images.py <stack>` to preserve its image repository and encryption key. Synthesis requires the image and deploys it without CodeBuild ([`infra/agentcore/cdk/bin/cdk.ts`](infra/agentcore/cdk/bin/cdk.ts)).
- **Chat Service.** `services.chatService.image` is an OCI image reference. Without it, BotCube builds the bot's own Chat Service Dockerfile, which its ECS app names in `productionApp({ images })`, or else the stock Chat Service ([`infra/ecs/cdk/lib/service-images.ts`](infra/ecs/cdk/lib/service-images.ts)).
- **Credential Service.** `services.credentialService.image` is an Amazon ECR image URI, because its audit-copy Lambda runs the same image. Without it, BotCube builds the bot's own Credential Service Dockerfile, or else the stock one.
- **Image registry.** `integrations.imageRegistry.url` is the one registry BotCube pulls from: the services' sidecars and every image it builds `FROM`. It defaults to `https://public.ecr.aws`, and a mirror keeps ECR Public's paths.

A bot's Bot Image ships its browser extension under `/bot/browser-extension/`. The remote link browser needs a published zip of that extension. `agentCore.browsers.link.extension` names it as an S3 object: `bucket`, `key` and `versionId`.

### Environment variables

[`environment-rule.ts`](infra/ecs/cdk/lib/environment-rule.ts) lists every name a deployed process may set, grouped by use, and a CDK test fails on any other name in any ECS task, Lambda or Harness runtime. The four uses are:

1. **Locator.** `BOTCUBE_CONFIG`.
2. **Secrets.** A secret's value, such as `BOTCUBE_CREDENTIAL_INVOCATION_SECRET`. Every ECS `Secrets` entry counts.
3. **Names of created resources.** Names, ARNs, URLs and hostnames of resources the deployment creates, such as `BOTCUBE_CHAT_TABLE` or `AGENTCORE_RUNTIME_ARN`. An existing resource you name in the BotCube Config is read from the file instead.
4. **Standard names.** Names a standard SDK, tool or platform reads: any `AWS_*` or `OTEL_*` name, `PORT`, and the others the rule lists. The deploy points `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS` and `REQUESTS_CA_BUNDLE` at its `caBundle` ([`config/environment.ts`](config/environment.ts)).

One more name is allowed: `BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1`, the operator's consent to command credentials. Whoever can edit the BotCube Config chooses a command credential's command, so the consent stays out of the file. Set it where the deploy runs; synthesis fails on a command credential without it, and the deploy passes it to every process.

The rule has no other exceptions: any other name fails the test.

`BOTCUBE_DEPLOY_ROOT` and `BOTCUBE_REPOSITORY_ROOT` are read where synthesis and operator tools run. No deployed process is given either.

### Migrate from deploy-root files

Before synthesis reads `botcube.yaml`, it checks the bot directory: the TypeScript reader's `botDirectoryErrors` in [`config/read.cjs`](config/read.cjs), and the Python twin's `bot_directory_errors` in [`botcube_config.py`](credential-service/src/botcube_credential_service/botcube_config.py). Each error names what to do.

**A retired file.** A deploy root that still holds `identity.json`, `agentcore/agentcore.json` or `agentcore/aws-targets.json` fails with one line for the file and one for each field it holds:

```text
Deploy root <deploy root>: identity.json is retired: botcube.yaml beside the deploy root replaces it; move each field to its key there, then delete the file
Deploy root <deploy root>: identity.json: aws.account: botcube.yaml env.account
Deploy root <deploy root>: identity.json: aws.ecs.cluster: botcube.yaml names.clusterName
Deploy root <deploy root>: identity.json: ssm.parkState: derived from botcube.yaml name
```

Each field line ends in one of four instructions:

- `botcube.yaml <key>`: set that key. For a `names.<role>` key, set it only when your name differs from the derived one.
- `derived from botcube.yaml name`: delete the field. BotCube derives the name from `name`.
- `BotCube's own value; delete it`: delete the field. BotCube sets the value itself.
- `no botcube.yaml key; delete it`: delete the field. No deployment sets it.

The map from each field to its key is `RETIRED_FILES` in [`config/deployment.ts`](config/deployment.ts), emitted into the schema as `x-retired-files`. Delete the retired file once its fields have moved.

**Another configuration file.** A JSON, YAML, TOML, INI or env file in the bot directory or anywhere in its deploy root fails:

```text
Bot directory <bot directory>: release.json: a configuration file; a deployment is botcube.yaml plus the images it names, so move its values into botcube.yaml, or into bot.yaml in the Bot Image, then delete the file
```

These files may stay: `botcube.yaml`, `bot.yaml` and `latency-budgets.json` in the bot directory; build manifests (`package.json`, lockfiles, `pnpm-workspace.yaml`, `tsconfig*.json`, `pyproject.toml`, `uv.lock`, `cdk.json`, `cdk.context.json`); and anything in a directory that holds a `Dockerfile` or a browser extension's `manifest.json`, which is an image's build context. Dot-directories, `node_modules`, `cdk.out`, `dist` and `__pycache__` are not checked.

- A `release.json` held release settings, which are not BotCube Config. The NAT's Elastic IP is `network.publicIp`. The web latency reader's OIDC subject is `ProductionOptions.webLatency.readerSubject`, which your ECS app passes. The deploy role's OIDC subject is `GITHUB_OIDC_SUBJECT`, read by [`bootstrap-deploy-role.sh`](infra/ecs/bootstrap-deploy-role.sh). The verification user agents are `VERIFICATION_USER_AGENT` and `ORIGIN_VERIFICATION_USER_AGENT`, read by [`deploy_check.py`](infra/ecs/deploy_check.py).
- A file holding one fixed value, such as an `api-rate-limit.json` rule body, becomes a constant beside the code that reads it.

**A missing name or Region.**

```text
<deploy root>/identity.json: BotCube Config <path> names no deployment
BotCube Config <path>: env: a deployment names its account and region
```

Set `name`, or `env.account` and `env.region`.

**A moved key.** A key the BotCube Config no longer takes fails with its replacement:

```text
BotCube Config <path>: <key>: renamed to <replacement>
```

| Key                                         | Replacement                                                   |
| ------------------------------------------- | ------------------------------------------------------------- |
| `productName`, `productService`             | The same key in `/bot/bot.yaml`, the Bot Image's bot settings |
| `network.proxy`, `proxy`                    | `integrations.proxy`                                          |
| `network.corsOrigins`, `corsOrigins`, `web` | `domains.web` and `domains.webAliases`                        |
| `existing.network`                          | `existing.vpc`, with `network.natGateways` `0`                |
| `identity`                                  | `integrations.signIn`                                         |
| `models`                                    | `integrations.modelGateway`                                   |
| `turnCredentials`, `awsAccess`              | `integrations.awsAccess`                                      |
| `harnessAuth`, `telemetry`, `imageRegistry` | The same key under `integrations`                             |
| `supplied`                                  | `existing`                                                    |
| `bot`                                       | `/bot/bot.yaml` in the Bot Image; remove `bot`                |

[`config/renamed-keys.ts`](config/renamed-keys.ts) holds the map, emitted into the schema as `x-renamed-keys`. A file named `deployment-config.json` fails with `deployment-config.json: renamed to botcube.yaml`.

### Examples

Both examples are complete deployments. The ECS CDK tests synthesize both without AWS credentials ([`environment-rule.test.ts`](infra/ecs/cdk/test/environment-rule.test.ts)).

- [`examples/public/botcube.yaml`](examples/public/botcube.yaml) keeps the integration defaults: BotCube creates its resources, signs users in with BotCube accounts, reaches models on Bedrock, fires schedules with EventBridge Scheduler and sends traces to X-Ray. It names its account, Region, domains, the NAT BotCube creates, the Cloudflare zone, and the existing VPC, link browser and slot bucket.
- [`examples/enterprise/botcube.yaml`](examples/enterprise/botcube.yaml) replaces each integration default: OIDC sign-in, OpenAI-compatible models, JWT bearer to the Harness, `AssumeRole` Turn credentials, a schedules table poller, an image mirror, OTLP telemetry and a forward proxy. Its existing VPC brings its own egress, and it reuses existing keys, tables, buckets, Files and a Credential Service.

## CDK props

Operators configure deployments only through `botcube.yaml`. Runtime lifecycle settings are `agentCore.runtime.maxLifetime` (integer seconds from `60` through `3600`, default `3600`) and `agentCore.runtime.idleRuntimeSessionTimeout` (`60` through `900`, default `300`). These use AWS LifecycleConfiguration names. The lifetime cap follows ADR 0029.

CDK props serve lower-level construct users composing their own applications, including Preview stacks. They are not an operator configuration surface. Their interfaces document the props, with defaults in the constructors: [`ProductionOptions`](infra/ecs/cdk/lib/production.ts), [`PreviewChatServiceProps`](infra/ecs/cdk/lib/preview-chat-service.ts), [`PrivateCredentialServiceProps`](infra/ecs/cdk/lib/private-credential-service.ts), [`PreviewOriginProps`](infra/ecs/cdk/lib/preview-origin-stack.ts), [`ApiHealthStackProps`](infra/ecs/cdk/lib/api-health-stack.ts), [`WebLatencyStackProps`](infra/ecs/cdk/lib/web-latency-stack.ts), [`ChatStorageProps`](infra/ecs/cdk/lib/chat-storage-stack.ts), and [`AgentCoreStackProps`](infra/agentcore/cdk/lib/cdk-stack.ts). The standard entry maps the BotCube Config into these constructs. `defineProduction` composes ECS resources; `addAgentCoreStacks` composes the Runtime. [Resource names and imports](RESOURCE-NAMES.md) covers physical names and existing resources.

## What BotCube provides by default

### Agent Computer

With no AgentCore browser, the Chat Service runs BotCube's [local Agent Computer](chat/src/local-agent-computer.ts): it authorizes the owning Account and Session and runs a [local Chromium](chat/src/local-chromium.ts) with a private profile per Session, opened on `about:blank` unless given a start page, through the BotCube Config's `integrations.proxy` whenever there is one, for every destination but loopback; the agent's commands go through it the same way. Every other client goes direct unless its Endpoint, the OIDC sign-in issuer or its Relay provider names the proxy; AWS calls always go direct. Each Turn gets a signed CDP URL for its Account and Session, valid for an hour; the agent's connection wakes the Session's computer. The Harness exposes the URL as `AGENT_BROWSER_CDP`, with one `AGENT_BROWSER_SESSION` per Session, to its permitted browser commands. With no configuration it runs the `/usr/bin/chromium` the Chat image installs, and a Chromium missing there fails the computer's start with HTTP 503.

The same [CDP channel](chat/src/agent-computer-cdp.ts) as an AgentCore Agent Computer's filters credential-export commands and cookie data from network events. Retirement closes CDP channels and deletes the private profile. Under the BotCube Config's `liveView: none` the UI requests no live view and says it is off. The local computer has no Take-over; AWS browser acceptance remains a separate check.

### Sign-in and scheduled runs

The stock Chat Service lists no site Sign-ins. Local browsers receive opaque Account session cookies that expire after a day and reset when Chat Service restarts. When `BOTCUBE_CREDENTIAL_SERVICE_URL` is set, the Chat Service signs each Turn a Credential Service invocation bound to the Account and Session; scheduled Turns restore the task owner's Account and get the same binding. The generic [task routes](chat/src/scheduled-tasks.ts) and [run handler](chat/src/scheduled-runs.ts) remain in BotCube. The Harness [proposal tool](harness/deepagents/src/botcube_harness_deepagents/scheduled_tasks.py) proposes a task, and the user confirms it before creation.

The example's echo model does not propose or execute tools. Exercise your own bot's tool execution, scheduling, and Sign-in behavior with its configured model and providers. Local behavior and synthesized templates do not prove parity with a deployed AWS stack.
