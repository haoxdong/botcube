import { useEffect, useLayoutEffect, useRef } from 'react';

/** Whether the open drawer holds the page, whose scroll then stands for nothing the user did. */
export function pageHeld(): boolean {
  return document.documentElement.style.getPropertyValue('--page-scroll') !== '';
}

/**
 * A phone's chat scrolls the page (#3613). While `held`, the open drawer pins the screen as one card that
 * cannot scroll, its contents offset by `--page-scroll` to stay where the page had them; on release the page
 * scrolls back there.
 */
export function usePageHold(held: boolean) {
  const scroll = useRef(0);
  const holding = useRef(false);
  useEffect(() => {
    const track = () => {
      if (!holding.current) scroll.current = window.scrollY;
    };
    track();
    window.addEventListener('scroll', track, { passive: true });
    return () => window.removeEventListener('scroll', track);
  }, []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (held) {
      holding.current = true;
      root.style.setProperty('--page-scroll', `${scroll.current}px`);
      // Unmounted while held, as signing out from the open drawer does, the app lets the page go.
      return () => {
        root.style.removeProperty('--page-scroll');
      };
    }
    if (holding.current) {
      holding.current = false;
      root.style.removeProperty('--page-scroll');
      window.scrollTo(0, scroll.current);
    }
    return undefined;
  }, [held]);
}
