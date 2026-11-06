import path from 'node:path';
import { existsSync } from 'node:fs';

/**
 * @param {string} appRoot
 * @param {string | undefined} override
 */
export function resolveRepositoryRoot(appRoot, override) {
  if (override) return path.resolve(appRoot, override);
  const monorepoRoot = path.resolve(appRoot, '../../..');
  return existsSync(path.join(monorepoRoot, 'pnpm-workspace.yaml'))
    ? monorepoRoot
    : path.resolve(appRoot, '../..');
}
