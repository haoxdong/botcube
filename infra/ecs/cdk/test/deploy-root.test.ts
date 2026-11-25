import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { activeDeployRoot, deployIdentity } from '../lib/deploy-root.js';

test('the deploy root resolves from the working directory', () => {
  expect(activeDeployRoot({ BOTCUBE_DEPLOY_ROOT: 'bot/deploy' })).toBe(path.resolve('bot/deploy'));
});

test.each([[{}], [{ BOTCUBE_DEPLOY_ROOT: '' }], [{ LEGACY_DEPLOY_ROOT: 'bot/deploy' }]])('a missing deploy root fails loud: %j', env => {
  expect(() => activeDeployRoot(env)).toThrow(new Error('BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'));
});

test('managed NAT synth rejects split route tables through BotCube Config validation', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'botcube-egress-'));
  try {
    const config = readFileSync(path.join(__dirname, '../../../../examples/public/botcube.yaml'), 'utf8');
    writeFileSync(path.join(directory, 'botcube.yaml'), config.replace('routeTableId: rtb-placeholder', 'routeTableId: rtb-second'));
    expect(() => deployIdentity(path.join(directory, 'deploy'))).toThrow('private subnets must share one route table');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
