import JSZip from 'jszip';

/**
 * Where a PowerPoint's shapes sit against the slides a browser renders: a story's check that the export draws each
 * element where the Viewer shows it. A box is in slide pixels (1920×1080) about its centre, with its rotation, so a
 * turned element compares by its own size rather than the rectangle that bounds its corners.
 */
type Box = { cx: number; cy: number; w: number; h: number; turn: number };
type Shape = { kind: 'text' | 'fill' | 'table'; key: string; frame: Box };

/** A slide pixel in EMU: 914400 an inch, 144 pixels an inch. */
const EMU = 6350;
/** How far a shape may sit from its element, in pixels or degrees. */
const TOLERANCE = 1;
/** The export widens a text box by 4 px: a browser wraps a line a hair later than PowerPoint does. */
const TEXT_WIDENING = 4;

/** Each slide's XML in a PowerPoint, in order. */
export async function slideXml(blob: Blob): Promise<string[]> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const count = zip.file(/^ppt\/slides\/slide\d+\.xml$/).length;
  return Promise.all(Array.from({ length: count }, (_, index) => {
    const file = zip.file(`ppt/slides/slide${index + 1}.xml`);
    if (file === null) throw new Error(`The PowerPoint has no slide ${index + 1}`);
    return file.async('string');
  }));
}

/** Every way a slide's shapes and its rendered section differ; none when each shape sits on its element. */
export function geometryMismatches(xml: string, section: Element): string[] {
  const exported = shapesIn(xml);
  const rendered = renderedIn(section);
  const unmatched = exported.filter((shape) => !rendered.some((element) => same(shape, element)))
    .map((shape) => `exported ${describe(shape)} sits on no rendered element`);
  const missing = rendered.filter((element) => !exported.some((shape) => same(shape, element)))
    .map((element) => `rendered ${describe(element)} has no exported shape`);
  const pictures = xml.includes('<p:pic>') ? ['the slide holds a picture'] : [];
  return [...unmatched, ...missing, ...pictures].map((problem) => `slide ${section.id}: ${problem}`);
}

const describe = ({ kind, key, frame: box }: Shape) =>
  `${kind} "${key}" at ${[box.cx - box.w / 2, box.cy - box.h / 2, box.w, box.h].map((value) => value.toFixed(1)).join(', ')}${box.turn ? ` turned ${box.turn.toFixed(1)}°` : ''}`;

/** Whether a shape sits on an element: a text box grows 4 px to its right, along the element's turned width. */
function same(shape: Shape, element: Shape) {
  if (shape.kind !== element.kind || shape.key !== element.key) return false;
  const grow = shape.kind === 'text' ? TEXT_WIDENING : 0;
  const radians = (element.frame.turn * Math.PI) / 180;
  const expected: Box = {
    cx: element.frame.cx + (grow / 2) * Math.cos(radians), cy: element.frame.cy + (grow / 2) * Math.sin(radians),
    w: element.frame.w + grow, h: element.frame.h, turn: element.frame.turn,
  };
  return (['cx', 'cy', 'w', 'h', 'turn'] as const).every((key) => Math.abs(shape.frame[key] - expected[key]) <= TOLERANCE);
}

const textKey = (text: string) => text.replace(/\s+/g, '').toLowerCase();

/** The slide's shapes as PowerPoint reads them: text boxes, filled shapes and tables, by their frames. */
function shapesIn(xml: string): Shape[] {
  const slide = new DOMParser().parseFromString(xml, 'application/xml');
  const shapes = Array.from(slide.getElementsByTagName('p:sp')).flatMap((shape): Shape[] => {
    const frame = shape.getElementsByTagName('a:xfrm')[0];
    const properties = shape.getElementsByTagName('p:spPr')[0];
    const text = Array.from(shape.getElementsByTagName('a:t')).map((run) => run.textContent).join('');
    const fill = Array.from(properties?.children ?? []).find((child) => child.tagName === 'a:solidFill')?.firstElementChild?.getAttribute('val');
    if (frame === undefined) return [];
    if (text !== '') return [{ kind: 'text', key: textKey(text), frame: boxOf(frame) }];
    return fill ? [{ kind: 'fill', key: fill, frame: boxOf(frame) }] : [];
  });
  const tables = Array.from(slide.getElementsByTagName('p:graphicFrame')).flatMap((table): Shape[] => {
    const frame = table.getElementsByTagName('p:xfrm')[0];
    return frame === undefined ? [] : [{ kind: 'table', key: 'table', frame: boxOf(frame) }];
  });
  return [...shapes, ...tables];
}

