// A new colour, size, radius, shadow, duration or curve fails here; to add one, first merge or drop another (DESIGN.md).
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AGENT, COLOURS, LIGHT, MOTION, RADII, SIZES, hoverOffences, hoverIn, offences, rawColoursIn, rawMotionIn, reduceMotionPathsIn, rulesOf, tokensOf } from './design-system';

// The BotCube tree, the published repository's root.
const cube = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (file: string) => readFileSync(path.join(cube, file), 'utf8');

// The tokens: globals.css imports them first, ahead of its sheets by surface.
const GLOBALS = 'ui/web/src/app/tokens.css';
// Every stylesheet of the app's own: globals.css, the sheets split from it by surface and those written apart.
const APP_SHEETS = readdirSync(path.join(cube, 'ui/web/src/app')).filter((file) => file.endsWith('.css')).map((file) => `ui/web/src/app/${file}`);
const tokens = tokensOf(read(GLOBALS));

describe('tokens', () => {
  it('defines ten colours, the agent four, and light and shade', () => {
    expect(tokens.filter((t) => t.startsWith('--color-'))).toEqual(COLOURS.map((c) => `--color-${c}`));
    expect(tokens.filter((t) => t.startsWith('--agent-'))).toEqual(AGENT.map((c) => `--agent-${c}`));
    expect(tokens.filter((t) => /^--(scrim|frost|shadow-)/.test(t))).toEqual(LIGHT);
  });

  it('defines four sizes, two weights, two line-heights and one tracking', () => {
    expect(tokens.filter((t) => t.startsWith('--font-') && !['--font-code', '--font-code-size'].includes(t))).toEqual(SIZES.map((s) => `--font-${s}`));
    expect(tokens.filter((t) => t.startsWith('--weight-'))).toEqual(['--weight-regular', '--weight-semibold']);
    expect(tokens.filter((t) => t.startsWith('--leading'))).toEqual(['--leading', '--leading-loose']);
    expect(tokens.filter((t) => t.startsWith('--tracking-'))).toEqual(['--tracking-caps']);
  });

  it('defines six radii and two shadows', () => {
    expect(tokens.filter((t) => t.startsWith('--radius-'))).toEqual(RADII.map((r) => `--radius-${r}`));
    expect(tokens.filter((t) => t.startsWith('--shadow-'))).toEqual(['--shadow-rest', '--shadow-float']);
  });

  it('defines two durations, one curve and one loop', () => {
    expect(tokens.filter((t) => /^--(motion|ease)/.test(t))).toEqual(MOTION);
  });

});

it.each([...APP_SHEETS, 'ui/web/src/computer/styles.css', 'ui/web/src/computer/files-menu.css', 'templates/always-on/ui/web/src/styles.css'])('%s keeps to the tokens', (file) => {
  expect(offences(rulesOf(read(file), { tokens: file === GLOBALS }), tokens)).toEqual({
    rawColours: [],
    namedColours: [],
    colourTokens: [],
    type: [],
    corners: [],
    motion: [],
    undefinedTokens: [],
  });
});

it('keeps raw durations and curves out of components', () => {
  expect(rawMotionIn(path.join(cube, 'ui/web/src'))).toEqual([]);
});

it.each([
  ['a raw duration', 'a { transition: opacity 0.2s var(--ease); }'],
  ['a raw curve', 'a { transition: opacity var(--motion-quick) ease-out; }'],
  ["the browser's own curve", 'a { transition: opacity var(--motion-quick); }'],
  ['a loop at its own speed', 'a { animation: spin 0.8s linear infinite; }'],
  ['a one-off animation outside the tokens', 'a { animation: messageIn var(--motion-move) ease-out; }'],
])('finds %s', (_, css) => {
  expect(offences(css, tokens).motion).toHaveLength(1);
});

