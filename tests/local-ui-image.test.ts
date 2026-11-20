import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const botcube = resolve(fileURLToPath(new URL('..', import.meta.url)));

it('installs the dev UI from the patched frozen workspace with the default UI plugin', () => {
  const dockerfile = readFileSync(join(botcube, 'infra/local/ui.Dockerfile'), 'utf8').replace(/\\\n/g, '');
  const production = readFileSync(join(botcube, 'ui/web/Dockerfile'), 'utf8');
  const { packageManager } = JSON.parse(readFileSync(join(botcube, 'package.json'), 'utf8')) as { packageManager: string };
  expect(dockerfile).toContain('WORKDIR /workspace/botcube\nCOPY . ./');
  expect(dockerfile).toContain(`npm install --global ${packageManager}`);
  expect(production).toContain(`npm install --global ${packageManager}`);
  expect(dockerfile).toContain('pnpm install --frozen-lockfile --ignore-scripts');
  expect(dockerfile).not.toContain('ln -s');
  expect(dockerfile).toContain('ENV CARTRIDGE_UI_PACKAGE=botcube-ui-web/cartridge-default');
  expect(dockerfile).not.toContain('CARTRIDGE_UI_BUILD_CONFIG');
  expect(dockerfile).toContain('CMD ["pnpm", "--filter", "botcube-ui-web", "dev", "--hostname", "0.0.0.0"]');
  const ignored = readFileSync(join(botcube, '.dockerignore'), 'utf8').split('\n').filter(Boolean);
  for (const path of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'patches/bedrock-agentcore@0.4.5.patch']) {
    expect(readFileSync(join(botcube, path), 'utf8').length).toBeGreaterThan(0);
    expect(ignored).not.toContain(path);
  }
});
