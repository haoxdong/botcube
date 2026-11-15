import { cancelFrame, frame } from "framer-motion";

/** Marks a row whose rendering the browser may skip while it is off screen (chat.css). */
export const CONTAINED = "data-contained";

// CSS does not refresh remembered sizes while rows remain size-contained; use-stick-to-bottom has no per-row invalidation API.
export function containRows(list: HTMLElement | null): (() => void) | undefined {
  if (list === null) return undefined;
  const contain = (row: Element, height: number) => {
    if (!(row instanceof HTMLElement) || row.parentNode !== list || row === list.lastElementChild) return;
    row.style.setProperty("contain-intrinsic-block-size", `auto ${height}px`);
    row.setAttribute(CONTAINED, "");
    rows.unobserve(row);
  };
  // Containment changes the ancestor list's size; writing it during observer delivery leaves that notification undelivered.
  const pending = new Map<Element, number>();
  const commit = () => {
    for (const [target, height] of pending) contain(target, height);
    pending.clear();
  };
  const rows = new ResizeObserver((entries) => {
    for (const { target, borderBoxSize } of entries) pending.set(target, borderBoxSize[0]?.blockSize ?? 0);
    frame.read(commit);
  });
  // Observing again delivers the row's size after the next layout: a row no longer last, or after a new width.
  const watch = (row: Element) => {
    if (row.hasAttribute(CONTAINED)) return;
    rows.unobserve(row);
    rows.observe(row);
  };
  const relayout = () => {
    cancelFrame(commit);
    pending.clear();
    for (const row of list.children) {
      if (!(row instanceof HTMLElement)) continue;
      row.removeAttribute(CONTAINED);
      row.style.removeProperty("contain-intrinsic-block-size");
      watch(row);
    }
  };
  let width: number | undefined;
  const resized = new ResizeObserver(([entry]) => {
    if (entry === undefined || entry.contentRect.width === width) return;
    const first = width === undefined;
    width = entry.contentRect.width;
    if (!first) {
      cancelFrame(commit);
      pending.clear();
      frame.read(relayout);
    }
  });
  const fonts = list.ownerDocument.fonts;
  const changed = new MutationObserver(() => {
    for (const row of list.children) watch(row);
  });
  resized.observe(list);
  changed.observe(list, { childList: true });
  fonts.addEventListener("loadingdone", relayout);
  for (const row of list.children) watch(row);
  return () => {
    cancelFrame(commit);
    cancelFrame(relayout);
    pending.clear();
    rows.disconnect();
    resized.disconnect();
    changed.disconnect();
    fonts.removeEventListener("loadingdone", relayout);
  };
}
