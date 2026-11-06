import * as path from 'node:path';
import { cartridgeDeployRoot } from '../lib/cartridge.js';

test('the Cartridge deploy root resolves from the working directory', () => {
  expect(cartridgeDeployRoot({ CARTRIDGE_DEPLOY_ROOT: 'bot/deploy' })).toBe(path.resolve('bot/deploy'));
});

test.each([[{}], [{ CARTRIDGE_DEPLOY_ROOT: '' }]])('a missing Cartridge deploy root fails loud: %j', env => {
  expect(() => cartridgeDeployRoot(env)).toThrow(new Error('CARTRIDGE_DEPLOY_ROOT must point to the active Cartridge deploy directory'));
});
