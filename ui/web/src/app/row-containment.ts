/** Marks a row whose rendering the browser may skip while it is off screen (chat.css). */
export const CONTAINED = "data-contained";

/**
 * Lets the browser skip each row of `list` while it is off screen (`content-visibility: auto`), so a Turn start on a
 * long chat restyles and lays out the rows in view, not the whole chat: every row it inserts invalidated the style of
 * all 27,000 elements of a 174-message chat, and each read of a box laid all of them out, 400 ms each.
 *
 * A row is contained only once laid out, at the height it was laid out at, as a skipped row takes the size it was last
 * given: a row contained before its first layout would hold a guess and change height as it came into view, and the
 * list keeps the reading place itself (`overflow-anchor: none`). A new width wraps every row anew, so it lays them all
 * out again before containing them at their new heights, as does a font loading: rows laid out in a fallback font wrap
 * at its widths. The last row stays live, as a streamed reply grows there.
 */
export function containRows(list: HTMLElement | null): (() => void) | undefined {
  if (list === null) return undefined;
  const contain = (row: Element, height: number) => {
    if (!(row instanceof HTMLElement) || row.parentNode !== list || row === list.lastElementChild) return;
    row.style.setProperty("contain-intrinsic-block-size", `auto ${height}px`);
    row.setAttribute(CONTAINED, "");
    rows.unobserve(row);
  };
  const rows = new ResizeObserver((entries) => {
    for (const { target, borderBoxSize } of entries) contain(target, borderBoxSize[0]?.blockSize ?? 0);
  });
  // Observing again delivers the row's size after the next layout: a row no longer last, or after a new width.
  const watch = (row: Element) => {
    if (row.hasAttribute(CONTAINED)) return;
    rows.unobserve(row);
    rows.observe(row);
  };
  const relayout = () => {
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
    if (!first) relayout();
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
    rows.disconnect();
    resized.disconnect();
    changed.disconnect();
    fonts.removeEventListener("loadingdone", relayout);
  };
}
