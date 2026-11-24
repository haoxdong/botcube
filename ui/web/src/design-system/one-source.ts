// The one-source check (ADR 0094): a listed part's marks appear in its one file and its named exceptions only; UI is
// a listed part's or UNLISTED; a stock library is imported only in its own folder.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { LIBRARIES, type Library, type Row } from './components';

/** The UI's sources under `web` (botcube/ui/web), by path from it: its stylesheets and code, without tests or stories. */
export function sourcesOf(web: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(path.join(web, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(css|tsx?)$/.test(file) && !/\.(test|stories)\.tsx?$/.test(file))
      .map((file) => [`src/${file.split(path.sep).join('/')}`, readFileSync(path.join(web, 'src', file), 'utf8')]),
  );
}

/** A file without its extension: a part's stylesheet and its component, `x.css` and `x.tsx`, are one part. */
const stem = (file: string) => file.replace(/\.\w+$/, '');
/** UI: a stylesheet, or a component under `src/components`. */
const isUi = (file: string) => file.endsWith('.css') || /^src\/components\/.+\.tsx$/.test(file);

/** Each source that builds a listed part outside its one file, and each named exception that no longer does. A stock
    part's file is shadcn's or AI Elements', unedited, so what it holds, such as its own layer, is its own; so is what a
    stock library's folder holds, the agent computer's Fluent UI (ADR 0093, ADR 0094). */
export function oneSourceOffences(sources: Record<string, string>, parts: readonly Row[], libraries: readonly Library[] = LIBRARIES): string[] {
  const stock = parts.filter((part) => 'kind' in part && part.kind === 'stock').map((part) => part.file);
  const libraryOwns = (file: string) => libraries.some((library) => file.startsWith(library.under));
  return parts.flatMap((part) => {
    const exceptions = Object.keys(part.exceptions ?? {});
    const marking = (file: string, text: string) => (part.marks ?? []).filter((mark) => (mark.within?.test(file) ?? true) && mark.pattern.test(text));
    const copies = Object.entries(sources).flatMap(([file, text]) => {
      if (stem(file) === stem(part.file) || exceptions.includes(file) || stock.includes(file) || libraryOwns(file)) return [];
      return marking(file, text).map((mark) => `${file} copies the ${part.name} (it ${mark.what}): use the one in ${part.file}`);
    });
    const stale = exceptions
      .filter((file) => marking(file, sources[file] ?? '').length === 0)
      .map((file) => `${file} no longer copies the ${part.name}: drop it from the ${part.name}'s exceptions`);
    return [...copies, ...stale];
  });
}

/** Each UI file outside every listed part and `unlisted`, and each `unlisted` file that no longer is. */
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

/** Each import of a stock library outside its folder. */
export function libraryOffences(sources: Record<string, string>, libraries: readonly Library[]): string[] {
  return Object.entries(sources).flatMap(([file, text]) => [...new Set([...text.matchAll(imported)].map((match) => match[1] ?? ''))].flatMap((name) =>
    libraries.filter((library) => library.packages.test(name) && !file.startsWith(library.under))
      .map((library) => `${file} imports ${library.name} (${name}) outside ${library.under}: use shadcn or AI Elements`)));
}
