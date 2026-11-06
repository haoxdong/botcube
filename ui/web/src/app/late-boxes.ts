import { withStorage } from "./main-chat-copy";

/**
 * A reply's content that comes after its row, a diagram drawn or an image loaded, takes a box from the row's first
 * frame when the row joins the history above the reader: the size it last came to, kept here across visits,
 * or a default until it has come once. A row that joins above stays that size, so nothing above the row read moves as
 * its content comes; one that opens the chat takes its content's own size, as the reader sees it come. In a row that
 * arrives under the history, a streaming reply, a diagram's box only grows: streamdown steps it through a
 * placeholder, an empty frame, its loading message and drawings that shrink as nodes widen them, and each step down
 * would move the chat under the reader. The box keeps its tallest height while the row stays, as a joined row's does;
 * the reply shows at its own height when the chat opens again. Accepted: a window that narrows and widens again leaves
 * the box at its tallest, and streamdown's stand-in for the whole block while the diagram renderer first loads, once
 * per page, is not held.
 */
export type Size = { width: number; height: number };

const KEY = "late-box-sizes";
/** Enough for every diagram and image in a long history; the oldest kept goes first. */
const LIMIT = 500;

let sizes: Map<string, Size> | null = null;
const kept = () =>
  (sizes ??= new Map(withStorage(() => JSON.parse(localStorage.getItem(KEY) ?? "[]") as [string, Size][]) ?? []));

export const sizeOf = (key: string): Size | null => kept().get(key) ?? null;

export function keepSize(key: string, size: Size) {
  const all = kept();
  const was = all.get(key);
  if (was?.width === size.width && was.height === size.height) return;
  all.delete(key);
  all.set(key, size);
  for (const oldest of all.keys()) {
    if (all.size <= LIMIT) break;
    all.delete(oldest);
  }
  withStorage(() => localStorage.setItem(KEY, JSON.stringify([...all])));
}

const ROW = ".copilotKitAssistantMessage[data-message-id]";
/**
 * A diagram's block, or streamdown's loading box in its place while its diagram renderer's chunk loads: streamdown
 * shows that box only for a plugin's renderer, and the diagram is the only one here.
 */
const DIAGRAMS = ':scope [data-streamdown="mermaid-block"], :scope [class*="cpk:prose"] > div > .divide-y.rounded-xl';

/** The height a drawn diagram takes at its box's width: its own, or narrower, as streamdown fits it. */
function drawnHeight(block: HTMLElement): number | null {
  const frame = block.querySelector<HTMLElement>('[data-streamdown="mermaid"]');
  const [, , width = 0, height = 0] = (frame?.querySelector('[aria-label="Mermaid chart"] > svg')?.getAttribute("viewBox") ?? "")
    .split(/[\s,]+/)
    .map(Number);
  if (!frame || !(width > 0 && height > 0) || frame.clientWidth === 0) return null;
  return Math.ceil(height * Math.min(1, frame.clientWidth / width));
}

/** A diagram's height before it has drawn once: streamdown's own placeholder's. */
const UNDRAWN_HEIGHT = 200;

/**
 * Gives each of `row`'s diagrams, as its box first shows, the height it last drew at, and keeps each one's height once
 * it draws. A box keeps the height it showed at.
 */
function sizeDiagrams(row: HTMLElement) {
  row.querySelectorAll<HTMLElement>(DIAGRAMS).forEach((block, index) => {
    const key = `diagram:${row.dataset.messageId}#${index}`;
    if (block.style.getPropertyValue("--diagram-height") === "")
      block.style.setProperty("--diagram-height", `${sizeOf(key)?.height ?? UNDRAWN_HEIGHT}px`);
    const height = drawnHeight(block);
    if (height !== null) keepSize(key, { width: 0, height });
  });
}

/** A diagram's box, under its header: streamdown names neither, so the box is the block's last child. */
const DIAGRAM_BOX = '[data-streamdown="mermaid-block"] > div:last-child';

/** Holds each diagram box `grows` observes at the tallest it has been, before the frame paints. */
function floorDiagrams() {
  const tallest = new WeakMap<Element, number>();
  return new ResizeObserver((entries) => {
    for (const { target, borderBoxSize } of entries) {
      const height = Math.ceil(borderBoxSize[0]?.blockSize ?? 0);
      if (height <= (tallest.get(target) ?? 0)) continue;
      tallest.set(target, height);
      (target as HTMLElement).style.setProperty("--diagram-floor", `${height}px`);
    }
  });
}

/** The message row `node` is in, inside `list`. */
function rowOf(list: HTMLElement, node: Node): HTMLElement | null {
  let row: Node | null = node;
  while (row !== null && row.parentNode !== list) row = row.parentNode;
  return row instanceof HTMLElement && row.matches(ROW) ? row : null;
}

/** The nearest sibling of `node`'s, going `way`, that was there before this batch of rows was added. */
function standing(node: Element, way: "previousElementSibling" | "nextElementSibling", added: Set<Element>) {
  let sibling = node[way];
  while (sibling !== null && added.has(sibling)) sibling = sibling[way];
  return sibling;
}

/** Arrived under the history: added below a row already there, with none under it. */
function arrivedUnder(node: Element, added: Set<Element>) {
  return standing(node, "previousElementSibling", added) !== null && standing(node, "nextElementSibling", added) === null;
}

/** Joined above: added at the list's top, or under the marker for its earlier rows, with rows already there under it. */
function joinedAbove(node: Element, added: Set<Element>) {
  const before = standing(node, "previousElementSibling", added);
  return standing(node, "nextElementSibling", added) !== null && (before === null || before.hasAttribute("data-chat-earlier"));
}

/**
 * A message list's ref: marks the rows that join above rows already there `data-joined` before they paint, and sizes
 * each reply's diagrams from the heights they last drew at; marks the rows that arrive under them `data-arrived`, and
 * holds their diagrams' boxes from shrinking. A list's first rows join unmarked. Returns its cleanup, as a React ref may.
 */
export function keepLateBoxes(list: HTMLElement | null): (() => void) | undefined {
  if (list === null) return undefined;
  const grows = floorDiagrams();
  const changed = new MutationObserver((records) => {
    const added = new Set(records.flatMap(({ target, addedNodes }) => (target === list ? [...addedNodes] : [])).filter((node) => node instanceof HTMLElement));
    for (const row of added) {
      if (joinedAbove(row, added)) row.dataset.joined = "";
      else if (arrivedUnder(row, added)) row.dataset.arrived = "";
    }
    const rows = new Set([...added, ...records.map(({ target }) => rowOf(list, target))]);
    for (const row of rows) {
      if (!row?.matches(ROW)) continue;
      sizeDiagrams(row);
      if (row.dataset.arrived !== undefined) row.querySelectorAll(DIAGRAM_BOX).forEach((box) => grows.observe(box));
    }
  });
  changed.observe(list, { childList: true, subtree: true });
  list.querySelectorAll<HTMLElement>(ROW).forEach(sizeDiagrams);
  return () => {
    changed.disconnect();
    grows.disconnect();
  };
}
