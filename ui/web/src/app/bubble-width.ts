import { clearCache } from "@chenglou/pretext";
import { measureRichInlineStats, prepareRichInline, type RichInlineBox, type RichInlineItem, type RichInlineOptions } from "@chenglou/pretext/rich-inline";

import { zoomOf } from "@/lib/utils";

export const USER_MESSAGE_CLASS = "cpk:prose cpk:dark:prose-invert cpk:bg-muted cpk:relative cpk:max-w-[80%] cpk:rounded-[18px] cpk:px-4 cpk:py-1.5 cpk:data-[multiline]:py-3 cpk:inline-block cpk:whitespace-pre-wrap";

/** A run of inline content between two breaks its block forces (a `<br>`, a nested block), laid out as one paragraph. */
export type Paragraph = { items: (RichInlineItem | RichInlineBox)[]; options: RichInlineOptions };

/** A block: its horizontal edges (margin, border, padding) and the paragraphs and blocks in it, in order. */
export type Flow = { left: number; right: number; parts: (Paragraph | Flow)[] };

/**
 * How wide `flow` is laid out `width` wide, its own edges included, when it hugs its content: its widest line, each
 * nested block's edges added to that block's lines.
 */
export function huggedWidth(flow: Flow, width: number, widestLine: (paragraph: Paragraph, width: number) => number): number {
  const inner = width - flow.left - flow.right;
  const widths = flow.parts.map((part) => ("parts" in part ? huggedWidth(part, inner, widestLine) : widestLine(part, inner)));
  return flow.left + Math.max(0, ...widths) + flow.right;
}

/** Content a bubble's flow can't be read from, so the bubble keeps its CSS width. */
class Unmeasurable extends Error {}

/**
 * A computed length, which a browser always gives in px. A page without layout, as a DOM test's, computes none, and
 * its bubble keeps its CSS width.
 */
function px(style: CSSStyleDeclaration, property: string) {
  const value = style.getPropertyValue(property);
  if (value === "") throw new Unmeasurable(`${property} not computed`);
  const length = parseFloat(value);
  if (Number.isNaN(length)) throw new Error(`not a computed length: ${property}: ${JSON.stringify(value)}`);
  return length;
}

