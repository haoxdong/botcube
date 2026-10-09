import { useLayoutEffect, type RefObject } from 'react';

/**
 * A phone's chat scrolls the page (#3613). iOS Safari shows the page on below the fixed composer, where fixed
 * content never paints: under its see-through keyboard bar with the keyboard up, and past the bottom of the layout
 * viewport, under the short bar that replaces its toolbar, with a hardware keyboard. `backing`, absolutely placed in the
 * chat, covers it from the composer's bottom to the chat's end, following the page's scroll.
 */
export function useComposerBacking(backing: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = backing.current;
    const chat = element?.closest('.copilotKitChat');
    const composer = chat?.querySelector("[data-testid='copilot-input-overlay']");
    if (!element || !chat || !composer) throw new Error("The phone composer's backing needs its chat and composer");
    const place = () => {
      const bottom = composer.getBoundingClientRect().bottom;
      const origin = (element.offsetParent ?? document.documentElement).getBoundingClientRect().top;
      element.style.top = `${bottom - origin}px`;
      element.style.height = `${Math.max(0, chat.getBoundingClientRect().bottom - bottom)}px`;
    };
    place();
    const resized = new ResizeObserver(place);
    resized.observe(composer);
    resized.observe(chat);
    const viewport = window.visualViewport;
    window.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    return () => {
      resized.disconnect();
      window.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
    };
  }, [backing]);
}
