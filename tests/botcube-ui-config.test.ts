import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { resolveRepositoryRoot } from '../ui/web/src/config/repository-root.js';

const botcube = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('BotCube UI config', () => {
  it('roots the default workspace app at the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'botcube-monorepo-ui-'));
    const appRoot = join(root, 'botcube/ui/web');
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(resolveRepositoryRoot(appRoot, undefined)).toBe(root);
  });

  it('roots a public clone at its own workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'botcube-public-ui-'));
    const appRoot = join(root, 'ui/web');
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(resolveRepositoryRoot(appRoot, undefined)).toBe(root);
  });

  it('allows a container to supply its own repository root', () => {
    const appRoot = resolve(botcube, 'ui/web');

    expect(resolveRepositoryRoot(appRoot, '../..')).toBe(botcube);
  });
});
