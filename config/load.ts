import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseYaml, readConfigSource } from './read.cjs';
import { botcubeConfig, type BotSettings, type BotCubeConfig } from './schema.js';
import { resolveConfig, type ResolvedConfig } from './resolved.js';
import { BotCubeConfigError } from './parse.js';
import { parseBotSettings, parsed } from './parse.js';

export interface Deployment {
  readonly config: BotCubeConfig;
  readonly bot: BotSettings;
}

export function loadConfig(path: string): BotCubeConfig {
  return parsed(botcubeConfig, readConfigSource(path, BotCubeConfigError), `BotCube Config ${path}`);
}

/** A deployment: its BotCube Config at `path`, and the bot settings its Bot Image holds at `botPath`. */
export function loadBotCube(path: string, botPath = '/bot/bot.yaml'): Deployment {
  const config = loadConfig(path);
  const bot = loadBotSettings(botPath);
  validateBotDeployment(resolveConfig(config), bot, `BotCube Config ${path}`);
  return { config, bot };
}

export function validateBotDeployment(resolved: ResolvedConfig, bot: BotSettings, source: string): void {
  if (resolved.config.liveView.kind === 'none' && bot.agentComputer.liveBrowser) {
    throw new BotCubeConfigError(`${source}: liveView: none, but the bot settings turn agentComputer.liveBrowser on`);
  }
  for (const { key, provider } of bot.models) {
    const gateway = resolved.modelGateway[provider];
    if (!gateway) throw new BotCubeConfigError(`${source}: modelGateway has no entry for provider ${provider}`);
    const { unreachableReason } = gateway;
    if (unreachableReason) throw new BotCubeConfigError(`${source}: the bot settings' model ${key} is on provider ${provider}, but ${unreachableReason}`);
  }
}

export function loadBotSettings(path: string): BotSettings {
  const source = `Bot settings ${path}`;
  if (basename(path) === 'bot.json') throw new BotCubeConfigError(`${source}: bot.json: renamed to /bot/bot.yaml`);
  return parseBotSettings(readYaml(path, source), source);
}


function readYaml(path: string, source: string): unknown {
  if (!existsSync(path)) throw new BotCubeConfigError(`${source}: no file`);
  return parseYaml(readFileSync(path, 'utf8'), source, BotCubeConfigError);
}
