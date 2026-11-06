import { useLayoutEffect, useRef, type RefObject } from "react";

import { zoomOf } from "@/lib/utils";



/**
 * Where on screen the row the user reads is held, as a share of the scroll view's height down from its top: the middle,
 * so content growing above it, joining rows or a diagram or image rendering in the view's top half, grows upward, and
 * growth in its bottom half pushes down. 0 holds the row at the view's top instead.
 */
const HOLD = 0.5;

/** A row the user was reading, its scroll view, and where the row was in the scroll view's content. */
export type ReadRow = { row: Element; scroller: Element; at: number };

/** The top of what `scroller` shows, on screen: the page's is the screen's top. */
export function viewTop(scroller: Element): number {
  return scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
}

/** The bottom of what `scroller` shows, on screen. */
function viewBottom(scroller: Element): number {
  return scroller === document.scrollingElement ? window.innerHeight : scroller.getBoundingClientRect().bottom;
}

/** Where `row` is in `scroller`'s content, in the scroll view's own pixels, however zoomed the app is. */
const contentTop = (row: Element, scroller: Element) => row.getBoundingClientRect().top / zoomOf(scroller) + scroller.scrollTop;

/**
 * The row the user reads in `scroller`: the first of `list`'s that shows with its top at or under the hold line, so a
 * row reaching over that line, as one straddling the view's top did, is content above it; or, where one row fills the
 * view across the line, that row, as what the user reads. A row that renders nothing, such as a tool's result, is no row
 * to read: rows rendering below it would move the row the user sees.
 */
export function rowRead(list: Element, scroller: Element, laid?: Laid): ReadRow | null {
  const top = viewTop(scroller);
  const bottom = viewBottom(scroller);
  const line = top + HOLD * (bottom - top);
  const zoom = zoomOf(scroller);
  const boxOf = (child: Element) => {
    const was = laid?.get(child);
    if (was === undefined) return child.getBoundingClientRect();
    const at = (was.at - scroller.scrollTop) * zoom;
    return { top: at, bottom: at + was.height * zoom };
  };
  const shown = [...list.children].map((child) => ({ child, box: boxOf(child) })).filter(({ box }) => box.bottom > Math.max(box.top, top) && box.top < bottom);
  const read = shown.find(({ box }) => box.top >= line) ?? shown.at(-1);
  return read === undefined ? null : { row: read.child, scroller, at: laid?.get(read.child)?.at ?? contentTop(read.child, scroller) };
}

/** Where each of a list's rows lay in its scroll view's content, and how tall, in the scroll view's own pixels. */
type Laid = Map<Element, { at: number; height: number }>;

const laidOut = (list: Element, scroller: Element): Laid =>
  new Map([...list.children].map((child) => {
    const box = child.getBoundingClientRect();
    return [child, { at: contentTop(child, scroller), height: (box.bottom - box.top) / zoomOf(scroller) }];
  }));

/**
 * Scrolls by as much as the content above `read`'s row grew, so the row stays where it is on screen; at the scroll view's
 * bottom, content above shrinking leaves the view there. Called from a ResizeObserver, it lands before the frame paints.
 */
function keepInPlace(read: ReadRow) {
  if (!read.row.isConnected) return;
  const { scroller } = read;
  const at = contentTop(read.row, scroller);
  // Growth below the row, such as a streaming Turn, moves nothing: the scroll view keeps up with it itself.
  if (Math.abs(at - read.at) < 1) return;
  // At its bottom, which ChatScrollView's instant resize keeps 1px short of, the view stays there as the content above
  // shrinks: the scroll view takes a scroll up it did not make for the user's and stops keeping to its bottom.
  const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2;
  if (!(atBottom && at < read.at)) scroller.scrollTop += at - read.at;
  read.at = at;
}

/**
 * The view a chat's rows scroll in: the shortest of CopilotKit's scrolling boxes around them, as one of those grows with
 * its content; or the page where the layout lets the chat grow (phones).
 */
