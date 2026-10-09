import { useEffect, useLayoutEffect, useRef } from 'react';

/** Whether the open drawer holds the page, whose scroll then stands for nothing the user did. */
export function pageHeld(): boolean {
  return document.documentElement.style.getPropertyValue('--page-scroll') !== '';
}

/**
 * A phone's chat scrolls the page (#3613). While `held`, the open drawer or Agent Profile pins the screen as one card
 * that cannot scroll, its contents offset by `--page-scroll` to stay where the page had them; on release the page
 * scrolls back there.
 *
 * Held, the page is the screen with a `--page-runway` above it, scrolled past the runway: iOS Safari fills the strip
 * behind the clock with one flat colour while the page sits at its top, and with the page's own pixels once it has
 * scrolled, so the drawer and the card drawn up into the runway show there (#3640). A real finger's swipe scrolls the
 * page before the hold begins, toward its top, so the held page goes back past the runway whenever it scrolls.
 * Below the screen runs `--page-runway-bottom`, the height Safari's bottom bar and the home bar take under the page's
 * viewport, so the drawer and the card run on behind them.
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
      root.setAttribute('data-page-held', '');
      const runway = Number.parseFloat(getComputedStyle(root).getPropertyValue('--page-runway')) || 0;
      const fitBottom = () => {
        root.style.setProperty('--page-runway-bottom', `${Math.max(0, window.screen.height - window.innerHeight - runway)}px`);
      };
      const keepRunway = () => {
        if (window.scrollY !== runway) window.scrollTo(0, runway);
      };
      fitBottom();
      keepRunway();
      window.addEventListener('scroll', keepRunway, { passive: true });
      window.addEventListener('resize', fitBottom);
      // Unmounted while held, as signing out from the open drawer does, the app lets the page go.
      return () => {
        window.removeEventListener('scroll', keepRunway);
        window.removeEventListener('resize', fitBottom);
        root.style.removeProperty('--page-runway-bottom');
        root.style.removeProperty('--page-scroll');
        root.removeAttribute('data-page-held');
      };
    }
    if (holding.current) {
      holding.current = false;
      root.style.removeProperty('--page-scroll');
      root.removeAttribute('data-page-held');
      window.scrollTo(0, scroll.current);
    }
    return undefined;
  }, [held]);
}
