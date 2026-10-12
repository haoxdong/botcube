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

## One-time tagged-credential cutover

A Turn reaches Memory with tagged credentials from STS `AssumeRoleWithWebIdentity`, exchanging the Chat Service's per-Turn JWT for the Memory role the stack outputs as `UserMemoryRoleArn`; the runtime role holds no Memory permission. The new Harness refuses an invocation without that JWT, and the new Chat Service sends no broker capability, so Turns fail between the two deploys. Store the Chat Service's Turn identity keys and deploy the Chat Service first: creating this stack's IAM OIDC provider fetches the issuer's live `/.well-known/openid-configuration`, which STS also reads on every exchange, and fails until the Chat Service serves it. Then synthesize, inspect the diff, and deploy this stack right away. Verify the runtime's `BOTCUBE_USER_MEMORY_ROLE_ARN`, a policy without `bedrock-agentcore:` actions on the runtime role, and persistence and recall on a new Session.
