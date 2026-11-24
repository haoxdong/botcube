import { expect, it } from 'vitest';

import { baseOf, besideOf, filesPath, hrefOf, linkedPath, nameOf } from './files-path';

it.each([
  ['/artifacts/q3%20100%25.md', '/artifacts/q3 100%.md'],
  ['/reports/q%233.csv', '/reports/q#3.csv'],
  ['report.csv', '/report.csv'],
])('reads the link %s as the path %s, and spells it back as a link that reads the same', (href, path) => {
  expect(linkedPath(href)).toBe(path);
  expect(linkedPath(hrefOf(filesPath(path)))).toBe(path);
});

it.each(['https://example.com/a.csv', '/a.csv#top', '/a.csv?x=1', '//host/a.csv', '/a/../c', '/a//c', 'notes', 'a/c.csv', '/100%.md'])(
  'names no file for the link %s',
  (href) => expect(linkedPath(href)).toBeNull(),
);

it('names a file for the Files routes, by its own name, and beside itself', () => {
  const path = filesPath('artifacts/q3 100%.md');
  expect(path).toBe('/artifacts/q3 100%.md');
  expect(nameOf(path)).toBe('artifacts/q3 100%.md');
  expect(baseOf(path)).toBe('q3 100%.md');
  expect(besideOf(path, 'q4.md')).toBe('/artifacts/q4.md');
});
