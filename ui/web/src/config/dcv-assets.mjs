import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from the package that owns the dependency, independent of the build output directory.
export const liveViewEntry = fileURLToPath(import.meta.resolve('bedrock-agentcore/browser/live-view'));
export const dcvSdkRoot = path.join(path.dirname(liveViewEntry), 'nice-dcv-web-client-sdk');
export const dcvAliases = {
  dcv: path.join(dcvSdkRoot, 'dcvjs-esm', 'dcv.js'),
  'dcv-ui': path.join(dcvSdkRoot, 'dcv-ui', 'dcv-ui.js'),
};

export function materializeDcvAssets(appRoot) {
  const target = path.join(appRoot, 'public', 'nice-dcv-web-client-sdk');
  mkdirSync(path.dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(dcvSdkRoot, target, { recursive: true });
}
