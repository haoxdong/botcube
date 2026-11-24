import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { Library, Row } from './components';

export function sourcesOf(web: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(path.join(web, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(css|tsx?)$/.test(file) && !/\.(test|stories)\.tsx?$/.test(file))
      .map((file) => [`src/${file.split(path.sep).join('/')}`, readFileSync(path.join(web, 'src', file), 'utf8')]),
  );
}

const stem = (file: string) => file.replace(/\.\w+$/, '');
const isUi = (file: string) => file.endsWith('.css') || /^src\/components\/.+\.tsx$/.test(file);

export function oneSourceOffences(sources: Record<string, string>, parts: readonly Row[]): string[] {
  return parts.flatMap((part) => {
    const exceptions = Object.keys(part.exceptions ?? {});
    const marking = (text: string) => (part.marks ?? []).filter((mark) => mark.pattern.test(text));
    const copies = Object.entries(sources).flatMap(([file, text]) => {
      if (stem(file) === stem(part.file) || exceptions.includes(file)) return [];
      return marking(text).map((mark) => `${file} copies the ${part.name} (it ${mark.what}): use the one in ${part.file}`);
    });
    const stale = exceptions
      .filter((file) => marking(sources[file] ?? '').length === 0)
      .map((file) => `${file} no longer copies the ${part.name}: drop it from the ${part.name}'s exceptions`);
    return [...copies, ...stale];
  });
}

export function unlistedOffences(sources: Record<string, string>, parts: readonly Row[], unlisted: Readonly<Record<string, string>>): string[] {
  const listed = new Set(parts.map((part) => stem(part.file)));
  const ui = Object.keys(sources).filter(isUi);
  const outside = ui
    .filter((file) => !listed.has(stem(file)) && !(file in unlisted))
    .map((file) => `${file} builds UI outside a listed part: add its row to the components list`);
  const stale = Object.keys(unlisted)
    .filter((file) => !ui.includes(file) || listed.has(stem(file)))
    .map((file) => `${file} is no longer UI outside a listed part: drop it from the unlisted exceptions`);
  return [...outside, ...stale];
}

const imported = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

export function libraryOffences(sources: Record<string, string>, libraries: readonly Library[]): string[] {
  return Object.entries(sources).flatMap(([file, text]) => [...new Set([...text.matchAll(imported)].map((match) => match[1] ?? ''))].flatMap((name) =>
    libraries.filter((library) => library.packages.test(name) && !file.startsWith(library.under))
      .map((library) => `${file} imports ${library.name} (${name}) outside ${library.under}: use shadcn or AI Elements`)));
}