function viewOf(list: Element): Element | null {
  let view: Element | null = null;
  for (let box = list.parentElement; box !== null && !box.matches('[data-testid="copilot-chat"]'); box = box.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(box).overflowY) && box.clientHeight < (view?.clientHeight ?? Infinity)) view = box;
  }
  return view ?? document.scrollingElement;
}

/**
 * Whether an opening chat must join earlier rows before it paints: `true` while the rows below `marker` (none once every
 * row has joined) don't fill `list`'s view, so that at the view's end `marker` would show; once they do, the view starts
 * at its end, where StickToBottom would take it a frame later.
 */
function joinsEarlierRows(marker: Element | null, list: Element): boolean {
  const view = viewOf(list);
  if (view === null) return false;
  const page = view === document.scrollingElement;
  // A phone's chat ends with its scroll content, which the open drawer's hold keeps where it was.
  const content = list.closest('[data-testid="copilot-scroll-content"]') ?? list;
  const end = page ? content.getBoundingClientRect().bottom : viewTop(view) - view.scrollTop + view.scrollHeight;
  if (marker !== null && end - marker.getBoundingClientRect().bottom < (page ? window.innerHeight : view.clientHeight)) return true;
  view.scrollTop = view.scrollHeight;
  // CopilotKit's message virtualizer, attaching to a new scroller in this commit's later layout effects, scrolls it to
  // its own stored offset, 0 (TanStack Virtual's _willUpdate); a frame's callbacks run before its paint.
  requestAnimationFrame(() => {
    view.scrollTop = view.scrollHeight;
  });
  return false;
}

/**
 * Lays a chat opening at its end out before it paints, so its rows land once: while the rows below `earlier`, the
 * marker above the shown rows of `list`, don't fill the view, `join` brings in the page above, until they do; then the
 * view starts at its end. A chat of one page has no marker; its rows are `list`'s. A chat opening at a given row (`atEnd`
 * false) is left as it lays out.
 */
export function useRowsLandOnce(list: RefObject<Element | null>, earlier: RefObject<Element | null>, atEnd: boolean, first: number, join: () => void) {
  const opening = useRef(atEnd);
  useLayoutEffect(() => {
    if (!opening.current) return;
    const land = (rows: Element) => {
      opening.current = joinsEarlierRows(earlier.current, rows);
      if (opening.current) join();
    };
    const rows = earlier.current?.parentElement ?? list.current;
    if (rows != null) {
      land(rows);
      return;
    }
    // The list's ref attaches after this effect, and CopilotKit's virtualizer resets its scroller after that (see
    // joinsEarlierRows); a frame's callbacks run after both and before its paint.
    const frame = requestAnimationFrame(() => {
      if (list.current !== null) land(list.current);
    });
    return () => cancelAnimationFrame(frame);
    // `join` is the render's own, for the rows it laid out; a new page of rows is a new `first`.
  }, [first]);
}

/**
 * A frame's scroll event runs before its ResizeObservers, so rows that grew in the frame the user scrolled have already
 * moved the rows read: the observer takes the row scrolled to by where the rows lay before they grew, and holds it
 * against the growth above it.
 */
export function holdReading(read: ReadRow, list: Element, events: EventTarget): () => void {
  const height = () => {
    const box = list.getBoundingClientRect();
    return box.bottom - box.top;
  };
  keepInPlace(read);
  let kept = read.scroller.scrollTop;
  let held = height();
  let laid = laidOut(list, read.scroller);
  let scrolledTo = false;
  const moveTo = (before?: Laid) => {
    scrolledTo = false;
    const now = rowRead(list, read.scroller, before);
    if (now !== null) Object.assign(read, now);
  };
  const observer = new ResizeObserver(() => {
    if (scrolledTo) moveTo(laid);
    keepInPlace(read);
    kept = read.scroller.scrollTop;
    held = height();
    laid = laidOut(list, read.scroller);
  });
  const scrolled = () => {
    if (read.scroller.scrollTop === kept) return;
    kept = read.scroller.scrollTop;
    if (height() === held) moveTo();
    else scrolledTo = true;
  };
  observer.observe(list);
  events.addEventListener("scroll", scrolled);
  return () => {
    observer.disconnect();
    events.removeEventListener("scroll", scrolled);
  };
}
