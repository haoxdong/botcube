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
  ])('accepts a retained owner or nonvisual marker: %s', (source) => {
    expect(bareVisibleMounts(source)).toEqual([]);
  });

  it('keeps visible conditional mounts behind their presence owner', () => {
    const root = resolve(import.meta.dirname, '..');
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
    const failures = files(root).filter((file) => file.endsWith('.tsx') && !/\.(test|stories)\.tsx$/.test(file)).flatMap((file) => bareVisibleMounts(readFileSync(file, 'utf8'), file).map((failure) => `${relative(root, file)}:${failure.line} ${failure.element}`));
    expect(failures).toEqual([]);
  });
});
