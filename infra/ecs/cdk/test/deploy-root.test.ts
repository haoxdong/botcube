import * as path from 'node:path';
import { activeDeployRoot } from '../lib/deploy-root.js';

test('the deploy root resolves from the working directory', () => {
  expect(activeDeployRoot({ BOTCUBE_DEPLOY_ROOT: 'bot/deploy' })).toBe(path.resolve('bot/deploy'));
});

test.each([[{}], [{ BOTCUBE_DEPLOY_ROOT: '' }], [{ LEGACY_DEPLOY_ROOT: 'bot/deploy' }]])('a missing deploy root fails loud: %j', env => {
  expect(() => activeDeployRoot(env)).toThrow(new Error('BOTCUBE_DEPLOY_ROOT must point to the active deploy directory'));
});
