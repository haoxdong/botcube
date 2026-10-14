import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// #4020: pnpm refuses an install whose patched dependency's patch file is missing, so the image failed to build.
it('copies the workspace patches into the image before installing', () => {
  expect(read('../../../pnpm-workspace.yaml')).toContain('patches/bedrock-agentcore@0.4.5.patch');
  const dockerfile = read('../Dockerfile');
  const copy = dockerfile.indexOf('COPY ${BOTCUBE_ROOT}/patches/ patches/');
  expect(copy).toBeGreaterThan(-1);
  expect(copy).toBeLessThan(dockerfile.indexOf('pnpm install'));
});
