import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseYaml, readConfigSource } from './read.cjs';
import { botcubeConfig, type BotSettings, type BotCubeConfig } from './schema.js';
import { BotCubeConfigError } from './parse.js';
import { parseBotSettings, parsed } from './parse.js';

export interface Deployment {
  readonly config: BotCubeConfig;
  readonly bot: BotSettings;
}

export function loadConfig(path: string): BotCubeConfig {
  return parsed(botcubeConfig, readConfigSource(path, BotCubeConfigError), `BotCube Config ${path}`);
}

export function loadBotCube(path: string): Deployment {
  const config = loadConfig(path);
  const bot = loadBotSettings('/bot/bot.yaml');
  if (config.liveView.kind === 'none' && bot.agentComputer.liveBrowser) {
    throw new BotCubeConfigError(`BotCube Config ${path}: liveView: none, but the bot settings turn agentComputer.liveBrowser on`);
  }
  return { config, bot };
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
