import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const botcube = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('BotCube template Cartridge', () => {
  it('installs the browser in the base before any Cartridge tools', () => {
    const dockerfile = readFileSync(
      resolve(botcube, 'harness/deepagents/Dockerfile'),
      'utf8',
    );

    const [base, cartridge] = dockerfile.split('FROM base AS harness');
    expect(base).toContain('node install.mjs /opt/browser');
    expect(base).toContain('cp "/opt/browser/$BIN" /usr/local/bin/agent-browser');
    expect(cartridge).not.toContain('/usr/local/bin/agent-browser');
    expect(dockerfile).not.toContain('if [ -f "/opt/tools/$BIN" ]');
  });

  it('keeps Harness framework imports out of the template package', () => {
    expect(existsSync(
      resolve(botcube, 'templates/always-on/src/botcube_always_on/local_harness.py'),
    )).toBe(false);
    expect(readFileSync(
      resolve(botcube, 'templates/always-on/src/botcube_always_on/harness.py'),
      'utf8',
    )).not.toContain('botcube_harness_deepagents');
  });
});
