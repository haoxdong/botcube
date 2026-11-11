// The Slides format's closed subset (the Artifacts spec, Sources/Slides): the elements, attributes and inline CSS a slide may
// hold, and its limits. One allowlist configures the checker (slides.mjs), the Viewer's sanitizer (the web app's
// DOMPurify) and the skill page's rules table (`artifact-check rules`). Plain data, so the browser can import it.

/** What `text` means in the table: the text blocks. Their rows also apply to a section or div, whose text inherits. */
export const TEXT = ['h1', 'h2', 'h3', 'p', 'ul', 'ol'];

/** Shared grammars, css-tree syntax. Lengths are px (bare numbers too); `units` allows pt or em where a row says. */
const LEN = '<length> | <number>';
const COLOR = '<color>';
const ALIGN = 'start | center | end | stretch | baseline | flex-start | flex-end';
const BORDER = `[ <length> | <number> ]? [ solid | dashed | dotted | double | none ] <color>?`;
const TRACK = `[ ${LEN} | <flex> | auto ]`;
const GRADIENT = '<linear-gradient()> | <repeating-linear-gradient()> | <radial-gradient()>';

/**
 * One row per property: `values` as the agent reads them, `syntax` as css-tree matches them, `on` the elements that
 * take it (`any`, `pinned` = position:absolute, `div child` = a flow child of a div or the section, `flex box` and
 * `grid box` = a section or div), `range` the bounds of its numbers in px, `units` the non-px units it takes.
 */
