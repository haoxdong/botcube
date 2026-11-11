// Checks a Slides Source (`project/deck.json`, `project/slides/<id>.html`) against the closed subset (subset.mjs):
// html-validate walks each slide; css-tree matches each inline style. Each error names the file, the element and the
// nearest allowed form (the Artifacts spec, Checker).
import { fork, generate, parse as parseCss, walk } from 'css-tree/dist/csstree.esm';
import { HtmlValidate, Rule, StaticConfigLoader } from 'html-validate';

import { checkIndex } from './deck-index.mjs';
import {
  ELEMENTS, ICON_NAMES, IMAGE_SOURCE, INLINE, LIMITS, NEAREST_ELEMENT, NEAREST_PROPERTY, NEAREST_SVG, PROPERTIES,
  SHAPE_KINDS, SLIDE_ID, SVG_ATTRIBUTES, SVG_ELEMENTS, TEXT,
} from './subset.mjs';

const ROWS = new Map(PROPERTIES.flatMap((row) => row.names.map((name) => [name, row])));
const { lexer } = fork({
  units: { length: ['px', 'pt', 'em', 'rem', 'vw', 'vh'] },
  properties: Object.fromEntries([...ROWS].map(([name, row]) => [name, row.syntax])),
});
const UNITS = new Set(['px', 'deg', 'turn', 'rad', 'fr']);

/** @typedef {import('./check.mjs').CheckError} SlideError */

/**
 * Every error in a deck, given its files by their path under the deck's folder (`project/deck.json`,
 * `project/slides/<id>.html`). An empty list means the deck may be published.
 * @param {Record<string, string>} files
 * @returns {Promise<SlideError[]>}
 */
export async function checkDeck(files) {
  const errors = [];
  const index = 'project/deck.json';
  const slides = Object.keys(files).filter((path) => /^project\/slides\/[^/]+\.html$/.test(path)).sort();
  if (!(index in files)) {
    errors.push({ file: index, element: 'deck.json', message: 'is missing', nearest: 'write project/deck.json with the title and order' });
    return errors;
  }
  errors.push(...checkIndex(files[index], new Set(slides.map(slideId))));
  return [...errors, ...await checkSlides(slides, files)];
}

/** Each slide in turn: a walk reports through the one `sink`, so two checks never overlap. */
async function checkSlides([path, ...rest], files) {
  if (path === undefined) return [];
  const errors = SLIDE_ID.test(slideId(path)) ? await checkSlide(path, files[path])
    : [{ file: path, element: 'file name', message: `"${slideId(path)}" is not a slide id`, nearest: 'a name of letters, digits, _ and -, at most 64' }];
  return [...errors, ...await checkSlides(rest, files)];
}

const slideId = (path) => path.slice('project/slides/'.length, -'.html'.length);

/** The lines and columns of `text`, to place an error found by offset. */
function locator(text) {
  const starts = [0];
  for (let at = 0; at < text.length; at++) if (text[at] === '\n') starts.push(at + 1);
  return (offset) => {
    let line = starts.length - 1;
    while (starts[line] > offset) line--;
    return { line: line + 1, column: offset - starts[line] + 1 };
  };
}

/**
 * An `<svg>` and an `<x-embed>` hold markup of their own: html-validate checks neither, so their contents are blanked
 * (keeping lines and columns) and checked here.
 */
