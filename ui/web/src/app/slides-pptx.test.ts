// The slides are laid out in a frame and sanitized by DOMPurify, which needs a DOM that walks a tree as browsers do.
// @vitest-environment jsdom
import JSZip from 'jszip';
import { expect, it } from 'vitest';

import { FIDELITY_DECK } from '../../test/fixtures/fidelity-deck';
import { color } from './slide-styles';
import { deckPptx } from './slides-pptx';

/** The PowerPoint as PowerPoint reads it: each slide's XML and its notes, in order. */
async function open(blob: Blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const text = (path: string) => zip.file(path)?.async('string') ?? Promise.resolve('');
  const count = Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path)).length;
  const slides = await Promise.all(Array.from({ length: count }, async (_, index) => ({
    xml: await text(`ppt/slides/slide${index + 1}.xml`),
    notes: await text(`ppt/notesSlides/notesSlide${index + 1}.xml`),
  })));
  return { slides, presentation: await text('ppt/presentation.xml'), core: await text('docProps/core.xml') };
}

const words = (xml: string) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(([, text]) => text).join(' ');
const all = (xml: string, pattern: RegExp) => [...xml.matchAll(new RegExp(pattern, 'g'))].length;

it('writes the fidelity deck as editable text, shapes, a table and a list, with no pictures of slides', async () => {
  const { slides, presentation, core } = await open(await deckPptx('Q3 Operating Review', '/decks/q3', FIDELITY_DECK));

  expect(slides).toHaveLength(5);
  expect(presentation).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
  expect(core).toContain('<dc:title>Q3 Operating Review</dc:title>');
  for (const { xml } of slides) expect(xml).not.toContain('<p:pic>');
  const [cover = '', agenda = '', numbers = '', plan = '', priorities = ''] = slides.map(({ xml }) => xml);

  expect(words(cover)).toContain('OPERATING REVIEW');
  expect(words(cover)).toContain('Q3 2026');
  expect(words(agenda)).toContain('Platform migration');
  expect(words(numbers)).toContain('$48.2M');
  expect(plan).toContain('<a:tbl>');
  expect(all(plan, /<a:tr /)).toBe(6);
  expect(words(plan)).toContain('New customers');
  const items = [...priorities.matchAll(/<a:p>(?:(?!<\/a:p>).)*<\/a:p>/g)].map(([paragraph]) => paragraph).filter((paragraph) => paragraph.includes('<a:buAutoNum '));
  expect(items.map(words)).toEqual([
    'Win back retention.  Fix onboarding for mid-market accounts.',
    'Finish the migration.  Retire the last two legacy services.',
    'Hire ahead of plan.  Twelve engineers by January.',
  ]);
});

// The schema allows a paragraph one <a:pPr>, before its runs; PowerPoint offers to repair a file with more.
it('gives each paragraph its properties once, before its runs', async () => {
  const { slides } = await open(await deckPptx('Q3 Operating Review', '/decks/q3', FIDELITY_DECK));

  for (const { xml } of slides) {
    for (const [paragraph] of xml.matchAll(/<a:p>(?:(?!<\/a:p>).)*<\/a:p>/g)) expect(paragraph).not.toMatch(/<a:pPr[ >](?:(?!<\/a:p>).)*<a:r>(?:(?!<\/a:p>).)*<a:pPr[ >]/);
  }
});

it('carries each slide’s aside as its speaker notes, and only those', async () => {
  const { slides } = await open(await deckPptx('Q3 Operating Review', '/decks/q3', FIDELITY_DECK));

  const [cover, agenda, numbers] = slides;
  if (cover === undefined || agenda === undefined || numbers === undefined) throw new Error('The deck lost a slide');

  expect(words(cover.notes)).toContain('Open with the headline: growth held and margins widened.');
  expect(words(cover.xml)).not.toContain('Open with the headline');
  expect(words(numbers.notes)).toContain('Retention is the one number that moved the wrong way.');
  expect(words(agenda.notes)).not.toMatch(/\w{4}/);
});

/** A one-slide deck at `/decks/one`. */
const oneSlide = (html: string) => [
  { path: '/decks/one/project/deck.json', text: JSON.stringify({ title: 'One', order: ['only'] }), complete: true },
  { path: '/decks/one/project/slides/only.html', text: html, complete: true },
];

