import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DeployIdentity } from './production.js';

/** The active Cartridge's deploy directory, named by `CARTRIDGE_DEPLOY_ROOT` and resolved from the working directory. */
export function cartridgeDeployRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.CARTRIDGE_DEPLOY_ROOT;
  if (!root) throw new Error('CARTRIDGE_DEPLOY_ROOT must point to the active Cartridge deploy directory');
  return path.resolve(root);
}

/** This project's directory holds cdk.json, whether the app runs from source or from dist/. */
export function projectDir(dir: string): string {
  if (fs.existsSync(path.join(dir, 'cdk.json'))) return dir;
  if (path.dirname(dir) === dir) throw new Error('The ECS CDK app has no cdk.json above it');
  return projectDir(path.dirname(dir));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `cartridge` over `defaults`: objects merge key by key, and any other value the Cartridge sets replaces the default. */
function overDefaults(defaults: unknown, cartridge: unknown): unknown {
  if (cartridge === undefined) return defaults;
  if (!isRecord(defaults) || !isRecord(cartridge)) return cartridge;
  const keys = new Set([...Object.keys(defaults), ...Object.keys(cartridge)]);
  return Object.fromEntries([...keys].map(key => [key, overDefaults(defaults[key], cartridge[key])]));
}

/** The Cartridge's `identity.json` over BotCube's `identity-defaults.json`. */
export function cartridgeIdentity(deployRoot: string): DeployIdentity {
  const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
  const defaults = read(path.resolve(projectDir(__dirname), '../../identity-defaults.json'));
  return overDefaults(defaults, read(path.join(deployRoot, 'identity.json'))) as DeployIdentity;
}
