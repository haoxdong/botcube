import { useLayoutEffect, type RefObject } from 'react';

export function useDrawerPreview(layoutRef: RefObject<HTMLDivElement | null>, visible: boolean, isPhone: boolean) {
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    if (!layout || !visible || !isPhone) return;
    layout.style.setProperty('--drawer-scroll', `${window.scrollY}px`);
    layout.style.setProperty('--drawer-page-height', `${document.documentElement.scrollHeight}px`);
    const fitBottom = () => layout.style.setProperty('--drawer-bottom', `${Math.max(0, window.screen.height - window.innerHeight - 62)}px`);
    fitBottom();
    window.addEventListener('resize', fitBottom);
    layout.setAttribute('data-drawer-preview', '');
    return () => {
      window.removeEventListener('resize', fitBottom);
      layout.removeAttribute('data-drawer-preview');
      layout.style.removeProperty('--drawer-scroll');
      layout.style.removeProperty('--drawer-page-height');
      layout.style.removeProperty('--drawer-bottom');
    };
  }, [layoutRef, visible, isPhone]);
}