// jsdom's CSS drops a whole style attribute holding a flex, grid or radius property, so the fidelity deck's cards
// can't show here; these boxes use what it reads.
it('writes painted boxes, rules and shapes as native shapes, and bullets as bullets', async () => {
  const deck = oneSlide([
    '<section id="only" style="background:#0f172a">',
    '<div style="background:#1e293b;border-left:8px solid #38bdf8"><p>Card</p></div>',
    '<hr style="border-top:2px solid #94a3b8">',
    '<x-shape kind="ellipse" style="width:200px;height:200px;background:#4ade80"></x-shape>',
    '<ul><li>One</li><li>Two</li></ul>',
    '</section>',
  ].join(''));

  const { xml = '' } = (await open(await deckPptx('One', '/decks/one', deck))).slides[0] ?? {};

  expect(xml).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="0F172A"/>');
  expect(xml).toMatch(/prst="rect"><a:avLst><\/a:avLst><\/a:prstGeom><a:solidFill><a:srgbClr val="1E293B"\/>/);
  expect(xml).toMatch(/prst="rect"><a:avLst><\/a:avLst><\/a:prstGeom><a:solidFill><a:srgbClr val="38BDF8"\/>/);
  expect(xml).toMatch(/prst="line"[\s\S]*?<a:ln w="12700"><a:solidFill><a:srgbClr val="94A3B8"\/>/);
  expect(xml).toMatch(/prst="ellipse"><a:avLst><\/a:avLst><\/a:prstGeom><a:solidFill><a:srgbClr val="4ADE80"\/>/);
  expect(all(xml, /<a:buChar /)).toBe(2);
  expect(words(xml)).toBe('Card One Two');
  expect(xml).not.toContain('<p:pic>');
});

/** The one slide's XML, as PowerPoint reads it. */
const slideOf = async (html: string) => (await open(await deckPptx('One', '/decks/one', oneSlide(html)))).slides[0]?.xml ?? '';

// A browser computes a transform as a matrix(); jsdom keeps the declared value, so these declare the matrix. jsdom
// also drops a declaration that follows the background shorthand, so background comes last.
const ROTATE_30 = 'matrix(0.866025, 0.5, -0.5, 0.866025, 0, 0)';

it('writes shadows, opacity, rotation, strike-through and dashed borders as PowerPoint draws them', async () => {
  const xml = await slideOf([
    '<section id="only">',
    '<div style="box-shadow:0px 8px 16px rgba(0, 0, 0, 0.5);background:#1e293b"><p>Lifted</p></div>',
    '<p style="text-shadow:4px 0px 2px rgba(15, 23, 42, 1)">Shadowed</p>',
    '<div style="opacity:0.5;background:#38bdf8"><p style="color:#0f172a">Faded</p></div>',
    `<x-shape kind="rect" style="transform:${ROTATE_30};background:#4ade80"></x-shape>`,
    '<p style="text-decoration:line-through">Struck</p>',
    '<div style="border:2px dashed #94a3b8;background:#ffffff"><p>Dashed</p></div>',
    '<div style="border-left:4px dotted #f87171"><p>Dotted</p></div>',
    '</section>',
  ].join(''));

  expect(xml).toContain('blurRad="101600" dist="50800" dir="5400000"> <a:srgbClr val="000000"> <a:alpha val="50000"/>');
  expect(xml).toMatch(/blurRad="12700" dist="25400" dir="21540000"> <a:srgbClr val="0F172A"> <a:alpha val="100000"\/>(?:(?!<\/p:sp>).)*<a:t>Shadowed<\/a:t>/);
  expect(xml).toContain('<a:srgbClr val="38BDF8"><a:alpha val="50000"/></a:srgbClr>');
  expect(xml).toMatch(/<a:srgbClr val="0F172A"><a:alpha val="50000"\/><\/a:srgbClr>(?:(?!<\/a:r>).)*<a:t>Faded<\/a:t>/);
  expect(xml).toMatch(/<a:xfrm rot="1800000">(?:(?!<\/p:sp>).)*<a:srgbClr val="4ADE80"\/>/);
  expect(xml).toMatch(/strike="sngStrike"(?:(?!<\/a:r>).)*<a:t>Struck<\/a:t>/);
  expect(xml).toMatch(/<a:srgbClr val="FFFFFF"\/><\/a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="94A3B8"\/><\/a:solidFill><a:prstDash val="dash"\/>/);
  expect(xml).toMatch(/prst="line"(?:(?!<\/p:sp>).)*<a:ln w="25400"><a:solidFill><a:srgbClr val="F87171"\/><\/a:solidFill><a:prstDash val="sysDot"\/>/);
});

it('writes an <x-shape>’s text over its shape, and a hidden slide as hidden', async () => {
  const xml = await slideOf('<section id="only" hidden><x-shape kind="ellipse" style="background:#4ade80">Go</x-shape></section>');

  expect(xml).toMatch(/<p:sld [^>]*show="0"/);
  expect(xml).toMatch(/prst="ellipse"(?:(?!<\/p:sp>).)*<\/p:sp><p:sp>(?:(?!<\/p:sp>).)*<a:t>Go<\/a:t>/);
});

