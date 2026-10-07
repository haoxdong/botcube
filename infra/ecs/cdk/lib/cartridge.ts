import * as path from 'node:path';

/** The active Cartridge's deploy directory, named by `CARTRIDGE_DEPLOY_ROOT` and resolved from the working directory. */
export function cartridgeDeployRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.CARTRIDGE_DEPLOY_ROOT;
  if (!root) throw new Error('CARTRIDGE_DEPLOY_ROOT must point to the active Cartridge deploy directory');
  return path.resolve(root);
}
