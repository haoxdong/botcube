import { configSections, type BotCubeConfig } from 'botcube-config';
import { loadConfig } from 'botcube-config/load';
import type { ChatHarnessAuth } from './harness-auth.js';

const USER_MEMORY_ROLE_ARN = 'BOTCUBE_USER_MEMORY_ROLE_ARN';

/** The `awsAccess` adapter: `assume-role` with the Memory role the deploy names. */
export type AwsAccessAdapter = { kind: 'web-identity' } | { kind: 'assume-role'; roleArn: string };

export interface ConfigAdapters {
  harnessAuth: ChatHarnessAuth;
  awsAccess: AwsAccessAdapter;
  schedules: BotCubeConfig['schedules'];
  telemetry: BotCubeConfig['integrations']['telemetry'];
  proxy: BotCubeConfig['network']['proxy'];
  /** `network.corsOrigins`; null keeps the bot's defaults. */
  corsOrigins: string[] | null;
  /** `productName`, the name a run skipped while parked says was paused. */
  productName: string | undefined;
  /** `parking.automationUserAgents`: requests from these keep no parked deployment awake. */
  automationUserAgents: string[];
  models: BotCubeConfig['integrations']['modelGateway'];
}

/**
 * The adapters the Chat Service runs on: each section's `kind` in the BotCube Config at BOTCUBE_CONFIG,
 * or the schema's defaults without one (ADR 0091). Startup stops on a chosen kind whose environment is missing.
 */
export function configAdapters(env: NodeJS.ProcessEnv): ConfigAdapters {
  const { integrations: { harnessAuth, awsAccess, telemetry, modelGateway: models }, network: { proxy, corsOrigins }, schedules, productName, parking } = env.BOTCUBE_CONFIG
    ? loadConfig(env.BOTCUBE_CONFIG)
    : configSections.parse({});
  return {
    harnessAuth, awsAccess: awsAccessAdapter(awsAccess.kind, env[USER_MEMORY_ROLE_ARN] || undefined), schedules, telemetry, proxy,
    corsOrigins: corsOrigins ?? null, productName, automationUserAgents: parking?.automationUserAgents ?? [], models,
  };
}

function awsAccessAdapter(kind: BotCubeConfig['integrations']['awsAccess']['kind'], roleArn: string | undefined): AwsAccessAdapter {
  if (kind === 'web-identity') {
    if (roleArn !== undefined) throw new Error(`awsAccess: ${USER_MEMORY_ROLE_ARN} is set but awsAccess.kind is web-identity, which assumes no role`);
    return { kind };
  }
  if (roleArn === undefined) throw new Error(`awsAccess.kind: assume-role needs ${USER_MEMORY_ROLE_ARN}, the Memory role it assumes for each Turn`);
  if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(roleArn)) throw new Error(`${USER_MEMORY_ROLE_ARN} must be an IAM role ARN`);
  return { kind, roleArn };
}