it.each([
  ['<p>Logo</p><img src="data:image/png;base64,iVBORw0KGgo=" alt="Logo">', '<img>'],
  ['<p>Logo <img src="data:image/png;base64,iVBORw0KGgo=" alt="Logo"></p>', '<img> inside <p>'],
  ['<ul><li>Logo <img src="data:image/png;base64,iVBORw0KGgo=" alt="Logo"></li></ul>', '<img> inside <li>'],
  ['<table><tr><td>Logo <img src="data:image/png;base64,iVBORw0KGgo=" alt="Logo"></td></tr></table>', '<img> inside <td>'],
  ['<x-shape kind="star"></x-shape>', '<x-shape kind="star">'],
  ['Loose words<p>Title</p>', 'text straight in a <section>'],
  ['<div style="filter:blur(4px)"></div>', 'filter'],
  ['<div style="backdrop-filter:blur(4px)"></div>', 'backdrop-filter'],
  ['<div style="mix-blend-mode:multiply"></div>', 'mix-blend-mode'],
  ['<div style="background:radial-gradient(circle, #ffffff, #000000)"></div>', 'radial-gradient'],
  ['<div style="background:repeating-linear-gradient(90deg, #ffffff, #000000 10%)"></div>', 'repeating-linear-gradient'],
  ['<div style="transform:matrix(2, 0, 0, 2, 0, 0)"></div>', 'transform: scale'],
  ['<div style="transform:matrix(1, 0, 0.5, 1, 0, 0)"></div>', 'transform: skew'],
  [`<table style="transform:${ROTATE_30}"><tr><td>1</td></tr></table>`, 'a rotated <table>'],
  ['<table style="opacity:0.5"><tr><td>1</td></tr></table>', 'opacity on a <table>'],
  ['<table style="text-shadow:2px 2px 2px rgba(0, 0, 0, 1)"><tr><td>1</td></tr></table>', 'text-shadow in a <table>'],
  ['<div style="box-shadow:2px 2px 4px rgba(0, 0, 0, 1), 4px 4px 8px rgba(0, 0, 0, 1);background:#ffffff"></div>', 'box-shadow with more than one shadow'],
  ['<div style="box-shadow:inset 2px 2px 4px rgba(0, 0, 0, 1);background:#ffffff"></div>', 'box-shadow: inset'],
  ['<div style="box-shadow:2px 2px 4px 2px rgba(0, 0, 0, 1);background:#ffffff"></div>', 'box-shadow spread'],
  ['<div style="box-shadow:2px 2px 4px rgba(0, 0, 0, 1)"></div>', 'box-shadow on a box with no background colour'],
  ['<div style="border:4px double #000000"></div>', 'a double border'],
  ['<p style="text-decoration:line-through wavy">Struck</p>', 'a wavy line-through'],
  ['<div style="background:oklch(0.7 0.1 200)"></div>', 'the colour oklch(0.7 0.1 200)'],
])('fails on %s, naming the slide and %s, rather than leave it out', async (body, what) => {
  await expect(slideOf(`<section id="only">${body}</section>`)).rejects.toThrow(`slide only: ${what} has no PowerPoint form yet`);
});

it.each([
  ['<section id="only" style="opacity:0.5"><p>Faded</p></section>', 'opacity on a <section>'],
  [`<section id="only" style="transform:${ROTATE_30}"><p>Turned</p></section>`, 'transform on a <section>'],
])('fails on %s, naming the slide and %s', async (html, what) => {
  await expect(slideOf(html)).rejects.toThrow(`slide only: ${what} has no PowerPoint form yet`);
});

it('writes only the slides deck.json lists, in its order', async () => {
  const deck = [
    ...oneSlide('<section id="only"><p>Listed</p></section>'),
    { path: '/decks/one/project/slides/draft.html', text: '<section id="draft"><p>Unlisted</p></section>', complete: true },
  ];

  const { slides } = await open(await deckPptx('One', '/decks/one', deck));

  expect(slides.map(({ xml }) => words(xml))).toEqual(['Listed']);
});

it.each([
  ['rgb(56, 189, 248)', { color: '38BDF8', transparency: 0 }],
  ['rgba(0, 0, 0, 0.15)', { color: '000000', transparency: 85 }],
  // What the browser computes for color-mix() and color(), such as the slide CSS's table rule.
  ['color(srgb 0 0 0 / 0.15)', { color: '000000', transparency: 85 }],
  ['color(srgb 1 0.5 0)', { color: 'FF8000', transparency: 0 }],
  ['rgba(0, 0, 0, 0)', null],
])('reads the computed colour %s', (css, expected) => {
  expect(color(css, 'only')).toEqual(expected);
});

// The slide format allows any CSS colour, and a browser computes oklch(), lab() or a display-p3 colour as written.
it.each(['oklch(0.7 0.1 200)', 'lab(50 20 30)', 'color(display-p3 1 0 0)'])('fails on the computed colour %s, which has no PowerPoint form', (css) => {
  expect(() => color(css, 'only')).toThrow(`slide only: the colour ${css} has no PowerPoint form yet`);
});

it('reads no colour from a border that draws nothing', async () => {
  const html = '<section id="only"><div style="border:0 solid oklch(0.7 0.1 200);background:#ffffff;width:100px;height:50px"></div><table><tr><td style="border:0 solid oklch(0.7 0.1 200)">1</td></tr></table></section>';

  await expect(slideOf(html)).resolves.toBeTypeOf('string');
});

it('draws no line for a rule with no colour', async () => {
  const xml = await slideOf('<section id="only"><hr style="border-top:2px solid transparent;color:transparent"></section>');

  expect(xml).not.toContain('prst="line"');
});
