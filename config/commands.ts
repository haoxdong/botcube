import { parseArgs } from 'node:util';
import { footprint, formatFootprint, type FilesAccessPointMode, type FootprintOptions } from './footprint.js';
import { loadBotCube, loadConfig } from './load.js';
import { resolveConfig, resolvedJson } from './resolved.js';
import { BotCubeConfigError } from './parse.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const RESOLVE_USAGE = 'botcube resolve <botcube.yaml>';
const FOOTPRINT_USAGE = 'botcube footprint [--files-access-point-mode <runtime|pool>] [--bot <bot.yaml>] <botcube.yaml>';
const MODES: readonly string[] = ['runtime', 'pool'] satisfies FilesAccessPointMode[];
const isMode = (value: string | undefined): value is FilesAccessPointMode | undefined => value === undefined || MODES.includes(value);

export function main(argv: readonly string[], io: CliIo): number {
  try {
    if (argv[0] === 'resolve') {
      const path = argv[1];
      if (argv.length !== 2 || !path || path.startsWith('-')) {
        io.stderr(`Usage: ${RESOLVE_USAGE}\n`);
        return 2;
      }
      io.stdout(resolvedJson(resolveConfig(loadConfig(path))));
      return 0;
    }
    const parsed = parseFlags(argv);
    if (!parsed) {
      io.stderr(`Usage: ${FOOTPRINT_USAGE}\n       ${RESOLVE_USAGE}\n`);
      return 2;
    }
    const { config, bot } = parsed.bot ? loadBotCube(parsed.path, parsed.bot) : { config: loadConfig(parsed.path), bot: undefined };
    io.stdout(formatFootprint(footprint(config, { ...parsed.options, ...(bot ? { bot } : {}) })));
    return 0;
  } catch (error) {
    if (!(error instanceof BotCubeConfigError)) throw error;
    io.stderr(`${error.message}\n`);
    return 1;
  }
}

function parseFlags(argv: readonly string[]): { path: string; bot: string | undefined; options: FootprintOptions } | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv], allowPositionals: true, strict: true,
      options: { 'files-access-point-mode': { type: 'string' }, bot: { type: 'string' } },
    });
    const [command, path, ...rest] = positionals;
    const mode = values['files-access-point-mode'];
    return command === 'footprint' && path && rest.length === 0 && isMode(mode) ? { path, bot: values.bot, options: mode ? { filesAccessPointMode: mode } : {} } : undefined;
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS_')) return undefined;
    throw error;
  }
}