function boxOf(frame: Element): Box {
  const at = (name: string, attribute: string) => Number(frame.getElementsByTagName(name)[0]?.getAttribute(attribute) ?? 0) / EMU;
  const w = at('a:ext', 'cx');
  const h = at('a:ext', 'cy');
  return { cx: at('a:off', 'x') + w / 2, cy: at('a:off', 'y') + h / 2, w, h, turn: Number(frame.getAttribute('rot') ?? 0) / 60000 };
}

const TEXT = new Set(['H1', 'H2', 'H3', 'P', 'UL', 'OL']);

/**
 * The section's elements as the browser draws them: each text block, each table, each painted box and each solid
 * border side. Cells belong to their table.
 */
function renderedIn(section: Element): Shape[] {
  const window = section.ownerDocument.defaultView;
  if (window === null) throw new Error('The slide has no window');
  const origin = section.getBoundingClientRect();
  return Array.from(section.querySelectorAll('*')).flatMap((element): Shape[] => {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || element.closest('table') !== null && element.tagName !== 'TABLE') return [];
    const box = ownBox(element, origin, window);
    if (TEXT.has(element.tagName)) return [{ kind: 'text', key: textKey(element.textContent), frame: box }, ...painted(style, box, element)];
    if (element.tagName === 'TABLE') return [{ kind: 'table', key: 'table', frame: box }];
    return painted(style, box, element);
  });
}

/** An element's own box about its centre, which a rotation keeps, turned as it and its ancestors turn it. */
function ownBox(element: Element, origin: DOMRect, window: Window): Box {
  const rect = element.getBoundingClientRect();
  // The slide's own frame has its own HTMLElement, which the DOM types leave off Window.
  const sized = element instanceof (window as Window & typeof globalThis).HTMLElement ? element : null;
  const turned = turnOf(element, window);
  return {
    cx: rect.left - origin.left + rect.width / 2, cy: rect.top - origin.top + rect.height / 2,
    w: turned && sized ? sized.offsetWidth : rect.width, h: turned && sized ? sized.offsetHeight : rect.height, turn: turned,
  };
}

function turnOf(element: Element, window: Window): number {
  let turn = 0;
  for (let at: Element | null = element; at !== null && at.tagName !== 'SECTION'; at = at.parentElement) {
    const matrix = /^matrix\(([^)]*)\)$/.exec(window.getComputedStyle(at).transform)?.[1]?.split(',').map(Number);
    if (matrix !== undefined) turn += (Math.atan2(matrix[1] ?? 0, matrix[0] ?? 1) * 180) / Math.PI;
  }
  return turn;
}

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;

/** A box's background, and each solid side of a border that differs by side, by their colours. */
function painted(style: CSSStyleDeclaration, box: Box, element: Element): Shape[] {
  const fill = hex(style.backgroundColor);
  const background: Shape[] = fill ? [{ kind: 'fill', key: fill, frame: box }] : [];
  const widths = SIDES.map((side) => parseFloat(style[`border${side}Width`]) || 0);
  if (widths.every((width) => width === widths[0])) return background;
  const { width: w, height: h } = element.getBoundingClientRect();
  const [left, top] = [box.cx - w / 2, box.cy - h / 2];
  const sides = SIDES.flatMap((side, index): Shape[] => {
    const width = widths[index] ?? 0;
    const color = hex(style[`border${side}Color`]);
    if (width === 0 || color === null || style[`border${side}Style`] !== 'solid') return [];
    const edge = {
      Top: { x: left, y: top, w, h: width }, Bottom: { x: left, y: top + h - width, w, h: width },
      Left: { x: left, y: top, w: width, h }, Right: { x: left + w - width, y: top, w: width, h },
    }[side];
    return [{ kind: 'fill', key: color, frame: { cx: edge.x + edge.w / 2, cy: edge.y + edge.h / 2, w: edge.w, h: edge.h, turn: 0 } }];
  });
  return [...background, ...sides];
}

function hex(css: string): string | null {
  const [r = 0, g = 0, b = 0, a = 1] = /rgba?\(([^)]+)\)/.exec(css)?.[1]?.split(/[,\s/]+/).filter(Boolean).map(Number) ?? [];
  return a === 0 || !/rgba?\(/.test(css) ? null : [r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('').toUpperCase();
}
