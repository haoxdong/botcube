import { existsSync } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let root = dirname(fileURLToPath(import.meta.url));
while (root !== parse(root).root && !existsSync(resolve(root, 'identity.json'))) {
  root = dirname(root);
}
if (!existsSync(resolve(root, 'identity.json'))) {
  throw new Error('Could not locate the Cartridge deploy root');
}

/** The Cartridge deploy directory: the nearest one holding identity.json. */
export const deployRoot = root;

const app = ['infra', 'botcube/infra']
  .map(infra => resolve(root, '../..', infra, 'agentcore/cdk'))
  .find(candidate => existsSync(resolve(candidate, 'cdk.json')));
if (!app) {
  throw new Error(`Could not locate BotCube's AgentCore CDK app beside ${root}`);
}

/** BotCube's AgentCore CDK app, in BotCube's own repository or under botcube/ beside a vendored Cartridge. */
export const cubeApp = app;
