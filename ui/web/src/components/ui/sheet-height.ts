import { animate } from 'framer-motion';
import { useLayoutEffect, useState } from 'react';
import { motionTokens } from '../../app/motion-tokens';

export function useSheetHeight(snapped: boolean) {
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (snapped || popup === null || content === null || motionTokens().move.duration === 0) return;
    let previous = popup.getBoundingClientRect().height;
    let animation: ReturnType<typeof animate> | undefined;
    let frame = 0;
    popup.style.height = `${previous}px`;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const style = getComputedStyle(popup);
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        const to = content.offsetHeight + padding;
        if (previous === to) return;
        previous = to;
        animation?.stop();
        animation = animate(popup, { height: to }, motionTokens().move);
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      animation?.stop();
      popup.style.removeProperty('height');
    };
  }, [popup, content, snapped]);
  return [setPopup, setContent] as const;
}
