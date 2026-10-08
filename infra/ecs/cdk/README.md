# Chat storage

From the public repository root, install the workspace with its pinned package
manager, then build and test the ECS CDK package:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --dir infra/ecs/cdk build
corepack pnpm --dir infra/ecs/cdk test --runInBand
```

Synthesize the template's foundation stacks from that same directory:

```sh
CARTRIDGE_DEPLOY_ROOT="$PWD/template/deploy" BOTCUBE_REPOSITORY_ROOT="$PWD" \
  corepack pnpm --dir infra/ecs/cdk cdk synth -c parked=true \
  -c 'webLatencyMoments=["first-response","tool-result"]'
```

Replace the example event names with the moments your UI emits. The template
has no latency budget file, so the moments must be supplied explicitly. This
synthesizes storage, egress, health, and latency monitoring without the serving
origin. See [template identity](../../../template/IDENTITY.md) for serving-origin
inputs. Synthesis does not deploy resources. Every synth needs
`-c parked=true|false`; deploys read it from the application's stored park state.

The `chat` table uses on-demand billing, point-in-time recovery, deletion
protection and retention on removal, with no TTL. It holds Session Metadata, whose
`pk` is the owner index; see the Chat Service README.

The preview-origin workflow consumes this stack from ECS by
granting the Chat Service task role table access and setting
`BOTCUBE_CHAT_TABLE`. See [the integration guide](../../../INTEGRATING.md) for deployment
composition and verification. Account storage shares this table with
separate key prefixes; the Credential Service Vault uses its own table.
