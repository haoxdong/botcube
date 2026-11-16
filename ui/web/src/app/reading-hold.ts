import { resize } from "framer-motion";
import { useLayoutEffect, useRef, type RefObject } from "react";

import { zoomOf } from "@/lib/utils";

// CSS anchoring suppresses adjustment at scrollTop=0; use-stick-to-bottom does not prepare app-paginated history.
const HOLD = 0.5;

export type ReadRow = { row: Element; scroller: Element; at: number };

export function viewTop(scroller: Element): number {
  return scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
}

function viewBottom(scroller: Element): number {
  return scroller === document.scrollingElement ? window.innerHeight : scroller.getBoundingClientRect().bottom;
}

const contentTop = (row: Element, scroller: Element) => row.getBoundingClientRect().top / zoomOf(scroller) + scroller.scrollTop;

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

type Laid = Map<Element, { at: number; height: number }>;

const laidOut = (list: Element, scroller: Element): Laid =>
  new Map([...list.children].map((child) => {
    const box = child.getBoundingClientRect();
    return [child, { at: contentTop(child, scroller), height: (box.bottom - box.top) / zoomOf(scroller) }];
  }));

function keepInPlace(read: ReadRow) {
  if (!read.row.isConnected) return;
  const { scroller } = read;
  const at = contentTop(read.row, scroller);
  if (Math.abs(at - read.at) < 1) return;
  const atBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 2;
  if (!(atBottom && at < read.at)) scroller.scrollTop += at - read.at;
  read.at = at;
}

function viewOf(list: Element): Element | null {
  let view: Element | null = null;
  for (let box = list.parentElement; box !== null && !box.matches('[data-testid="copilot-chat"]'); box = box.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(box).overflowY) && box.clientHeight < (view?.clientHeight ?? Infinity)) view = box;
  }
  return view ?? document.scrollingElement;
}

function joinsEarlierRows(marker: Element | null, list: Element): boolean {
  const view = viewOf(list);
  if (view === null) return false;
  const page = view === document.scrollingElement;
  const content = list.closest('[data-testid="copilot-scroll-content"]') ?? list;
  const end = page ? content.getBoundingClientRect().bottom : viewTop(view) - view.scrollTop + view.scrollHeight;
  if (marker !== null && end - marker.getBoundingClientRect().bottom < (page ? window.innerHeight : view.clientHeight)) return true;
  view.scrollTop = view.scrollHeight;
  return false;
}

export function useRowsLandOnce(list: RefObject<Element | null>, earlier: RefObject<Element | null>, atEnd: boolean, first: number, join: () => void) {
  const opening = useRef(atEnd);
  useLayoutEffect(() => {
    if (!opening.current) return;
    const rows = earlier.current?.parentElement ?? list.current;
    if (rows === null) return;
    opening.current = joinsEarlierRows(earlier.current, rows);
    if (opening.current) join();
  }, [first]);
}

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
  const stop = resize([list], () => {
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
  events.addEventListener("scroll", scrolled);
  return () => {
    stop();
    events.removeEventListener("scroll", scrolled);
  };
}
