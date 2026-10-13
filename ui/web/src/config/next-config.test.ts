// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

import createConfig from '../../next.config';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('keeps an alias into the app relative to the app', async () => {
  vi.stubEnv('CARTRIDGE_UI_BUILD_CONFIG', fileURLToPath(new URL('../../tests/in-app-build-config.mjs', import.meta.url)));

  const config = await createConfig('phase-development-server');

  expect(config.turbopack?.resolveAlias?.dcv).toBe('./node_modules/bedrock-agentcore/dcv.js');
});
