import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bareVisibleMounts } from '../../test/presence-policy';

describe('conditional mount ownership', () => {
  it.each([
    '<main>{error && <p role="alert">Failed</p>}</main>',
    '<main>{editing ? <Editor /> : <Document />}</main>',
    '<main>{open && <><p>Message</p><button>Retry</button></>}</main>',
    '<Presence>{open && <div>Unanimated</div>}</Presence>',
    '<Presence><div>{open && <m.div exit={{opacity:0}} />}</div></Presence>',
    '<Swap state="fixed"><div>{open && <button>Delete</button>}</div></Swap>',
    '<main>{open && <Suspense><button>Action</button></Suspense>}</main>',
    '<main>{open && <p hidden={false}>Visible</p>}</main>',
    '<main>{open && <input type="file" />}</main>',
  ])('rejects a visible mount without presence: %s', (source) => {
    expect(bareVisibleMounts(source).length).toBeGreaterThan(0);
  });

  it.each([
    '<Presence>{open && <m.div initial={{opacity:0}} exit={{opacity:0}}>Panel</m.div>}</Presence>',
    '<Swap state={editing}>{editing ? <Editor /> : <Document />}</Swap>',
    '<main>{kept && <Sheet open={open}>Contents</Sheet>}</main>',
    '<main>{earlier && <div data-chat-earlier aria-hidden />}</main>',
    '<RowCollapse open={failed}>{failed && <LoadFailed />}</RowCollapse>',
    '<AnimatePresence>{open && <GridCollapsible key={opens}>Steps</GridCollapsible>}</AnimatePresence>',
  ])('accepts a retained owner or nonvisual marker: %s', (source) => {
    expect(bareVisibleMounts(source)).toEqual([]);
  });

  it('keeps visible conditional mounts behind their presence owner', () => {
    const root = resolve(import.meta.dirname, '..');
    const failures = sourceFiles(root).filter((file) => file.endsWith('.tsx') && !/\.(test|stories)\.tsx$/.test(file) && !stock(file)).flatMap((file) => bareVisibleMounts(readFileSync(file, 'utf8'), file).map((failure) => `${relative(root, file)}:${failure.line} ${failure.element}`));
    expect(failures).toEqual([]);
  });
});

// The UI exceptions check proves a components/ui file without a `stock component diff` row is shadcn's file verbatim;
// vendor code is not ours to wrap, and its callers own presence.
const modified = new Set((JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../internal/ui-exceptions.json'), 'utf8')) as { file: string; pattern: string }[])
  .filter((entry) => entry.pattern === 'stock component diff').map((entry) => entry.file));
const stock = (file: string) => file.includes('/src/components/ui/') && !modified.has(relative(resolve(import.meta.dirname, '../../../../..'), file));

const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sourceFiles(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
