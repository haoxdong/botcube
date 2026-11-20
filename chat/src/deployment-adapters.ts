import { deploymentSections, type DeploymentConfig } from 'botcube-deployment-config';
import { loadDeployment } from 'botcube-deployment-config/load';
import type { ChatHarnessAuth } from './harness-auth.js';

const USER_MEMORY_ROLE_ARN = 'BOTCUBE_USER_MEMORY_ROLE_ARN';

/** The `turnCredentials` adapter: `assume-role` with the Memory role the deploy names. */
export type TurnCredentialsAdapter = { kind: 'web-identity' } | { kind: 'assume-role'; roleArn: string };

export interface DeploymentAdapters {
  harnessAuth: ChatHarnessAuth;
  turnCredentials: TurnCredentialsAdapter;
  schedules: DeploymentConfig['schedules'];
  telemetry: DeploymentConfig['telemetry'];
  proxy: DeploymentConfig['proxy'];
  models: DeploymentConfig['models'];
}

const ADAPTER_SECTIONS = deploymentSections.pick({ harnessAuth: true, turnCredentials: true, schedules: true, telemetry: true, proxy: true, models: true });

/**
 * The adapters the Chat Service runs on: each section's `kind` in the Deployment Config at BOTCUBE_DEPLOYMENT_CONFIG,
 * or the schema's defaults without one (ADR 0091). Startup stops on a chosen kind whose environment is missing.
 */
export function deploymentAdapters(env: NodeJS.ProcessEnv): DeploymentAdapters {
  const { harnessAuth, turnCredentials, schedules, telemetry, proxy, models } = env.BOTCUBE_DEPLOYMENT_CONFIG
    ? loadDeployment(env.BOTCUBE_DEPLOYMENT_CONFIG).config
    : ADAPTER_SECTIONS.parse({});
  return { harnessAuth, turnCredentials: turnCredentialsAdapter(turnCredentials.kind, env[USER_MEMORY_ROLE_ARN] || undefined), schedules, telemetry, proxy, models };
}

function turnCredentialsAdapter(kind: DeploymentConfig['turnCredentials']['kind'], roleArn: string | undefined): TurnCredentialsAdapter {
  if (kind === 'web-identity') {
    if (roleArn !== undefined) throw new Error(`turnCredentials: ${USER_MEMORY_ROLE_ARN} is set but turnCredentials.kind is web-identity, which assumes no role`);
    return { kind };
  }
  if (roleArn === undefined) throw new Error(`turnCredentials.kind: assume-role needs ${USER_MEMORY_ROLE_ARN}, the Memory role it assumes for each Turn`);
  if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(roleArn)) throw new Error(`${USER_MEMORY_ROLE_ARN} must be an IAM role ARN`);
  return { kind, roleArn };
}
