import { describe, expect, it } from 'vitest';

import { animationsSettled } from './animations-settled';

function animation(finished: Promise<unknown>, iterations = 1) {
  let playState: AnimationPlayState = 'running';
  void finished.then(
    () => (playState = 'finished'),
    () => (playState = 'idle')
  );
  return {
    get playState() {
      return playState;
    },
    finished,
    effect: { getTiming: () => ({ iterations }) },
  } as unknown as Animation;
}

function documentWith(animations: () => Animation[]) {
  return { getAnimations: animations } as unknown as Document;
}

describe('animationsSettled', () => {
  it('waits past a cancelled animation for the one replacing it', async () => {
    const cancelled = animation(
      Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))
    );
    let finishReplacement = () => {};
    const replacement = animation(
      new Promise<void>((resolve) => (finishReplacement = resolve))
    );
    let animations = [cancelled];
    let settled = false;
    const waiting = animationsSettled(documentWith(() => animations)).then(
      () => (settled = true)
    );

    animations = [replacement];
    await new Promise((resolve) => setTimeout(resolve));
    expect(settled).toBe(false);

    finishReplacement();
    await waiting;
    expect(settled).toBe(true);
  });

  it('skips an infinite animation', async () => {
    await animationsSettled(
      documentWith(() => [animation(new Promise(() => {}), Infinity)])
    );
  });
});
