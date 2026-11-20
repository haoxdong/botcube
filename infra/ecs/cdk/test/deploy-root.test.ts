import * as path from 'node:path';
import { activeDeployRoot } from '../lib/deploy-root.js';

test('the deploy root resolves from the working directory', () => {
  expect(activeDeployRoot({ BOTCUBE_DEPLOY_ROOT: 'bot/deploy' })).toBe(path.resolve('bot/deploy'));
});

test('the old CARTRIDGE_DEPLOY_ROOT still names the deploy root while BOTCUBE_DEPLOY_ROOT is unset', () => {
  expect(activeDeployRoot({ CARTRIDGE_DEPLOY_ROOT: 'bot/deploy' })).toBe(path.resolve('bot/deploy'));
  expect(activeDeployRoot({ BOTCUBE_DEPLOY_ROOT: '', CARTRIDGE_DEPLOY_ROOT: 'bot/deploy' })).toBe(path.resolve('bot/deploy'));
});

test('BOTCUBE_DEPLOY_ROOT wins over the old name', () => {
  expect(activeDeployRoot({ BOTCUBE_DEPLOY_ROOT: 'new/deploy', CARTRIDGE_DEPLOY_ROOT: 'old/deploy' })).toBe(path.resolve('new/deploy'));
});

test.each([[{}], [{ BOTCUBE_DEPLOY_ROOT: '' }], [{ CARTRIDGE_DEPLOY_ROOT: '' }]])('a missing deploy root fails loud: %j', env => {
  expect(() => activeDeployRoot(env)).toThrow(new Error('BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'));
});
