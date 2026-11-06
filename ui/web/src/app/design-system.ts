// The design system is locked (DESIGN.md): ten colours, four sizes, two weights, two line-heights, six radii, two
// shadows, two durations, one curve and one loop. These checks find what strays from it; each UI's own test runs them
// over its stylesheets and components.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';

export const COLOURS = ['text', 'text-muted', 'fill', 'line', 'white', 'canvas', 'blue', 'bubble', 'red', 'green'];
export const AGENT = ['body', 'outline', 'deep', 'deepest'];
export const LIGHT = ['--scrim', '--frost', '--shadow-rest', '--shadow-float'];
export const SIZES = ['title', 'body', 'small', 'label'];
export const RADII = ['sm', 'md', 'lg', 'xl', 'screen', 'pill'];
export const MOTION = ['--motion-quick', '--motion-move', '--motion-loop', '--ease'];

type Declaration = { property: string; value: string };

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The first `:root { … }` in tokens.css, where the tokens and only the tokens name raw values. */
function tokenBlock(css: string) {
  const start = css.indexOf(':root {');
  return css.slice(start, css.indexOf('\n}', start));
}

function declarations(css: string): Declaration[] {
  return [...css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)].map(([, property = '', value = '']) => ({ property, value: value.trim() }));
}

/** The custom properties tokens.css's token block defines, in order. */
export const tokensOf = (globals: string) => declarations(tokenBlock(stripComments(globals))).map((d) => d.property);

/** `css`'s rules, without comments and, from tokens.css, without its token block: the one place raw values may sit. */
export function rulesOf(css: string, { tokens = false } = {}) {
  const bare = stripComments(css);
  return tokens ? bare.replace(tokenBlock(bare), '') : bare;
}

