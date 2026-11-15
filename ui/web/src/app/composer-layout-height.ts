import { useLayoutEffect, type RefObject } from 'react';

import { sizeGlide } from './motion';

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

// CSS cannot interpolate auto-to-auto composer/chip height; Vercel's textarea sizing only covers the field.
export function useComposerSizing(root: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const box = root.current?.querySelector<HTMLElement>('.copilotKitInput');
    if (!box || typeof ResizeObserver !== 'function') return undefined;
    return smoothHeight(box);
  }, [root]);
}
