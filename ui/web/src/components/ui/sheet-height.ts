import { animate } from 'motion/react';
import { useLayoutEffect, useState } from 'react';
import { moveTween } from '../../app/motion-tokens';

// CSS cannot interpolate auto-to-auto size; Base UI has no resize animation, and UI SDK beta.2 translates content snaps without interpolating box height.
export function useSheetHeight(snapped: boolean) {
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (snapped || popup === null || content === null || moveTween().duration === 0) return;
    let previous = Number.NaN;
    let animation: ReturnType<typeof animate> | undefined;
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize[0];
      if (!size) return;
      const style = getComputedStyle(popup);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const to = size.blockSize + padding;
      if (previous === to) return;
      previous = to;
      animation?.stop();
      animation = animate(popup, { height: to }, moveTween());
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      animation?.stop();
      popup.style.removeProperty('height');
    };
  }, [popup, content, snapped]);
  return [setPopup, setContent] as const;
}
