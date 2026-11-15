import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handRolls } from '../../test/hand-roll-policy';
import allowance from '../../test/hand-roll-allowlist.json';
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
    const failures = sourceFiles(root).filter((file) => file.endsWith('.tsx') && !/\.(test|stories)\.tsx$/.test(file)).flatMap((file) => bareVisibleMounts(readFileSync(file, 'utf8'), file).map((failure) => `${relative(root, file)}:${failure.line} ${failure.element}`));
    expect(failures).toEqual([]);
  });
});

const sourceRoot = resolve(import.meta.dirname, '..');
const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? sourceFiles(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);

it('allows only the named remaining hand-rolls, with no stale allowances', () => {
  const remaining = Object.fromEntries(sourceFiles(sourceRoot).filter((file) => /\.tsx?$/.test(file) && !/\.(test|stories|d)\.tsx?$/.test(file)).flatMap((file) => {
    const counts = handRolls(readFileSync(file, 'utf8'));
    return Object.keys(counts).length ? [[relative(sourceRoot, file), counts]] : [];
  }));
  expect(remaining).toEqual(Object.fromEntries(Object.entries(allowance).map(([file, entry]) => [file, entry.counts])));
  expect(Object.values(allowance).every((entry) => entry.reason.length > 0)).toBe(true);
});

it.each([
  ['requestAnimationFrame(() => {}); window.requestAnimationFrame(tick);', { requestAnimationFrame: 2 }],
  ['box.animate([]); box["animate"]([]); animateMini(box, {});', { animate: 2, animateMini: 1 }],
  ['new ResizeObserver(resize); new window.ResizeObserver(resize);', { ResizeObserver: 2 }],
  ['box.scrollTop = 10; box["scrollLeft"] += 1; box.scrollTop++; box.scrollTo(0, 1); box.scrollBy(1, 0); box.scrollIntoView(); box.scroll(0, 0);', { 'scroll-write': 7 }],
  ['const text = "requestAnimationFrame()"; /* box.animate([]) */ box.scrollTop === 1; const y = box.scrollTop; !box.scrollTop; +box.scrollLeft; ~box.scrollTop;', {}],
])('detects hand-rolls in executable syntax: %s', (source, counts) => {
  expect(handRolls(source)).toEqual(counts);
});

it('never grows an existing allowance', () => {
  const file = 'botcube/ui/web/test/hand-roll-allowlist.json';
  const baseFiles = execFileSync('git', ['ls-tree', '--name-only', 'origin/main', '--', file], { encoding: 'utf8' }).trim();
  if (!baseFiles) return;
  const previous: Record<string, { counts: Record<string, number> }> = JSON.parse(execFileSync('git', ['show', `origin/main:${file}`], { encoding: 'utf8' }));
  const restoration: Record<string, Record<string, number>> = {
    // Temporary emergency restore; remove with the off-the-shelf picker rebuild.
    'app/model-effort-picker.tsx': { animateMini: 1 },
  };
  for (const [module, entry] of Object.entries(allowance)) {
    for (const [kind, count] of Object.entries(entry.counts)) expect(count, `${module} ${kind}`).toBeLessThanOrEqual(previous[module]?.counts[kind] ?? restoration[module]?.[kind] ?? 0);
  }
});
