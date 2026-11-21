import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const botcube = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('the Harness image', () => {
  it('installs the browser in the base before any bot tools', () => {
    const dockerfile = readFileSync(
      resolve(botcube, 'harness/deepagents/Dockerfile'),
      'utf8',
    );

    const [base, bot] = dockerfile.split('FROM base AS harness');
    expect(base).toContain('node install.mjs /opt/browser');
    expect(base).toContain('cp "/opt/browser/$BIN" /usr/local/bin/agent-browser');
    expect(bot).not.toContain('/usr/local/bin/agent-browser');
    expect(dockerfile).not.toContain('if [ -f "/opt/tools/$BIN" ]');
  });
});
