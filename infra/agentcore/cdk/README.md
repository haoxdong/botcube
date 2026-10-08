# AgentCore CDK Project

This CDK project is managed by the AgentCore CLI. It deploys your agent infrastructure into AWS using the `@aws/agentcore-cdk` L3 constructs.

## Structure

- `bin/cdk.ts` — Entry point. Reads project configuration from the active Cartridge deploy directory and creates a stack per deployment target.
- `lib/cdk-stack.ts` — Defines `AgentCoreStack`, which wraps the `AgentCoreApplication` L3 construct.
- `test/cdk.test.ts` — Unit tests for stack synthesis.

## Useful commands

- `pnpm run build` compile TypeScript to JavaScript
- `pnpm test` run unit tests
- `pnpm exec cdk synth` emit the synthesized CloudFormation template
- `pnpm exec cdk deploy` deploy this stack to your default AWS account/region
- `pnpm exec cdk diff` compare deployed stack with current state

## Usage

From the public repository root, select your Cartridge deploy directory and build the CDK package:

```bash
export CARTRIDGE_DEPLOY_ROOT="$PWD/template/deploy"
corepack pnpm --dir infra/agentcore/cdk run build
corepack pnpm --dir infra/agentcore/cdk exec cdk synth
corepack pnpm --dir infra/agentcore/cdk exec cdk diff
```

Replace the template's placeholder AWS settings and stage your Cartridge's production image inputs before deployment. Follow [the integration guide](../../../INTEGRATING.md) for composition and build inputs.

Always synthesize and inspect the diff before deploying. Do not proceed if it replaces or deletes the configured runtime or memory.
After deployment, send a real prompt and verify both the response and its structured CloudWatch event.

## One-time Memory broker cutover

Existing Session API infrastructure must already be deployed. Deploy the broker-capable Chat Service first and verify that every old Chat task, including draining tasks, has stopped. The old Harness accepts the additional Turn capability; the new Harness requires it. Do not deploy the new Harness while an old Chat task can still invoke it.

For an existing deployment, retain the old Harness's Memory grants during the runtime image update. From the public repository root:

```bash
export CARTRIDGE_DEPLOY_ROOT="/absolute/path/to/cartridge/deploy"
export AGENTCORE_CUTOVER_STACK="AgentCore-your-cartridge-default"
corepack pnpm --dir infra/agentcore/cdk run build
corepack pnpm --dir infra/agentcore/cdk exec cdk synth "$AGENTCORE_CUTOVER_STACK" -c retainLegacyRuntimeMemory=true
corepack pnpm --dir infra/agentcore/cdk exec cdk diff "$AGENTCORE_CUTOVER_STACK" -c retainLegacyRuntimeMemory=true
corepack pnpm --dir infra/agentcore/cdk exec cdk deploy "$AGENTCORE_CUTOVER_STACK" -c retainLegacyRuntimeMemory=true
```

Inspect the diff before deploying; replacement or deletion of the runtime or Memory remains a stop condition. This explicit migration context retains only the pre-cutover Memory grants, including their existing namespace conditions. It does not retain the removed log reads, resource-policy writes, or configuration-bundle grants. The new Harness continues to use the broker exclusively. The stack output `LegacyRuntimeMemoryRetained` is `true` during this stage.

Wait at least 3,600 seconds after the updated runtime version becomes `READY`, so every old microVM has exhausted its maximum lifetime. Then synthesize, inspect the diff, and deploy the final policy:

```bash
corepack pnpm --dir infra/agentcore/cdk exec cdk synth "$AGENTCORE_CUTOVER_STACK" -c retainLegacyRuntimeMemory=false
corepack pnpm --dir infra/agentcore/cdk exec cdk diff "$AGENTCORE_CUTOVER_STACK" -c retainLegacyRuntimeMemory=false
corepack pnpm --dir infra/agentcore/cdk exec cdk deploy "$AGENTCORE_CUTOVER_STACK" -c retainLegacyRuntimeMemory=false
```

The explicit `false` overrides any retained CDK context. An absent context also denies all runtime Memory operations. Verify `LegacyRuntimeMemoryRetained=false`, the deployed runtime policy, broker-backed persistence and recall on a new Session, and direct Memory access denial before enabling full Bash.