export const PROPERTIES = [
  { names: ['position'], values: 'absolute | relative', syntax: 'absolute | relative', on: ['any'], note: 'absolute pins to the slide or a position:relative div' },
  { names: ['left', 'top'], values: 'LEN | PCT | auto | calc(PCT ± LEN)', syntax: `${LEN} | <percentage> | auto | <length-percentage>`, on: ['pinned'] },
  { names: ['right', 'bottom'], values: 'LEN | PCT | auto', syntax: `${LEN} | <percentage> | auto`, on: ['pinned'] },
  { names: ['width', 'height'], values: 'LEN | auto | PCT', syntax: `${LEN} | auto | <percentage>`, on: ['any'] },
  { names: ['min-width'], values: 'LEN | min-content | max-content', syntax: `${LEN} | min-content | max-content`, on: ['div child'] },
  { names: ['min-height', 'max-width', 'max-height'], values: 'LEN', syntax: LEN, on: ['div child'] },
  { names: ['display'], values: 'flex | grid | none (no display = column)', syntax: 'flex | grid | none', on: ['section', 'div'] },
  { names: ['flex-direction'], values: 'row | column [-reverse]', syntax: 'row | row-reverse | column | column-reverse', on: ['flex box'] },
  { names: ['flex-wrap'], values: 'wrap | nowrap', syntax: 'wrap | nowrap', on: ['div'] },
  { names: ['gap'], values: 'LEN [LEN] 0–512', syntax: `[ ${LEN} ]{1,2}`, on: ['section', 'div'], range: [0, 512] },
  { names: ['align-items'], values: 'start | center | end | stretch | baseline (flex-* forms ok)', syntax: ALIGN, on: ['section', 'div'] },
  { names: ['justify-content'], values: 'start | center | end | space-between | space-around | space-evenly', syntax: 'start | center | end | flex-start | flex-end | space-between | space-around | space-evenly', on: ['flex box'] },
  { names: ['justify-items'], values: 'start | center | end | stretch', syntax: 'start | center | end | stretch', on: ['grid box'] },
  { names: ['align-self'], values: 'start | center | end | stretch | baseline | auto', syntax: `${ALIGN} | auto`, on: ['div child'] },
  { names: ['justify-self'], values: 'start | center | end | stretch | auto', syntax: 'start | center | end | stretch | auto', on: ['div child'] },
  { names: ['flex'], values: 'none | auto | N [N] [LEN | 0% | auto]', syntax: `none | auto | <number> <number>? [ <length> | <percentage> | auto ]?`, on: ['div child'] },
  { names: ['flex-grow', 'flex-shrink'], values: 'N', syntax: '<number>', on: ['div child'] },
  { names: ['flex-basis'], values: 'LEN | auto', syntax: `${LEN} | auto`, on: ['div child'] },
  { names: ['grid-template-columns', 'grid-template-rows'], values: '(LEN | Nfr | auto | repeat(INT, …))+, ≤24 tracks', syntax: `[ ${TRACK} | repeat( <integer> , ${TRACK}+ ) ]+`, on: ['grid box'] },
  { names: ['grid-column', 'grid-row'], values: 'span INT', syntax: 'span <integer>', on: ['div child'] },
  { names: ['aspect-ratio'], values: 'N | N / N', syntax: '<ratio>', on: ['div child'] },
  { names: ['padding'], values: 'LEN 0–256 ×1–4', syntax: `[ ${LEN} ]{1,4}`, on: ['section', 'div', 'text', 'table', 'td', 'th'], range: [0, 256] },
  { names: ['overflow'], values: 'hidden | visible', syntax: 'hidden | visible', on: ['div'] },
  { names: ['font-family'], values: "'Declared Face', Basic, generic", syntax: '[ <family-name> | <generic-family> ]#', on: ['text', 'table'] },
  { names: ['font-size'], values: 'LEN 8–400 (Npt converts)', syntax: LEN, on: ['text', 'table'], range: [8, 400], units: ['pt'] },
  { names: ['font-weight'], values: '100–900 (whole hundreds) | normal | bold', syntax: 'normal | bold | <number>', on: ['text', 'th', 'span'], weight: true },
  { names: ['font-style'], values: 'normal | italic', syntax: 'normal | italic', on: ['text', 'span'] },
  { names: ['font'], values: '[italic] [weight] LEN[/N] FAMILY', syntax: '[ italic || bold || <number> ]? <length> [ / <number> ]? [ <family-name> | <generic-family> ]#', on: ['text'], units: ['pt'] },
  { names: ['line-height'], values: 'N | PCT | LEN', syntax: `${LEN} | <percentage>`, on: ['text'] },
  { names: ['letter-spacing'], values: 'LEN | Nem (−24–32px) | normal', syntax: `${LEN} | normal`, on: ['text'], range: [-24, 32], units: ['em'] },
  { names: ['text-align'], values: 'left | center | right | justify', syntax: 'left | center | right | justify', on: ['text', 'td', 'th'] },
  { names: ['text-transform'], values: 'none | uppercase | lowercase | capitalize', syntax: 'none | uppercase | lowercase | capitalize', on: ['text'] },
  { names: ['white-space'], values: 'normal | nowrap', syntax: 'normal | nowrap', on: ['text'] },
  { names: ['text-decoration'], values: 'none | underline | line-through [solid | double | dotted | dashed | wavy] [COLOR]', syntax: `none | [ underline | line-through ] [ solid | double | dotted | dashed | wavy ]? <color>?`, on: ['text', 'span'] },
  { names: ['font-variant-numeric'], values: 'normal | tabular-nums', syntax: 'normal | tabular-nums', on: ['text'] },
  { names: ['-webkit-text-stroke'], values: 'LEN 0–8 COLOR', syntax: `[ <length> | <number> ] <color>`, on: ['text'], range: [0, 8] },
  { names: ['-webkit-text-fill-color'], values: 'transparent | currentcolor', syntax: 'transparent | currentcolor', on: ['text', 'span'] },
  { names: ['color'], values: 'COLOR', syntax: COLOR, on: ['text', 'table', 'span', 'td', 'th', 'x-icon', 'x-connector', 'hr'] },
  { names: ['background'], values: 'COLOR | one gradient[, COLOR under it]', syntax: `${COLOR} | [ ${GRADIENT} ] [ , <color> ]?`, on: ['section', 'div', 'text', 'img', 'table', 'x-icon', 'tr', 'x-shape', 'hr'] },
  { names: ['background-clip'], values: 'text', syntax: 'text', on: ['text'] },
  { names: ['border'], values: '[LEN 0–16] solid | dashed | dotted | double | none [COLOR]', syntax: BORDER, on: ['div', 'text', 'img', 'table', 'x-icon', 'x-shape', 'hr', 'x-connector'], range: [0, 32] },
  { names: ['border-top', 'border-right', 'border-bottom', 'border-left'], values: 'as border | none', syntax: `${BORDER} | none`, on: ['div', 'text', 'img', 'table', 'x-icon'], range: [0, 16] },
  { names: ['border-width'], values: 'LEN ≤32', syntax: LEN, on: ['x-connector'], range: [0, 32] },
  { names: ['border-style'], values: 'solid | dashed | dotted', syntax: 'solid | dashed | dotted', on: ['x-connector'] },
  { names: ['border-radius'], values: 'LEN | PCT ×1–4', syntax: `[ ${LEN} | <percentage> ]{1,4}`, on: ['div', 'text', 'img', 'table', 'x-shape'] },
  { names: ['box-shadow'], values: '[inset] LEN LEN [LEN [LEN]] COLOR, … ≤8', syntax: `[ inset? [ ${LEN} ]{2,4} <color> ]#`, on: ['div', 'text', 'img', 'table', 'x-icon', 'x-shape'] },
  { names: ['text-shadow'], values: 'LEN LEN [LEN] COLOR, … ≤8', syntax: `[ [ ${LEN} ]{2,3} <color> ]#`, on: ['text', 'table'] },
  { names: ['opacity'], values: 'N 0–1', syntax: '<number>', on: ['any'], range: [0, 1] },
  { names: ['transform'], values: 'translate(LEN[, LEN]) | translateX|Y(LEN | -50%), rotate(ANGLE), scale(N 0.5–2), skew[X|Y](ANGLE)', syntax: '[ translate( <length-percentage> , <length-percentage>? ) | translateX( <length-percentage> ) | translateY( <length-percentage> ) | rotate( <angle> ) | scale( <number> ) | skew( <angle> , <angle>? ) | skewX( <angle> ) | skewY( <angle> ) ]+', on: ['any'] },
  { names: ['filter', 'backdrop-filter'], values: 'blur(LEN ≤20) brightness|contrast(N) saturate(N) grayscale|sepia|invert(N) hue-rotate(ANGLE)', syntax: '[ blur( <length> ) | brightness( <number> ) | contrast( <number> ) | saturate( <number> ) | grayscale( <number> ) | sepia( <number> ) | invert( <number> ) | hue-rotate( <angle> ) ]+', on: ['div', 'text', 'img', 'x-shape'] },
  { names: ['mix-blend-mode'], values: 'normal | multiply | screen | overlay | darken | lighten', syntax: 'normal | multiply | screen | overlay | darken | lighten', on: ['div', 'text', 'img', 'x-shape'] },
  { names: ['object-fit'], values: 'cover | contain', syntax: 'cover | contain', on: ['img'] },
  { names: ['margin'], values: '0 (a no-op)', syntax: '0', on: ['any'] },
  { names: ['box-sizing'], values: 'border-box (a no-op)', syntax: 'border-box', on: ['any'] },
  { names: ['grid-template'], values: 'none (a no-op)', syntax: 'none', on: ['any'] },
];