/** The font as Pretext takes it: canvas's shorthand, from the element's own computed style. */
const fontOf = (style: CSSStyleDeclaration) => `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

function optionsOf(style: CSSStyleDeclaration): RichInlineOptions {
  const { whiteSpace, wordBreak } = style;
  if (whiteSpace !== "normal" && whiteSpace !== "pre-wrap") throw new Unmeasurable(`white-space: ${whiteSpace}`);
  if (wordBreak !== "normal" && wordBreak !== "keep-all") throw new Unmeasurable(`word-break: ${wordBreak}`);
  return { whiteSpace, wordBreak };
}

/** A text node as an item in its parent's font; a `nowrap` parent's text never breaks, as Pretext's atomic item. */
function textItem(text: Text, options: RichInlineOptions): RichInlineItem {
  const parent = text.parentElement;
  if (parent === null) throw new Unmeasurable("text outside an element");
  const style = getComputedStyle(parent);
  if (style.whiteSpace !== options.whiteSpace && style.whiteSpace !== "nowrap") throw new Unmeasurable(`white-space: ${style.whiteSpace} inside ${options.whiteSpace}`);
  const item: RichInlineItem = { text: text.data, font: fontOf(style), break: style.whiteSpace === "nowrap" ? "never" : "normal" };
  if (style.letterSpacing !== "normal") item.letterSpacing = px(style, "letter-spacing");
  return item;
}

/** Adds an inline element's edge to the item beside it: a text's padding, or a box's width. */
function widen(item: RichInlineItem | RichInlineBox | undefined, edge: number) {
  if (item === undefined || edge === 0) return;
  if (item.width === undefined) item.extraWidth = (item.extraWidth ?? 0) + edge;
  else item.width += edge;
}

/** A block's flow as its children are read: the parts so far, and the paragraph being gathered. */
type Reading = { flow: Flow; options: RichInlineOptions; items: Paragraph["items"] };

/** Ends the paragraph being gathered; a run of only collapsible white space, as between two blocks, makes no line. */
function flush(reading: Reading) {
  const { flow, options, items } = reading;
  if (items.some((item) => !("text" in item) || options.whiteSpace === "pre-wrap" || item.text.trim() !== "")) flow.parts.push({ items, options });
  reading.items = [];
}

function readChildren(reading: Reading, parent: Node) {
  for (const node of parent.childNodes) {
    if (node instanceof Text) reading.items.push(textItem(node, reading.options));
    else if (node instanceof HTMLElement) readElement(reading, node);
    else if (node instanceof Element) throw new Unmeasurable(node.tagName.toLowerCase());
  }
}

/** An inline element's content joins the paragraph, its edges widening the items at either end. */
function readInline(reading: Reading, node: HTMLElement, style: CSSStyleDeclaration) {
  if (REPLACED.has(node.tagName)) throw new Unmeasurable(node.tagName.toLowerCase());
  // A `<br>` inside starts a new paragraph, so its first item sits in the one it started in.
  const before = reading.items;
  const start = before.length;
  readChildren(reading, node);
  widen(before[start], px(style, "margin-left") + px(style, "border-left-width") + px(style, "padding-left"));
  widen(reading.items.at(-1), px(style, "margin-right") + px(style, "border-right-width") + px(style, "padding-right"));
}

/** A box's laid-out width with its margins, to Pretext's quarter pixel. */
function boxWidth(node: HTMLElement, style: CSSStyleDeclaration) {
  const width = node.getBoundingClientRect().width / zoomOf(node) + px(style, "margin-left") + px(style, "margin-right");
  return Math.ceil(width * 4) / 4;
}

function readElement(reading: Reading, node: HTMLElement) {
  const style = getComputedStyle(node);
  if (style.display === "none" || style.position === "absolute" || style.position === "fixed") return;
  if (style.float !== "none") throw new Unmeasurable(`${node.tagName.toLowerCase()} floated`);
  if (node.tagName === "BR") {
    flush(reading);
    return;
  }
  switch (style.display) {
    case "contents":
      readChildren(reading, node);
      return;
    case "block":
    case "list-item":
      flush(reading);
      // A reply's image, its box sized before the picture comes (ReplyImage): a line its own width, as a file's card.
      if (node.dataset.streamdown === "image-wrapper") reading.flow.parts.push({ items: [{ width: boxWidth(node, style) }], options: reading.options });
      else reading.flow.parts.push(blockFlow(node, style, true));
      return;
    case "inline":
      readInline(reading, node, style);
      return;
    case "inline-block":
      // Its own width, which no line width changes: a citation's pill.
      reading.items.push({ width: boxWidth(node, style) });
      return;
    case "flex":
      // A file's card, a line at its fixed width (files.css); other flex boxes can't be read.
      if (!node.matches("a.reply-file")) throw new Unmeasurable(`${node.tagName.toLowerCase()} shown as flex`);
      flush(reading);
      reading.flow.parts.push({ items: [{ width: boxWidth(node, style) }], options: reading.options });
      return;
    default:
      throw new Unmeasurable(`${node.tagName.toLowerCase()} shown as ${style.display}`);
  }
}

/** `block`'s flow; `margins` counts its own horizontal margins in its edges, as a nested block's take room in its parent. */
function blockFlow(block: HTMLElement, style: CSSStyleDeclaration, margins: boolean): Flow {
  const edge = (side: "left" | "right") =>
    (margins ? px(style, `margin-${side}`) : 0) + px(style, `border-${side}-width`) + px(style, `padding-${side}`);
  const reading: Reading = { flow: { left: edge("left"), right: edge("right"), parts: [] }, options: optionsOf(style), items: [] };
  readChildren(reading, block);
  flush(reading);
  return reading.flow;
}

const REPLACED = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME", "OBJECT", "EMBED", "INPUT", "TEXTAREA", "SELECT", "BUTTON"]);

/** `bubble`'s flow, its own padding and border its edges; or why it can't be read, for content Pretext can't lay out. */
export function bubbleFlow(bubble: HTMLElement): Flow | string {
  try {
    return blockFlow(bubble, getComputedStyle(bubble), false);
  } catch (error) {
    if (error instanceof Unmeasurable) return error.message;
    throw error;
  }
}

const widestLine = ({ items, options }: Paragraph, width: number) => measureRichInlineStats(prepareRichInline(items, options), width).maxLineWidth;

/** A row's bubble: the user's, or Marq's prose. A Worklog's notes are no row's, and wear none. */
const ROW_BUBBLES = ':scope.copilotKitUserMessage > div:first-of-type, :scope.copilotKitAssistantMessage > [class*="cpk:prose"] > div:not(:empty)';

/**
 * A bubble holding code, a diagram or a table keeps its CSS width, fit to its content up to its cap (globals.css); one
 * holding a chart keeps its full cap (chat.css), from before the chart draws.
 */
const COLUMN_WIDE = ':has(> :is([data-streamdown="code-block"], [data-streamdown="mermaid-block"], [data-streamdown="table-wrapper"])), :has(.reply-chart)';

const bubblesOf = (row: Node) => (row instanceof HTMLElement ? [...row.querySelectorAll<HTMLElement>(ROW_BUBBLES)] : []);

/**
 * The width the browser wraps `bubble`'s lines at: its max-width, a percentage of its parent's content box, within the
 * room its margins leave there. A one-line bubble is narrower, so Pretext laying it out that narrow wrapped its last
 * word wherever it measured the line a fraction of a pixel wider than the browser.
 */
function wrapWidth(bubble: HTMLElement, style: CSSStyleDeclaration): number {
  const parent = bubble.parentElement;
  if (parent === null) throw new Unmeasurable("a bubble outside an element");
  const box = getComputedStyle(parent);
  const content = parent.getBoundingClientRect().width / zoomOf(parent)
    - px(box, "padding-left") - px(box, "padding-right") - px(box, "border-left-width") - px(box, "border-right-width");
  const room = content - px(style, "margin-left") - px(style, "margin-right");
  const max = style.maxWidth;
  if (max === "none") return room;
  return Math.min(room, max.endsWith("%") ? (content * parseFloat(max)) / 100 : px(style, "max-width"));
}

/** `bubble`'s width hugging its lines, or null where it keeps its CSS width. */
function huggedWidthOf(bubble: HTMLElement): number | null {
  if (bubble.matches(COLUMN_WIDE)) return null;
  const width = bubble.getBoundingClientRect().width / zoomOf(bubble);
  if (width === 0) return null;
  const flow = bubbleFlow(bubble);
  if (typeof flow === "string") {
    bubble.dataset.unmeasured = flow;
    return null;
  }
  let wraps: number;
  try {
    wraps = Math.max(width, wrapWidth(bubble, getComputedStyle(bubble)));
  } catch (error) {
    if (!(error instanceof Unmeasurable)) throw error;
    bubble.dataset.unmeasured = error.message;
    return null;
  }
  delete bubble.dataset.unmeasured;
  return Math.min(width, Math.ceil(huggedWidth(flow, wraps, widestLine)));
}

/**
 * Shrinks each bubble to its widest line, as Muse's: CSS keeps a box that wraps at its max width, so a two-line bubble
 * had empty room right of its lines. Each bubble's CSS width, the cap when its text wraps, is read first, all at once,
 * so the page lays out once. A bubble whose content can't be read keeps that width and names why in `data-unmeasured`.
 */
function fit(bubbles: HTMLElement[]) {
  for (const bubble of bubbles) bubble.style.removeProperty("width");
  const widths = bubbles.map((bubble) => [bubble, huggedWidthOf(bubble)] as const);
  for (const [bubble, width] of widths) if (width !== null) bubble.style.width = `${width}px`;
}

/**
 * A message list's ref: fits its bubbles to their lines once its fonts have loaded, and again as a reply streams in, a
 * row joins, the column's width changes or a font loads. New content fits as React commits it, before it paints; a
 * width or font change marks rows to fit on the next frame, so a burst of them lays the page out once a frame rather
 * than once each. Returns its cleanup, as a React ref may.
 */
export function fitBubbles(list: HTMLElement | null): (() => void) | undefined {
  if (list === null) return undefined;
  const fonts = list.ownerDocument.fonts;
  const rows = new Set<Node>();
  let everyRow = false;
  let frame: number | undefined;
  const fitMarked = () => {
    frame = undefined;
    // Lines measured in a fallback font take the fallback's widths; the font's load marks every row again.
    if (fonts.status !== "loaded") return;
    const marked = everyRow ? [...list.children] : [...rows].filter((row) => row.parentNode === list);
    rows.clear();
    everyRow = false;
    fit(marked.flatMap(bubblesOf));
  };
  const mark = (row?: Node) => {
    if (row === undefined) everyRow = true;
    else rows.add(row);
    frame ??= requestAnimationFrame(fitMarked);
  };
  const loaded = () => {
    clearCache();
    mark();
  };
  // Its height changes with every streamed word; only a new width moves where lines wrap.
  let width: number | undefined;
  const resized = new ResizeObserver(([entry]) => {
    if (entry === undefined || entry.contentRect.width === width) return;
    width = entry.contentRect.width;
    mark();
  });
  const changed = new MutationObserver((records) => {
    for (const { target, addedNodes } of records) {
      if (target === list) addedNodes.forEach((row) => mark(row));
      else {
        let row: Node | null = target;
        while (row !== null && row.parentNode !== list) row = row.parentNode;
        if (row !== null) mark(row);
      }
    }
    // New content fits before it paints: a streamed word painted a frame inside the width fit to the words before it,
    // wrapping onto a line of its own, and the reply and all below it jumped a line and back.
    if (frame !== undefined) cancelAnimationFrame(frame);
    fitMarked();
  });
  resized.observe(list);
  changed.observe(list, { childList: true, characterData: true, subtree: true });
  fonts.addEventListener("loadingdone", loaded);
  // A list mounting with its rows, as the kept chat does twice while a chat opens, fits them before it paints.
  everyRow = true;
  fitMarked();
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    resized.disconnect();
    changed.disconnect();
    fonts.removeEventListener("loadingdone", loaded);
  };
}
