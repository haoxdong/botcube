import { useEffect } from 'react';

const COMPOSER = "[data-testid='copilot-input-overlay']";
/** How far a finger drags down before it reads as scrolling the chat up rather than a tap. */
const DRAG = 10;

/**
 * Dragging the phone's chat down to scroll it up closes the keyboard, as iMessage does (#3613): it blurs the
 * focused composer. Drags that start in the composer, such as scrolling its own text, leave it focused.
 */
export function useScrollUpClosesKeyboard() {
  useEffect(() => {
    let start: number | null = null;
    const touched = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      start = target?.closest(COMPOSER) ? null : (event.touches[0]?.clientY ?? null);
    };
    const dragged = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (start === null || y === undefined || y - start < DRAG) return;
      start = null;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest(COMPOSER)) focused.blur();
    };
    document.addEventListener('touchstart', touched, { passive: true });
    document.addEventListener('touchmove', dragged, { passive: true });
    return () => {
      document.removeEventListener('touchstart', touched);
      document.removeEventListener('touchmove', dragged);
    };
  }, []);
}
