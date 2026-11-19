import { animate, motionValue, styleEffect } from 'motion/react';
import { useLayoutEffect, useState } from 'react';
import { motionTokens } from '../../app/motion-tokens';

// CSS cannot interpolate auto-to-auto size; Base UI has no resize animation, and UI SDK beta.2 translates content snaps without interpolating box height.
export function useSheetHeight(snapped: boolean) {
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const { move } = motionTokens();
    if (snapped || popup === null || content === null || move.visualDuration === 0) return;
    const height = motionValue(parseFloat(getComputedStyle(popup).height));
    const unbind = styleEffect(popup, { height });
    let animation: ReturnType<typeof animate> | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize[0];
      if (!size) return;
      const style = getComputedStyle(popup);
      const to = size.blockSize + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      if (height.get() === to) return;
      animation?.stop();
      animation = animate(height, to, { ...move, velocity: retargetVelocity(height.get(), to, height.getVelocity(), move.visualDuration) });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      animation?.stop();
      unbind();
      popup.style.removeProperty('height');
    };
  }, [popup, content, snapped]);
  return [setPopup, setContent] as const;
}

// A critically damped spring overshoots when it arrives faster than its natural frequency times the distance left, so
// the carried speed is capped there: the box keeps its momentum into a moving target without sinking past it.
export function retargetVelocity(from: number, to: number, velocity: number, visualDuration: number) {
  const toward = Math.sign(to - from);
  const limit = ((2 * Math.PI) / (1.2 * visualDuration)) * Math.abs(to - from);
  return velocity * toward > limit ? toward * limit : velocity;
}
