import { useLayoutEffect, type RefObject } from 'react';

import { sizeGlide } from './motion';

const LAYOUT = '.copilotKitInput > [data-layout]';

/** The text box's height for its draft, up to the cap CopilotKit sets, as CopilotKit sizes it. */
function resize(target: Node) {
  const layout = target instanceof Element && target.matches('.copilotKitInput') ? target.querySelector(':scope > [data-layout]') : target;
  if (!(layout instanceof Element) || !layout.matches(LAYOUT)) return;
  const textarea = layout.querySelector('textarea');
  if (textarea === null) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, parseFloat(textarea.style.maxHeight) || Infinity)}px`;
}

/**
 * Grows and shrinks the composer's box from its last height to its new one over --motion-move (DESIGN.md Motion), as
 * a line, a chip or a cleared draft changes it, so the thread above follows instead of jumping. Its controls stay at its
 * bottom while it grows, as iOS's field grows upward.
 */
function smoothHeight(box: HTMLElement) {
  const { glide, stop } = sizeGlide(box, 'height', { overflow: 'clip', justifyContent: 'flex-end' });
  // Turning expanded puts the draft on its own row above the controls: held at the bottom, that row was clipped away.
  const layoutOf = () => box.querySelector(':scope > [data-layout]')?.getAttribute('data-layout');
  let layout = layoutOf();
  const observer = new ResizeObserver(() => {
    const now = layoutOf();
    glide(now === 'expanded' && layout !== 'expanded' ? { justifyContent: 'flex-start' } : {});
    layout = now;
  });
  // The box's own size changes as it animates; its content's are the draft's and the chips', whose bar comes and goes.
  const watch = () => { for (const child of box.children) observer.observe(child); };
  // A child going, as the chips' bar does with its last chip, resizes nothing it observes; a chip going inside the bar
  // resizes it only at the next layout, a frame late. Each glides from the commit that made it.
  const children = new MutationObserver(() => { watch(); glide(); });
  children.observe(box, { childList: true, subtree: true });
  watch();
  return () => { stop(); observer.disconnect(); children.disconnect(); };
}

/**
 * Sizes the composer under `root`. CopilotKit sizes its text box to its draft, then lays a desktop's composer out
 * `expanded` once the draft outgrows the compact text column, and skips sizing it in the new layout: a line that wrapped
 * in the compact column kept two lines' height across the expanded one. Each change of layout sizes it again. Its box
 * glides to each new height (smoothHeight).
 */
export function useComposerSizing(root: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = root.current;
    if (element === null) return undefined;
    const observer = new MutationObserver((records) => records.forEach(({ target }) => resize(target)));
    observer.observe(element, { attributes: true, attributeFilter: ['data-layout', 'data-open'], subtree: true });
    const box = element.querySelector<HTMLElement>('.copilotKitInput');
    const stop = box && typeof ResizeObserver === 'function' ? smoothHeight(box) : undefined;
    return () => { observer.disconnect(); stop?.(); };
  }, [root]);
}