function islands(file, html, errors) {
  const at = locator(html);
  let blanked = html;
  for (const match of html.matchAll(/<(svg|x-embed)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const [whole, tag, inner] = match;
    const start = match.index + whole.indexOf(inner, whole.indexOf('>'));
    const where = { file, ...at(match.index) };
    const bytes = Buffer.byteLength(whole);
    if (tag.toLowerCase() === 'svg') {
      if (bytes > LIMITS.svgBytes) errors.push({ ...where, element: '<svg>', message: `is ${Math.ceil(bytes / 1024)} KB`, nearest: `${LIMITS.svgBytes / 1024} KB or less: simplify the paths` });
      checkSvg(file, inner, (offset) => at(start + offset), errors);
    } else if (bytes > LIMITS.embedBytes) {
      errors.push({ ...where, element: '<x-embed>', message: `is ${Math.ceil(bytes / 1024)} KB`, nearest: `${LIMITS.embedBytes / 1024} KB or less` });
    }
    blanked = blanked.slice(0, start) + inner.replace(/[^\n]/g, ' ') + blanked.slice(start + inner.length);
  }
  return blanked;
}

/**
 * An svg's contents against the subset's svg lists, which the Viewer's sanitizer keeps to as well: an element or
 * attribute outside them is refused here rather than stripped there. The svg's own attributes are checked as any
 * element's.
 */
function checkSvg(file, inner, at, errors) {
  const refuse = (offset, element, message, nearest) => errors.push({ file, ...at(offset), element, message, nearest });
  for (const tag of inner.matchAll(/<([a-zA-Z][\w:.-]*)([^>]*)>/g)) {
    const name = tag[1].toLowerCase();
    if (!SVG_ELEMENTS.includes(name)) {
      refuse(tag.index, `<svg> <${tag[1]}>`, 'is not in an svg chart', NEAREST_SVG[name] ?? nearestOf(name, SVG_ELEMENTS, (allowed) => `<${allowed}>`) ?? 'shapes, paths and gradients: <path>, <rect>, <circle>, <g>');
      continue;
    }
    for (const attribute of tag[2].matchAll(/([^\s=/>"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      const key = attribute[1].toLowerCase();
      const value = (attribute[2] ?? '').replace(/^["']|["']$/g, '');
      const offset = tag.index + 1 + tag[1].length + attribute.index;
      if (/^on/.test(key)) refuse(offset, `<${name} ${key}>`, 'runs a script', 'leave the handler out');
      else if (!['id', 'class'].includes(key) && !key.startsWith('data-') && !SVG_ATTRIBUTES.includes(key)) {
        refuse(offset, `<${name} ${key}>`, 'is not in an svg chart', NEAREST_SVG[key] ?? nearestOf(key, SVG_ATTRIBUTES, (allowed) => allowed) ?? 'leave it out');
      } else if (/url\(\s*["']?(?!#)/i.test(value)) refuse(offset, `<${name} ${key}="${value.slice(0, 40)}">`, 'points outside the svg', 'url(#id) of a gradient or marker in the svg');
    }
  }
}

/** Each slide's walk reports here; a check runs one slide at a time. */
let sink = null;

class SlideFormat extends Rule {
  setup() {
    this.on('dom:ready', ({ document }) => sink(document.root));
  }
}

const validator = new HtmlValidate(new StaticConfigLoader({
  root: true,
  plugins: [{ name: 'slides', rules: { 'slides/format': SlideFormat } }],
  rules: {
    'slides/format': 'error', 'close-order': 'error', 'close-attr': 'error', 'no-dup-attr': 'error', 'no-dup-id': 'error',
    'void-content': 'error', 'attr-delimiter': 'error',
  },
}));

/** @returns {Promise<SlideError[]>} */
async function checkSlide(file, html) {
  const errors = [];
  const id = slideId(file);
  const blanked = islands(file, html, errors);
  sink = (root) => walkSlide(file, id, root, blanked, errors);
  try {
    const report = await validator.validateString(blanked, file);
    for (const result of report.results) {
      for (const message of result.messages) {
        if (message.ruleId === 'slides/format') continue;
        errors.push({ file, line: message.line, column: message.column, element: message.selector ? `<${message.selector}>` : 'markup', message: message.message.replace(/\.$/, ''), nearest: 'well-formed markup: close each element where it opened' });
      }
    }
  } finally {
    sink = null;
  }
  return errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
}

function walkSlide(file, id, root, html, errors) {
  const report = (node, element, message, nearest, location = node.location) =>
    errors.push({ file, line: location.line, column: location.column, element, message, nearest });
  const sections = root.childElements;
  const outside = root.childNodes.some((node) => node.nodeType === 3 && node.textContent.trim() !== '');
  if (sections.length !== 1 || sections[0].tagName !== 'section' || outside) {
    errors.push({ file, line: 1, column: 1, element: 'slide', message: 'is not exactly one <section> with nothing before or after it', nearest: `<section id="${id}" style="…">…</section> alone in the file` });
  }
  const slide = { id, report, count: 0, embeds: 0 };
  const visit = (node, divDepth) => {
    slide.count++;
    const tag = node.tagName;
    if (!(tag in ELEMENTS)) {
      report(node, `<${tag}>`, 'is not in the slide format', NEAREST_ELEMENT[tag] ?? nearestOf(tag, Object.keys(ELEMENTS), (name) => `<${name}>`) ?? 'a <div> or a <p>');
      return;
    }
    const style = checkStyle(node, report);
    checkAttributes(node, tag, report);
    PLACEMENT[tag]?.(node, slide, style);
    const pinned = node.childElements.filter((child) => /position\s*:\s*absolute/i.test(child.getAttributeValue('style') ?? '')).length;
    if (pinned > LIMITS.pinnedPerHost) report(node, `<${tag}>`, `pins ${pinned} children`, `at most ${LIMITS.pinnedPerHost}: split them across sibling hosts`);
    const depth = tag === 'div' ? divDepth + 1 : divDepth;
    if (tag === 'div' && depth === LIMITS.divDepth + 1) report(node, '<div>', `is nested ${depth} <div>s deep`, `${LIMITS.divDepth} at most: flatten the layout`);
    for (const child of node.childElements) visit(child, depth);
  };
  for (const section of sections) visit(section, 0);
  if (slide.count > LIMITS.elements) errors.push({ file, line: 1, column: 1, element: 'slide', message: `holds ${slide.count} elements`, nearest: `${LIMITS.elements} or fewer: split the slide` });
}

const parentOf = (node) => node.parent?.tagName;
const inside = (tags, nearest) => (node, { report }) => {
  if (!tags.includes(parentOf(node))) report(node, `<${node.tagName}>`, `is inside a <${parentOf(node)}>`, nearest);
};
const onlyItems = (node, { report }) => {
  if (node.childElements.some((child) => child.tagName !== 'li')) report(node, `<${node.tagName}>`, 'holds something other than <li>', 'plain <li> items');
};

/** Where each element may sit and what it may hold; `slide` counts its embeds. */
const PLACEMENT = {
  section: (node, { id, report }) => {
    if (node.parent !== null && !node.parent.isRootElement()) report(node, '<section>', 'is inside another element', 'a <div>: a slide is one <section>');
    else if (node.getAttributeValue('id') !== id) report(node, `<section id="${node.getAttributeValue('id') ?? ''}">`, `does not match the file name ${id}.html`, `<section id="${id}">`);
  },
  aside: (node, { report }) => {
    if (parentOf(node) !== 'section' || node.parent.childElements.at(-1) !== node) report(node, '<aside>', 'is not the last child of the section', "the section's last child: speaker notes");
    if (node.childElements.length > 0) report(node, '<aside>', 'holds elements', 'plain text: the speaker notes');
    if (node.textContent.length > LIMITS.notes) report(node, '<aside>', `holds ${node.textContent.length} characters`, `${LIMITS.notes} or fewer`);
  },
  'x-embed': (node, slide, style) => {
    const { report } = slide;
    slide.embeds++;
    if (parentOf(node) !== 'section') report(node, '<x-embed>', 'is not a direct child of the section', 'a direct child of the <section>, pinned');
    if (style.get('position') !== 'absolute' || !style.has('width') || !style.has('height')) report(node, '<x-embed>', 'is not pinned with a width and a height', 'style="position:absolute; left; top; width; height"');
    if (slide.embeds === LIMITS.embeds + 1) report(node, '<x-embed>', `is one more than ${LIMITS.embeds} on a slide`, 'a chart as an inline <svg>');
  },
  li: inside(['ul', 'ol'], 'a <ul> or an <ol>'),
  ul: onlyItems,
  ol: onlyItems,
  tr: inside(['table'], 'a <table>'),
  th: inside(['tr'], 'a <tr>'),
  td: inside(['tr'], 'a <tr>'),
  table: (node, { report }) => {
    const rows = node.childElements.filter((child) => child.tagName === 'tr');
    const columns = Math.max(0, ...rows.map((row) => row.childElements.length));
    if (rows.length > LIMITS.rows || columns > LIMITS.columns) report(node, '<table>', `is ${rows.length} rows by ${columns} columns`, `at most ${LIMITS.rows} rows by ${LIMITS.columns} columns: split it across slides`);
  },
};

function checkAttributes(node, tag, report) {
  for (const attribute of node.attributes) {
    const name = attribute.key;
    const value = typeof attribute.value === 'string' ? attribute.value : '';
    if (/^on/.test(name)) {
      report(node, `<${tag} ${name}>`, 'runs a script', 'a pinned <x-embed> holding the small live page', attribute.keyLocation);
      continue;
    }
    if (!['id', 'style', 'class'].includes(name) && !name.startsWith('data-') && !ELEMENTS[tag].includes(name)) {
      report(node, `<${tag} ${name}>`, 'is not in the slide format', 'leave it out', attribute.keyLocation);
      continue;
    }
    const problem = VALUES[`${tag} ${name}`]?.(value);
    if (problem) report(node, problem[0], problem[1], problem[2], attribute.keyLocation);
  }
}

/** Limited attribute values, by `<tag> <attribute>`: [element, message, nearest] when one is outside. */
const VALUES = {
  'img src': (value) => IMAGE_SOURCE.test(value) ? null : [`<img src="${value.slice(0, 40)}">`, 'is not an image held in the slide', 'the image itself as a data: URI, data:image/png;base64,…; or leave src out for an empty frame'],
  'a href': (value) => value.startsWith('https://') ? null : [`<a href="${value.slice(0, 40)}">`, 'is not an https link', 'href="https://…"'],
  'x-shape kind': (value) => SHAPE_KINDS.includes(value) ? null : [`<x-shape kind="${value}">`, 'is not a shape', nearestOf(value, SHAPE_KINDS, (kind) => `kind="${kind}"`) ?? SHAPE_KINDS.join(', ')],
  'x-icon name': (value) => ICON_NAMES.includes(value) ? null : [`<x-icon name="${value}">`, 'is not an icon', nearestOf(value, ICON_NAMES, (icon) => `name="${icon}"`) ?? ICON_NAMES.join(', ')],
};

/** Checks an element's inline style; returns its declarations, property to value, for the placement checks. */
function checkStyle(node, report) {
  const declared = new Map();
  const attribute = node.getAttribute('style');
  const tag = node.tagName;
  if (attribute === null || typeof attribute.value !== 'string') return declared;
  const start = attribute.valueLocation ?? attribute.keyLocation;
  const where = (loc) => loc === undefined || loc === null ? start : {
    line: start.line + loc.start.line - 1,
    column: loc.start.line === 1 ? start.column + loc.start.column - 1 : loc.start.column,
  };
  if (INLINE.includes(tag) && tag !== 'span' || ['li', 'aside', 'br'].includes(tag)) {
    report(node, `<${tag} style>`, `<${tag}> takes no style`, tag === 'li' ? 'style the <ul> or <ol>' : 'a <span style="color:…">, or a separate block', start);
    return declared;
  }
  const list = parseCss(attribute.value, {
    context: 'declarationList', positions: true,
    onParseError: (error) => report(node, `<${tag} style>`, `does not parse (${error.message})`, 'property:value; pairs', start),
  });
  const groups = groupsOf(node, /position\s*:\s*absolute/i.test(attribute.value));
  list.children.forEach((declaration) => {
    if (declaration.type !== 'Declaration') return;
    const property = declaration.property.toLowerCase();
    const value = generate(declaration.value);
    declared.set(property, value);
    const element = `<${tag}> ${property}: ${value}`;
    const at = where(declaration.loc);
    const row = ROWS.get(property);
    if (row === undefined) {
      const base = property.replace(/-(top|right|bottom|left|inline|block|start|end|x|y)$/, '');
      report(node, element, `${property} is not in the slide format`, NEAREST_PROPERTY[property] ?? NEAREST_PROPERTY[base] ?? nearestOf(property, [...ROWS.keys()], (name) => name) ?? 'leave it out', at);
      return;
    }
    if (!row.on.some((group) => groups.has(group))) {
      report(node, element, `${property} does not apply to <${tag}>`, `${property} on ${row.on.map((group) => group === 'pinned' ? 'a pinned element (position:absolute)' : group).join(', ')}`, at);
      return;
    }
    const problem = valueProblem(property, row, declaration.value);
    if (problem !== null) report(node, element, problem.message, problem.nearest, at);
  });
  return declared;
}

/** Why a value is outside its row, or null when it is inside. */
function valueProblem(property, row, value) {
  let problem = null;
  walk(value, (node) => {
    problem ??= nodeProblem(property, row, node);
  });
  if (problem !== null) return problem;
  const match = lexer.matchProperty(property, value);
  if (match.error) return { message: 'is outside the slide format', nearest: `${property}: ${row.values}` };
  for (const node of value.children) {
    const found = numberProblem(property, row, node);
    if (found !== null) return found;
  }
  return null;
}

/** Why one node of a value is outside the format before its grammar is matched, or null. */
function nodeProblem(property, row, node) {
  const name = node.name?.toLowerCase();
  if (node.type === 'Function' && name === 'var') return { message: 'var() is not in the slide format', nearest: `${property}: the value itself, ${row.values}` };
  if (node.type === 'Function' && name === 'url') return { message: 'url() loads a file', nearest: `${property}: ${row.values}` };
  if (node.type === 'Identifier' && name === 'currentcolor' && property !== '-webkit-text-fill-color') return { message: 'currentcolor is not in the slide format', nearest: `${property}: a hex color` };
  const unit = node.type === 'Dimension' ? node.unit.toLowerCase() : null;
  if (unit === null || UNITS.has(unit) || (row.units ?? []).includes(unit)) return null;
  const px = { em: 32, rem: 32, pt: 4 / 3 }[unit];
  return { message: `${node.unit} is not a unit of the slide format`, nearest: `${property}: a px length${px ? `, such as ${Math.round(Number(node.value) * px)}px` : ''}` };
}

/** Why a number in a matched value is outside its row's range or weights, or null. */
function numberProblem(property, row, node) {
  const unit = node.type === 'Dimension' ? node.unit.toLowerCase() : null;
  if ((node.type !== 'Number' && unit === null) || unit === 'em') return null;
  const number = Number(node.value) * (unit === 'pt' ? 4 / 3 : 1);
  if (row.range && (number < row.range[0] || number > row.range[1])) return { message: `${generate(node)} is out of range`, nearest: `${property}: ${row.values}` };
  if (row.weight && (number < 100 || number > 900 || number % 100 !== 0)) return { message: `${number} is not a whole hundred from 100 to 900`, nearest: `font-weight: ${Math.min(900, Math.max(100, Math.round(number / 100) * 100))}` };
  return null;
}

/** The groups the table's `on` column names that an element belongs to. */
function groupsOf(node, pinned) {
  const tag = node.tagName;
  const parent = node.parent?.tagName;
  const groups = new Set(['any', tag]);
  if (TEXT.includes(tag)) groups.add('text');
  if (tag === 'section' || tag === 'div') ['text', 'flex box', 'grid box'].forEach((group) => groups.add(group));
  if (pinned) groups.add('pinned');
  if (parent === 'div' || parent === 'section') groups.add('div child');
  return groups;
}

/** The allowed name closest to `name`, by edit distance, when one is close enough to be what was meant. */
function nearestOf(name, names, form) {
  let best = null;
  let distance = Math.max(2, Math.floor(name.length / 3)) + 1;
  for (const candidate of names) {
    const d = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (d < distance) [best, distance] = [candidate, d];
  }
  return best === null ? null : form(best);
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
