import { RemovalPolicy } from 'aws-cdk-lib';
import { CfnRuntime, CfnRuntimeEndpoint } from 'aws-cdk-lib/aws-bedrockagentcore';

export type RuntimePlatformVersion = 'V1' | 'V2';

export function applyRuntimePlatform(
  runtime: CfnRuntime,
  platformVersion: RuntimePlatformVersion,
  rollbackVersion?: string
): void {
  if (!['V1', 'V2'].includes(platformVersion)) throw new Error('Runtime platform must be V1 or V2');
  runtime.platformVersion = platformVersion;
  if (rollbackVersion === undefined) return;
  if (typeof rollbackVersion !== 'string' || !/^[1-9][0-9]*$/.test(rollbackVersion))
    throw new Error('V1 rollback requires a numeric runtime version');
  const rollback = new CfnRuntimeEndpoint(runtime, 'V1Rollback', {
    agentRuntimeId: runtime.attrAgentRuntimeId,
    agentRuntimeVersion: rollbackVersion,
    name: 'V1_ROLLBACK',
  });
  rollback.applyRemovalPolicy(RemovalPolicy.DESTROY);
}