it('keeps motion from the tokens', () => {
  const css = `a { transition: grid-template-rows var(--motion-move) var(--ease), opacity var(--motion-quick) var(--ease); }
    b { animation: shimmer var(--motion-loop) linear infinite; } c { animation: edge linear both; } d { transition: none; }`;
  expect(offences(css, tokens).motion).toEqual([]);
});

it("colours text from the tokens, or a code block's tokens with Shiki's colours", () => {
  const outside = [...APP_SHEETS.map(read).join('\n').matchAll(/\bcolor: var\((--[\w-]+)\)/g)].map(([, name = '']) => name).filter((name) => !tokens.includes(name));
  expect(outside).toEqual(['--sdm-c']);
});

it('keeps raw colours out of components', () => {
  // Marq's avatar is an illustration; Chrome's dock icon is Google's own logo; a Sheet's standard colors are its
  // cells' own, as the Sheet format names them, not the app's.
  const exempt = {
    'app/avatar.tsx': /#[0-9a-f]{6}/i,
    'app/sheet-model.ts': /#[0-9a-f]{6}/i,
    'computer/agent-computer.tsx': /#(1a73e8|4285f4|8ab4f8|ffffff)\b/i,
  };
  expect(rawColoursIn(path.join(cube, 'ui/web/src'), exempt)).toEqual([]);
});

it('rejects bare hover in the fixture stylesheet', () => {
  expect(hoverOffences('button:hover { color: inherit; }')).toEqual(['button:hover']);
});

it.each([
  '@media (hover: hover) { button:hover { color: inherit; } }',
  '@media (min-width: 600px) { @media (hover:hover) { button { &:hover { color: inherit; } } } }',
])('allows hover-capable CSS: %s', (css) => {
  expect(hoverOffences(css)).toEqual([]);
});

it.each([
  '@media (hover: hover), (max-width: 600px) { button:hover {} }',
  '@media not (hover: hover) { button:hover {} }',
  '@media (hover: hover) or (pointer: coarse) { button:hover {} }',
])('rejects a media query that also admits touch: %s', (css) => {
  expect(hoverOffences(css)).toHaveLength(1);
});

it('guards every stylesheet against sticky hover', () => {
  expect(hoverIn(path.join(cube, 'ui/web/src'))).toEqual([]);
});

// The maintainer, 2026-11-03: users with Reduce Motion on didn't get the full experience. BotCube moves the same for
// everyone, and a Reduce Motion path has come back more than once.
it.each(['ui/web/src', ...readdirSync(path.join(cube, 'templates')).map((name) => `templates/${name}/ui/web/src`)])('%s never reads Reduce Motion', (root) => {
  expect(reduceMotionPathsIn(path.join(cube, root))).toEqual([]);
});

it('finds Reduce Motion in sources but not in tests', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'reduced-motion-'));
  try {
    writeFileSync(path.join(root, 'motion.css'), '@media (prefers-reduced-motion: reduce) { a { animation: none; } }');
    writeFileSync(path.join(root, 'motion.tsx'), 'const still = useReducedMotion(); export const config = { reducedMotion: "user" };');
    writeFileSync(path.join(root, 'motion.test.tsx'), 'page.emulateMedia({ reducedMotion: "reduce" });');
    expect(reduceMotionPathsIn(root)).toEqual([
      { file: 'motion.css', found: ['prefers-reduced-motion'] },
      { file: 'motion.tsx', found: ['useReducedMotion', 'reducedMotion'] },
    ]);
  } finally {
    rmSync(root, { recursive: true });
  }
});


it('styles every story with each stylesheet the app loads', () => {
  const stylesheets = (file: string) =>
    [...read(file).matchAll(/^import ["'](?<sheet>\.[^"']+\.css)["'];?$/gm)]
      .flatMap(({ groups }) => groups?.sheet === undefined ? [] : [path.join(path.dirname(file), groups.sheet)]);
  const stories = stylesheets('ui/web/.storybook/preview.ts');

  expect(stylesheets('ui/web/src/app/layout.tsx').filter((sheet) => !stories.includes(sheet))).toEqual([]);
});
