/**
 * Resolves once no finite animation is running on `document`. A cancelled animation counts as settled: its element left
 * the page, and its `finished` rejects with an AbortError. Animations its replacement starts are waited
 * for in turn.
 */
export async function animationsSettled(document: Document): Promise<void> {
  const running = document
    .getAnimations()
    .filter(
      (animation) =>
        animation.playState === 'running' &&
        animation.effect?.getTiming().iterations !== Infinity
    );
  if (running.length === 0) return;
  await Promise.allSettled(running.map((animation) => animation.finished));
  return animationsSettled(document);
}