const RAW_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(/i;
const NAMED_COLOUR = /\b(black|white|gr[ae]y|silver|red|blue|green|navy)\b/;
const COLOUR_PROPERTIES = /^(color|background(-color)?|border(-[a-z]+)*-color|border(-(top|right|bottom|left))?|outline(-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|scrollbar-color|text-decoration-color|stop-color)$/;

const TYPE: Record<string, RegExp> = {
  // Code runs 0.9em of the text beside it; the Computer's desktop scales with its screen (cqw).
  'font-size': /^(var\(--font-(title|body|small|label|code-size)\)|0\.9em|inherit|[\d.]+cqw)$/,
  'font-weight': /^(var\(--weight-(regular|semibold)\)|inherit)$/,
  // 1 for glyph boxes.
  'line-height': /^(var\(--leading(-loose)?\)|1|inherit)$/,
  'letter-spacing': /^(var\(--tracking-caps\)|0|normal)$/,
  'font-family': /^(var\(--font-code\)|inherit|-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif)$/,
};

const CORNER = new RegExp(`^(var\\(--radius-(${RADII.join('|')})\\)|0|50%|inherit)$`);

const important = (value: string) => value.replace(/\s*!important$/, '');

const MOTION_PROPERTY = /^(transition|animation)(-duration|-delay|-timing-function)?$/;
const RAW_MOTION = /(^|[\s,])\.?\d[\d.]*m?s\b|\b(ease(-in|-out|-in-out)?|linear|cubic-bezier|steps)\b/;

/**
 * Whether one transition or animation strays from the motion tokens: a raw duration or curve, or a duration with no
 * `--ease` beside it (the browser's own `ease` would stand in). A loop keeps its own shape (`linear`, `ease-in-out`)
 * over `--motion-loop`; a scroll-driven animation, with no duration, runs `linear` with its scroll.
 */
function strays(property: string, item: string) {
  const timed = /var\(--motion-(quick|move)\)/.test(item);
  const loop = /\binfinite\b/.test(item) && item.includes('var(--motion-loop)');
  const scrolled = property === 'animation' && !/var\(--motion-|\d+m?s\b/.test(item);
  const bare = item
    .replace(/var\(--[a-z-]+\)/g, '')
    .replace(/(^|[\s,])0m?s\b/g, '$1')
    .replace(loop ? /\b(linear|ease-in-out)\b/g : scrolled ? /\blinear\b/g : /$^/, '');
  return RAW_MOTION.test(bare) || (timed && !property.endsWith('-duration') && !item.includes('var(--ease)'));
}

/**
 * What in `rules` strays from the system: a raw or named colour, a colour token outside the ten and the agent's four,
 * type or a corner not from a token, or a token `tokens` doesn't define (a renamed one resolves to nothing, so a surface
 * silently loses its shadow or corner).
 */
export function offences(rules: string, tokens: string[]) {
  const all = declarations(rules);
  const colourTokens = new Set([...COLOURS.map((c) => `color-${c}`), ...AGENT.map((c) => `agent-${c}`)]);
  // next/font sets `--font-sans` on <html> at runtime.
  const defined = new Set([...tokens, '--font-sans']);
  return {
    rawColours: all.filter(({ value }) => RAW_COLOUR.test(value)),
    namedColours: all.filter(({ property, value }) => COLOUR_PROPERTIES.test(property) && NAMED_COLOUR.test(value.replace(/var\([^)]*\)/g, ''))),
    colourTokens: [...rules.matchAll(/var\(--(color|agent|gray|blue|red|green)-(?!computer-)([a-z0-9-]+)\)/g)]
      .map(([, family, name]) => `${family}-${name}`)
      .filter((token) => !colourTokens.has(token)),
    // The composer's 16px on a touch tablet keeps iOS from zooming into the field.
    type: all.filter(({ property, value }) => TYPE[property]?.test(important(value)) === false && !(property === 'font-size' && value.startsWith('16px'))),
    corners: all.filter(({ property, value }) => /^border(-[a-z]+)*-radius$/.test(property) && important(value).split(/\s+/).some((v) => !CORNER.test(v))),
    motion: all.filter(({ property, value }) => MOTION_PROPERTY.test(property) && important(value).split(',').some((item) => strays(property, item))),
    undefinedTokens: [...rules.matchAll(/var\((--(?:shadow|radius|font|weight|leading|tracking|motion)-?[a-z0-9-]*|--ease)/g)]
      .map(([, name = '']) => name)
      .filter((name) => !defined.has(name)),
  };
}

const filesIn = (root: string, name: RegExp) => readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => name.test(file));

const componentLines = (root: string) =>
  filesIn(root, /(?<!\.test|\.stories)\.tsx?$/).flatMap((file) =>
    readFileSync(path.join(root, file), 'utf8')
      .split('\n')
      .map((line, i) => ({ file, line: i + 1, text: line.trim() }))
      .filter(({ text }) => !/^\/\/|^\*|^\/\*/.test(text)),
  );

/** Tailwind's own durations and curves in a component's classes. */
const RAW_MOTION_IN_COMPONENT = /(^|[\s"'`:])((duration|delay)-\d|ease-(in|out|in-out|linear)\b|animate-(spin|pulse|bounce|ping)\b(?!["'\]]))/;

/** Lines of `root`'s components that set a duration or curve outside the motion tokens. */
export function rawMotionIn(root: string) {
  return componentLines(root).filter(({ text }) => RAW_MOTION_IN_COMPONENT.test(text));
}

const RAW_IN_COMPONENT = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b(?![0-9a-z])|\brgba?\(|\b(bg|text|border|fill|stroke|ring)-(black|white|gray|slate|zinc|neutral|red|blue|green|sky)\b|-\[#/i;

/** Lines of `root`'s components that name a raw colour, but for each `exempt` file's own (keyed relative to `root`). */
export function rawColoursIn(root: string, exempt: Record<string, RegExp> = {}) {
  return componentLines(root).filter(
    ({ file, text }) => RAW_IN_COMPONENT.test(text) && !(exempt[file]?.test(text) && !/\b(bg|text|border)-/.test(text)),
  );
}

function hoverGuarded(node: postcss.ChildNode) {
  for (let parent: postcss.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (parent instanceof postcss.AtRule && parent.name === 'media' &&
      /\(\s*hover\s*:\s*hover\s*\)/i.test(parent.params) &&
      !/\bnot\b|\bor\b|,/i.test(parent.params)) return true;
  }
  return false;
}

export function hoverOffences(css: string) {
  const found: string[] = [];
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    if (/:hover\b/.test(rule.selector) && !hoverGuarded(rule)) found.push(rule.selector);
  });
  return found;
}

// BotCube has one motion: full motion always, whatever the OS's Reduce Motion asks. Spelled in pieces so this
// file doesn't match itself.
const REDUCED_MOTION = new RegExp(['prefers-reduced-' + 'motion', 'reduced' + 'Motion', 'useReduced' + 'Motion'].join('|'), 'g');

/** Each source file under `root`, tests and stories aside, that reads or sets the OS's Reduce Motion. */
export function reduceMotionPathsIn(root: string) {
  return filesIn(root, /(?<!\.test|\.stories)\.(tsx?|css)$/).flatMap((file) => {
    const found = readFileSync(path.join(root, file), 'utf8').match(REDUCED_MOTION);
    return found ? [{ file, found: [...new Set(found)] }] : [];
  });
}

export function hoverIn(root: string) {
  return filesIn(root, /\.css$/).flatMap((file) => {
    const hover = hoverOffences(readFileSync(path.join(root, file), 'utf8'));
    return hover.length ? [{ file, hover }] : [];
  });
}
