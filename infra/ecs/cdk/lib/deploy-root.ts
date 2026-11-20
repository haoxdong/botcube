import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DeployIdentity } from './production-identity.js';
import { projectDir } from './project-dir.js';

/**
 * The active deploy directory, named by `BOTCUBE_DEPLOY_ROOT` and resolved from the working directory.
 */
export function activeDeployRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.BOTCUBE_DEPLOY_ROOT;
  if (!root) throw new Error('BOTCUBE_DEPLOY_ROOT must point to the active deploy directory');
  return path.resolve(root);
}

export { projectDir };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `own` over `defaults`: objects merge key by key, and any other value the deploy root sets replaces the default. */
function overDefaults(defaults: unknown, own: unknown): unknown {
  if (own === undefined) return defaults;
  if (!isRecord(defaults) || !isRecord(own)) return own;
  const keys = new Set([...Object.keys(defaults), ...Object.keys(own)]);
  return Object.fromEntries([...keys].map(key => [key, overDefaults(defaults[key], own[key])]));
}

/** The deploy root's `identity.json` over BotCube's `identity-defaults.json`. */
export function deployIdentity(deployRoot: string): DeployIdentity {
  const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
  const defaults = read(path.resolve(projectDir(__dirname), '../../identity-defaults.json'));
  return overDefaults(defaults, read(path.join(deployRoot, 'identity.json'))) as DeployIdentity;
}
