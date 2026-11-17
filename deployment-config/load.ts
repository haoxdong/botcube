import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { deploymentConfig, type BotSettings, type DeploymentConfig } from './schema.js';
import { DeploymentConfigError, parseBotSettings, parsed } from './parse.js';

export { DeploymentConfigError, parseBotSettings } from './parse.js';

export interface Deployment {
  readonly config: DeploymentConfig;
  readonly bot: BotSettings;
}

/** The Deployment Config at this path and the bot settings it names, or an error naming the first bad field of each. */
export function loadDeployment(path: string): Deployment {
  const config = parsed(deploymentConfig, readJson(path), `Deployment Config ${path}`);
  const botPath = resolve(dirname(path), config.bot);
  if (!existsSync(botPath)) throw new DeploymentConfigError(`Deployment Config ${path}: bot: no file at ${botPath}`);
  return { config, bot: parseBotSettings(readJson(botPath), `Bot settings ${botPath}`) };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