/** The elements a slide holds, with the attributes each takes beyond `style`, `id`, `class` and `data-*`. */
export const ELEMENTS = {
  section: ['hidden'], h1: [], h2: [], h3: [], p: [], ul: [], ol: [], li: [], br: [], b: [], i: [], u: [], a: ['href'],
  span: [], div: [], img: ['src', 'alt'], table: [], tr: [], th: [], td: [], hr: [], aside: [],
  svg: ['aria-label', 'width', 'height', 'viewbox', 'xmlns', 'fill', 'stroke', 'preserveaspectratio'],
  'x-shape': ['kind'], 'x-icon': ['name'],
  'x-connector': ['x1', 'y1', 'x2', 'y2', 'head', 'head-start', 'head-end', 'route', 'from'],
  'x-embed': [],
};

/**
 * What an inline `<svg>` chart may hold: its drawing elements and their presentation attributes (lowercase, as a
 * parser reports them), beyond `id`, `class` and `data-*`. No href and no style: a chart points nowhere and is styled
 * by its attributes. The checker refuses anything else in an svg; the Viewer's sanitizer keeps only these.
 */
export const SVG_ELEMENTS = [
  'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'marker', 'lineargradient',
  'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'text', 'tspan', 'title', 'desc',
];
export const SVG_ATTRIBUTES = [
  'viewbox', 'xmlns', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'points',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap',
  'stroke-linejoin', 'stroke-opacity', 'opacity', 'transform', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'gradienttransform', 'markerwidth', 'markerheight', 'refx', 'refy', 'orient', 'markerunits', 'marker-start',
  'marker-end', 'marker-mid', 'clip-path', 'mask', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline',
  'preserveaspectratio', 'overflow',
];

