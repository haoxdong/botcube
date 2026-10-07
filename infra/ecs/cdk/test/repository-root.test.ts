import * as path from 'node:path';
import { cartridgeDeployRoot } from '../lib/cartridge.js';
import type { ProductionOptions } from '../lib/production.js';

const mockDefineProduction = jest.fn<void, [unknown, ProductionOptions]>();

jest.mock('../lib/production.js', () => ({
  ...jest.requireActual('../lib/production.js'),
  defineProduction: mockDefineProduction,
}));

const deployRoot = cartridgeDeployRoot();

function entrypointRoot(override?: string): string {
  const saved = { ...process.env };
  process.env.CARTRIDGE_DEPLOY_ROOT = deployRoot;
  process.env.CDK_CONTEXT_JSON = JSON.stringify({ parked: 'false' });
  delete process.env.BOTCUBE_REPOSITORY_ROOT;
  if (override !== undefined) process.env.BOTCUBE_REPOSITORY_ROOT = override;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jest.isolateModules(() => { require('../bin/cdk'); });
    const [options] = mockDefineProduction.mock.calls.map(([, options]) => options);
    if (!options) throw new Error('CDK entrypoint must compose production');
    return options.repositoryRoot;
  } finally {
    process.env = saved;
    mockDefineProduction.mockClear();
  }
}

test('the standalone checkout root reaches ECS composition instead of ascending above the clone', () => {
  expect(entrypointRoot('/tmp/standalone-botcube')).toBe('/tmp/standalone-botcube');
});


test('an unset root keeps the current monorepo asset context', () => {
  expect(entrypointRoot()).toBe(path.resolve(__dirname, '../../../../..'));
});

test('a relative root resolves from the ECS CDK project directory', () => {
  expect(entrypointRoot('../../..')).toBe(path.resolve(__dirname, '../../../..'));
});
