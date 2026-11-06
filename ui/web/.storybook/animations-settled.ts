/**
 * Resolves once no finite animation on the document's timeline is running. A cancelled animation counts as settled:
 * its element left the page, and its `finished` rejects with an AbortError. Animations its replacement starts are
 * waited for in turn. Any other timeline is skipped: a scroll-driven animation advances only with scroll, so its
 * `finished` never resolves on a page nobody scrolls.
 */
async function timelineSettled(document: Document): Promise<void> {
  const running = document
    .getAnimations()
    .filter(
      (animation) =>
        animation.playState === 'running' &&
        animation.timeline === document.timeline &&
        animation.effect?.getTiming().iterations !== Infinity
    );
  if (running.length === 0) return;
  await Promise.allSettled(running.map((animation) => animation.finished));
  return timelineSettled(document);
}

/** Waits for finite timeline animations, then for the requested layout boxes to hold still across five paints. */
export async function animationsSettled(document: Document, elements: readonly Element[] = []): Promise<void> {
  await timelineSettled(document);
  if (elements.length === 0) return;
  const until = performance.now() + 5000;
  const boxes = () => elements.map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return `${x},${y},${width},${height}`;
  }).join(';');
  const settled = async (previous: string, same: number): Promise<void> => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const next = boxes();
    const stable = next === previous ? same + 1 : 0;
    if (stable >= 5) return;
    if (performance.now() > until) throw new Error('Layout did not settle within five seconds');
    return settled(next, stable);
  };
  await settled(boxes(), 0);
  await timelineSettled(document);
}