/** The nearest allowed form of something an svg chart has no place for. */
export const NEAREST_SVG = {
  image: 'an <img> pinned over the svg', use: 'the shape drawn again where it is used', symbol: '<g>',
  animate: 'a still drawing; data-build-in on a pinned child brings it in', animatetransform: 'a still drawing; data-build-in on a pinned child brings it in',
  animatemotion: 'a still drawing; data-build-in on a pinned child brings it in', set: 'a still drawing; data-build-in on a pinned child brings it in',
  foreignobject: 'a <p> pinned over the svg', script: 'a pinned <x-embed> holding the small live page', a: 'a plain shape: a chart holds no links',
  style: 'presentation attributes, such as fill and stroke, on each shape', filter: "filter in the <svg>'s own style",
  href: 'url(#id) of a gradient or marker in the svg', 'xlink:href': 'url(#id) of a gradient or marker in the svg',
};

/** Inline elements: they take no style but a span's colour, weight and style. */
export const INLINE = ['b', 'i', 'u', 'a', 'span', 'br'];

export const SHAPE_KINDS = ['rect', 'rounded', 'ellipse', 'diamond', 'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'line'];
export const ICON_NAMES = [
  'Activity', 'Book', 'Chart', 'Chat', 'Check', 'CheckCircle', 'Clock', 'Cloud', 'Code', 'Database', 'Globe',
  'GraduationCap', 'Home', 'Key', 'Lightbulb', 'Lightning', 'Link', 'Lock', 'PaperPlane', 'Play', 'Search', 'Settings',
  'Star', 'ThumbsUp', 'Tool', 'Trust', 'Users', 'Verified', 'Warning', 'Wrench',
];

export const LIMITS = {
  elements: 200, divDepth: 15, pinnedPerHost: 24, embeds: 8, embedBytes: 16 * 1024, svgBytes: 52 * 1024,
  notes: 4000, rows: 100, columns: 24, cells: 4000, slides: 500, faces: 4, text: 20000,
};

/** A slide id, which is also its file's name. */
export const SLIDE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Where an `<img src>` may point: the image itself, as a data: URI. A slide frame loads nothing, and there is no asset
 * store to serve an uploaded file or a design system's file from yet.
 */
export const IMAGE_SOURCE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/;

/** The nearest allowed form of an element the format has no place for. */
export const NEAREST_ELEMENT = {
  h4: '<h3>', h5: '<h3>', h6: '<h3>', strong: '<b>', em: '<i>', mark: '<span style="color:…">', small: '<p> with its own font-size (24px or more)',
  blockquote: '<p>', pre: '<p style="font-family:monospace">', code: '<span> in a <p style="font-family:monospace">',
  header: '<div>', footer: '<div>', main: '<div>', article: '<div>', nav: '<div>', figure: '<div>', figcaption: '<p>',
  label: '<p>', thead: '<tr> rows straight in the <table>', tbody: '<tr> rows straight in the <table>', caption: '<p> above the table',
  script: 'a pinned <x-embed> holding the small live page', iframe: 'a pinned <x-embed>', canvas: 'an inline <svg>, or a pinned <x-embed>',
  style: 'inline style="" on each element', link: "a face in deck.json's faces", video: '<img> with data-video', picture: '<img>',
  button: '<p> styled as a pill (background, padding, border-radius)', input: 'nothing: a slide holds no controls', form: 'nothing: a slide holds no controls',
};

/** The nearest allowed form of a property the format has no place for. */
export const NEAREST_PROPERTY = {
  margin: "gap on the parent, or the parent's padding",
  'z-index': 'source order: later children paint over earlier ones, so list a backdrop first',
  float: 'a flex row <div>',
  inset: 'left, top, right and bottom',
  'row-gap': 'gap: ROW COLUMN', 'column-gap': 'gap: ROW COLUMN',
  'background-color': 'background: COLOR', 'background-image': 'background: one gradient (no url())',
  'list-style': 'plain <li> in a <ul> or <ol>', 'list-style-type': 'a <ul> or an <ol>',
  'vertical-align': 'align-items on a flex row', 'text-indent': 'padding',
  'font-variant': 'font-variant-numeric', 'word-spacing': 'letter-spacing',
  outline: 'border', 'border-color': 'border: WIDTH STYLE COLOR', 'border-spacing': 'gap',
  transition: "data-transition on the section, or data-build-in on a pinned child", animation: 'data-build-in on a pinned child',
};

/** The rules table the skill page carries, generated from the rows above. */
export function rulesTable() {
  const rows = PROPERTIES.map(({ names, values, on }) => `| \`${names.join('`, `')}\` | ${values.replaceAll('|', '\\|')} | ${on.join(', ')} |`);
  return [
    '| Property | Values | On |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'LEN = Npx or a bare N (px); PCT = N%; COLOR = #hex, rgb[a](), hsl[a](), a named color or transparent (no currentcolor, no var()); ANGLE = Ndeg, Nturn or Nrad. `text` = h1, h2, h3, p, ul, ol; a text row set on a section or div inherits down. `pinned` = position:absolute. `div child` = a flow child of a div or the section.',
    '',
    `Elements: ${Object.keys(ELEMENTS).map((name) => `\`<${name}>\``).join(' ')}. \`<x-shape kind>\`: ${SHAPE_KINDS.join(', ')}. \`<x-icon name>\`: ${ICON_NAMES.join(', ')}.`,
    '',
    `Inside an \`<svg>\`: ${SVG_ELEMENTS.map((name) => `\`<${name}>\``).join(' ')}, with ${SVG_ATTRIBUTES.map((name) => `\`${name}\``).join(' ')} (and id, class, data-*). No href, style or url() but url(#id).`,
    '',
    `Limits: ${LIMITS.elements} elements a slide, ${LIMITS.divDepth} nested \`<div>\`s, ${LIMITS.pinnedPerHost} pinned children a host, ${LIMITS.embeds} \`<x-embed>\`s a slide of ${LIMITS.embedBytes / 1024} KB each, \`<svg>\` ${LIMITS.svgBytes / 1024} KB each, speaker notes ${LIMITS.notes} characters, tables ${LIMITS.rows} rows by ${LIMITS.columns} columns, ${LIMITS.faces} faces, ${LIMITS.slides} slides.`,
    '',
  ].join('\n');
}
