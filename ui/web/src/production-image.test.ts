// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const web = fileURLToPath(new URL('..', import.meta.url));

// #4020: botcube/.dockerignore leaves `tests/` out of the production UI image, and `next build` type-checks every
// TypeScript file in the app, test files too, so an import of `tests/` failed the image build. PR runs never build it.
it('imports nothing from tests/, which the production image leaves out', () => {
  const checked = readdirSync(web)
    .filter((entry) => !/^(node_modules|tests|\.next.*)$/.test(entry))
    .flatMap((entry) => statSync(join(web, entry)).isDirectory()
      ? readdirSync(join(web, entry), { recursive: true, encoding: 'utf8' }).map((file) => join(entry, file))
      : [entry])
    .filter((file) => /\.tsx?$/.test(file));
  const intoTests = checked.flatMap((file) =>
    [...readFileSync(join(web, file), 'utf8').matchAll(/(?:from|import\(?)\s*['"](\.[^'"]+)['"]/g)]
      .map(([, specifier]) => specifier as string)
      .filter((specifier) => relative(web, resolve(dirname(join(web, file)), specifier)).startsWith('tests/'))
      .map((specifier) => `${file}: ${specifier}`));
  expect(checked).toContain('.storybook/preview.ts');
  expect(intoTests).toEqual([]);
});
