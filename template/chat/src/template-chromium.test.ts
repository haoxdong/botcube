import { afterEach, expect, it, vi } from 'vitest';
import { templateChromiumPath } from '../../../../tests/chat/fakes/template-chromium.js';
import { templateComputerConfig } from './computer.js';

afterEach(() => vi.unstubAllEnvs());

it('selects a test browser without enabling the production Computer', () => {
  vi.stubEnv('TEMPLATE_TEST_CHROMIUM_PATH', '/fixture/browser');
  vi.stubEnv('TEMPLATE_CHROMIUM_PATH', undefined);
  vi.stubEnv('TEMPLATE_SITE_URL', undefined);
  expect(templateChromiumPath()).toBe('/fixture/browser');
  expect(templateComputerConfig(process.env)).toBeNull();
});

it('preserves the production browser configuration independently of the fixture', () => {
  vi.stubEnv('TEMPLATE_TEST_CHROMIUM_PATH', '');
  vi.stubEnv('TEMPLATE_CHROMIUM_PATH', '/production/browser');
  vi.stubEnv('TEMPLATE_SITE_URL', 'https://site.example/login');
  vi.stubEnv('TEMPLATE_COMPUTER_CDP_URL', 'ws://127.0.0.1:8123/computer');
  expect(templateChromiumPath()).toBe('/production/browser');
  vi.stubEnv('TEMPLATE_TEST_CHROMIUM_PATH', '/fixture/browser');
  expect(templateChromiumPath()).toBe('/fixture/browser');
  expect(templateComputerConfig(process.env)).toEqual({
    siteUrl: 'https://site.example',
    chromiumPath: '/production/browser',
    cdpUrl: 'ws://127.0.0.1:8123/computer',
  });
});
