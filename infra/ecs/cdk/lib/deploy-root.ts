import * as fs from 'node:fs';
import * as path from 'node:path';
import { deployRootFile } from 'botcube-config/read';
import type { SynthesizedConfig } from './parking-transition.js';
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

/** The BotCube Config beside the deploy root, which its identity is built from. */
export function deployRootConfig(deployRoot: string): SynthesizedConfig {
  return { path: path.join(deployRoot, '../botcube.yaml') };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `own` over `defaults`: objects merge key by key, and any other value the deploy root sets replaces the default. */
function overDefaults(defaults: unknown, own: unknown): unknown {
  if (own === undefined) return defaults;
  if (!isRecord(defaults) || !isRecord(own)) return own;
  const keys = new Set([...Object.keys(defaults), ...Object.keys(own)]);
  return Object.fromEntries([...keys].map(key => [key, overDefaults(defaults[key], own[key])]));
}

/**
 * The deploy root's identity over BotCube's `identity-defaults.json`, built from the BotCube Config beside it, with its file paths relative to `repositoryRoot` (absent, BotCube's own directory).
 */
export function deployIdentity(deployRoot: string, repositoryRoot?: string): DeployIdentity {
  const defaults: unknown = JSON.parse(fs.readFileSync(path.resolve(projectDir(__dirname), '../../identity-defaults.json'), 'utf8'));
  return overDefaults(defaults, deployRootFile(deployRoot, 'identity.json', repositoryRoot ? { repositoryRoot } : {})) as DeployIdentity;
}
