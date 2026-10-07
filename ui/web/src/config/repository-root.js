import path from 'node:path';

/**
 * @param {string} appRoot
 * @param {string | undefined} override
 */
export function resolveRepositoryRoot(appRoot, override) {
  return path.resolve(appRoot, override ?? '../../..');
}
