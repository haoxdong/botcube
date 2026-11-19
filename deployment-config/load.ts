import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deploymentConfig, type BotSettings, type DeploymentConfig } from './schema.js';
import { DeploymentConfigError, parseBotSettings, parsed } from './parse.js';

export interface Deployment {
  readonly config: DeploymentConfig;
  readonly bot: BotSettings;
}

/** The Deployment Config at this path and the bot settings it names, or an error naming the first bad field of each. */
export function loadDeployment(path: string): Deployment {
  const source = `Deployment Config ${path}`;
  const config = parsed(deploymentConfig, readJson(path, source, `${source}: no file`), source);
  const botPath = resolve(dirname(path), config.bot);
  const botSource = `Bot settings ${botPath}`;
  const bot = parseBotSettings(readJson(botPath, botSource, `${source}: bot: no file at ${botPath}`), botSource);
  if (config.liveView.kind === 'none' && bot.agentComputer.liveBrowser) {
    throw new DeploymentConfigError(`${source}: liveView: none, but the bot settings turn agentComputer.liveBrowser on`);
  }
  return { config, bot };
}

function readJson(path: string, source: string, missing: string): unknown {
  if (!existsSync(path)) throw new DeploymentConfigError(missing);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new DeploymentConfigError(`${source}: not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
