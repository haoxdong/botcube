import { parseArgs } from 'node:util';
import { footprint, formatFootprint, type FilesAccessPointMode, type FootprintOptions } from './footprint.js';
import { loadDeployment } from './load.js';
import { DeploymentConfigError } from './parse.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const USAGE = 'Usage: botcube footprint [--files-access-point-mode <runtime|pool>] <deployment-config.json>\n';
const MODES: readonly string[] = ['runtime', 'pool'] satisfies FilesAccessPointMode[];
const isMode = (value: string | undefined): value is FilesAccessPointMode | undefined => value === undefined || MODES.includes(value);

/** `botcube footprint`: prints what a Deployment Config needs from its AWS account, and returns the exit code. */
export function main(argv: readonly string[], io: CliIo): number {
  const parsed = parseFlags(argv);
  if (!parsed) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    io.stdout(formatFootprint(footprint(loadDeployment(parsed.path).config, parsed.options)));
    return 0;
  } catch (error) {
    if (!(error instanceof DeploymentConfigError)) throw error;
    io.stderr(`${error.message}\n`);
    return 1;
  }
}

function parseFlags(argv: readonly string[]): { path: string; options: FootprintOptions } | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv], allowPositionals: true, strict: true,
      options: { 'files-access-point-mode': { type: 'string' } },
    });
    const [command, path, ...rest] = positionals;
    const mode = values['files-access-point-mode'];
    return command === 'footprint' && path && rest.length === 0 && isMode(mode) ? { path, options: mode ? { filesAccessPointMode: mode } : {} } : undefined;
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS_')) return undefined;
    throw error;
  }
}
