import { prepareWithSegments, walkLineRanges } from '@chenglou/pretext';
import { useLayoutEffect, useRef } from 'react';

/** A name's last characters, kept whole while its start gives way to an ellipsis, as Finder cuts a name: `rates…cap.md`. */
const TAIL = 6;

/** How far, in px, Pretext's measure of a cut may be from the page's before the page decides it. */
const EDGE = 4;

/** Room to wrap before an extension's dot from `from` on, as `sunset` / `.png`; a leading dot, as in `.env`, belongs to the name. */
function breakable(text: string, from = 1): string[] {
  const dot = text.lastIndexOf('.');
  return dot >= from ? [text.slice(0, dot), text.slice(dot)] : [text];
}

/**
 * The ways `name` can show, best first: whole, then wrapped before its extension; then cut in its middle, the most of
 * its start that fits before the ellipsis, as it is or wrapped before the extension; last, the ellipsis and the tail
 * alone. Lines break only between words, so a shorter start can need more lines than a longer one (`auction-t…ng` /
 * `.pdf` against `auction-` / `t…ng.pdf`): each length is tried, longest first, rather than halved.
 */
function* cutsOf(name: string): Generator<string[]> {
  yield [name];
  yield breakable(name);
  if (name.length <= TAIL) return;
  for (let head = name.length - TAIL - 1; head > 0; head -= 1) {
    const cut = `${name.slice(0, head)}…${name.slice(-TAIL)}`;
    yield [cut];
    yield breakable(cut, head + 1);
  }
  yield [`…${name.slice(-TAIL)}`];
}

/** The first of `name`'s ways to show that `fits`, or its last. */
export function cutFitting(name: string, fits: (parts: string[]) => boolean): string[] {
  let last = [name];
  for (const parts of cutsOf(name)) {
    if (fits(parts)) return parts;
    last = parts;
  }
  return last;
}

/**
 * A name wrapping to two lines at most under its icon, as Finder sets it, only at word breaks and before its extension;
 * a longer one is cut in its middle to fit them. Each cut is laid out by Pretext, off the page, and the one chosen is
 * checked on it: a layout of the page for each cut tried took seconds for a listing of long names in Chromium.
 */
export function FileName({ name }: { name: string }) {
  const view = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const span = view.current;
    if (span === null) return;
    // Parts join at a `<wbr>`, a break with no character of its own, so a copied name is the name.
    const show = (parts: string[]) => span.replaceChildren(...parts.flatMap((part, index) => (index === 0 ? [part] : [document.createElement('wbr'), part])));
    // A word wider than the line overflows it rather than breaking, so the width is checked as well as the lines.
    const shownFits = () => span.scrollHeight <= span.clientHeight && span.scrollWidth <= span.clientWidth;
    // The span hugs its text, up to its cell's width (`max-width: 100%`): the room a name has is the cell's.
    const cell = span.parentElement;
    if (cell === null) return;
    const fit = () => {
      const style = getComputedStyle(span);
      const cellStyle = getComputedStyle(cell);
      const room = cell.clientWidth - parseFloat(cellStyle.paddingLeft) - parseFloat(cellStyle.paddingRight);
      const width = room - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const lines = Math.round(parseFloat(style.maxHeight) / parseFloat(style.lineHeight));
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      // A zero-width space breaks where the `<wbr>` does. Pretext breaks a word wider than the line inside it, where the
      // page lets it overflow: a line ending inside a segment is a word that doesn't fit.
      const laidOutIn = (parts: string[], room: number) => {
        let brokenWords = 0;
        const count = walkLineRanges(prepareWithSegments(parts.join('\u200B'), font), room, ({ end }) => {
          if (end.graphemeIndex !== 0) brokenWords += 1;
        });
        return brokenWords === 0 && count <= lines;
      };
      // Pretext's widths are within a pixel or two of the page's, not equal to them: a cut it fits or rejects with
      // room to spare is decided by it, and one at the edge by the page, so the cut is the one the page would choose.
      const laidOut = (parts: string[]) => {
        if (!laidOutIn(parts, width + EDGE)) return false;
        if (laidOutIn(parts, width - EDGE)) return true;
        show(parts);
        return shownFits();
      };
      let measured: string[] | null = null;
      try {
        measured = cutFitting(name, laidOut);
      } catch (error) {
        // Pretext measures on a canvas, which a page without one (a DOM test's) lacks: the page lays each cut out.
        if (!(error instanceof Error && error.message.startsWith('Text measurement requires'))) throw error;
      }
      if (measured !== null) show(measured);
      // Where the page lays it out otherwise, as before its font loads, each cut is shown on the page in turn.
      if (measured === null || !shownFits()) show(cutFitting(name, (parts) => (show(parts), shownFits())));
    };
    fit();
    // Fitted again as the cell's box changes, as when the page's font loads, though not as the observer first reports.
    let size = `${cell.clientWidth}×${cell.clientHeight}`;
    const observer = new ResizeObserver(() => {
      const now = `${cell.clientWidth}×${cell.clientHeight}`;
      if (now === size) return;
      size = now;
      fit();
    });
    observer.observe(cell);
    return () => observer.disconnect();
  }, [name]);
  return <span ref={view} className="agent-computer-file-name" />;
}
