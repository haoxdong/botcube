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
CARTRIDGE_DEPLOY_ROOT="$PWD/templates/always-on/deploy" BOTCUBE_REPOSITORY_ROOT="$PWD" \
  corepack pnpm --dir infra/ecs/cdk cdk synth -c parked=true \
  -c 'webLatencyMoments=["first-response","tool-result"]'
```

Replace the example event names with the moments your UI emits. The template
has no latency budget file, so the moments must be supplied explicitly. This
synthesizes storage, egress, health, and latency monitoring without the serving
origin. See [template identity](../../../templates/always-on/IDENTITY.md) for serving-origin
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

## Files access point mode

The default `filesAccessPointMode=runtime` creates an EFS access point on a
User's first Files use. The Chat Service role needs
`elasticfilesystem:CreateAccessPoint`, `elasticfilesystem:DeleteAccessPoint`,
and `elasticfilesystem:DescribeAccessPoints`. Mount roles need only
`elasticfilesystem:ClientMount` and `elasticfilesystem:ClientWrite`.

For an organisation that denies runtime access point management, select the
pool when deploying:

```sh
corepack pnpm --dir infra/ecs/cdk cdk synth -c parked=true \
  -c filesAccessPointMode=pool -c filesAccessPointPoolSize=100 \
  -c 'webLatencyMoments=["first-response","tool-result"]'
```

One custom resource starts an SQS FIFO background build through the EFS API.
Chat Service starts once the first 50 slots (or the configured smaller pool)
are available. The builder then fills the target capacity independently of
CloudFormation's deployment timeout. FIFO serializes deployment and background
transitions; persisted progress survives retries. Five requests can run in
parallel through the SDK's adaptive rate limiter. No published request-rate
quota is assumed. Failed jobs reach a dead-letter queue and notify alerts.
The serving roles cannot manage access points. Chat Service refreshes the
private S3 manifest for new User leases, so added slots need no task restart.
Each STS session policy still permits exactly one access point.

Pool capacity defaults to 100, with the usage alarm at 80. A User keeps
their slot for life, including idle periods. Retirement retains the lease for
credential expiry and the existing 24-hour cleanup grace. Cleanup wipes the
directory again before reuse. Exhaustion returns HTTP 503 with an instruction
to increase capacity. It never creates an access point at runtime. The 80%
alarm includes quarantined slots and notifies the Chat Service alerts topic.

The slot search starts at a randomly chosen slot and wraps around. Concurrent
wakes still claim one slot per User through conditional writes.

There is no access-point-per-resource CloudFormation limit. EFS allows 10,000
access points per filesystem, including the shared Files mount, leaving up
to 9,999 pool slots. Pool updates append slots and keep the prior manifest
available for serving tasks during deployment. Shrinking requires migration.

Use pool mode for a new Files deployment. A User already bound to an access
point outside the selected pool fails with an instruction to restore the prior
configuration or migrate their Files. This switch does not migrate data.
External pools are not imported. Existing filesystem paths and storage keys
remain compatible with the existing APIs.

The application receives the manifest's bucket and key through
`BOTCUBE_FILES_POOL_MANIFEST`. An absent variable selects runtime mode.
An invalid location or manifest fails instead of selecting runtime mode.
The manifest key changes with capacity so a pool expansion rolls out new
serving tasks after provisioning finishes.

### Interrupted pool cleanup

Retirement and transfers take durable per-User cleanup claims in the chat
table under `pk=FILES_POOL_CLEANUP` and `sk=<User ID>`. A competing worker
fails before touching that User's directory. Transfers also claim the
destination User. Claims have no expiry because an expired worker could
resume a filesystem operation after reassignment.

After a worker crash, cleanup automatically checks the ECS task recorded in
the claim. A confirmed STOPPED task permits conditional takeover; a live or
unverifiable task keeps its claim. An explicit MISSING response is accepted
only after two hours, beyond ECS's stopped-task retention window. Takeover and
release compare the ownership token. Recovery resumes the saved retirement,
including destination claims, without editing DynamoDB by hand.
