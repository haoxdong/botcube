import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useDrawerSwipe } from "./drawer-swipe";
import { withStorage } from "./main-chat-copy";
import { MenuButton } from "./menu-icon";
import { viewport } from "@/design-system/viewport";
import { Arriving } from "./motion";

const KEY = 'botcube.sidebar-expanded';
const DRAWER_REACH = 62;

export function useSidebar(layoutRef: RefObject<HTMLDivElement | null>, isPhone: boolean) {
  const [expanded, setExpanded] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const swipe = useDrawerSwipe({ layoutRef, drawerRef, side: "left", name: "sidebar", enabled: isPhone, docked: !isPhone, expanded, onExpandedChange: setExpanded });
  useEffect(() => {
    if (viewport() !== 'phone' && withStorage(() => localStorage.getItem(KEY)) === 'true') setExpanded(true);
  }, []);
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    if (!layout || !swipe.visible || !isPhone) return;
    const set = (name: string, px: number) => layout.style.setProperty(`--drawer-${name}`, `${px}px`);
    // Under the clock the page is the screen, so the card's corners show (Fig 21)
    const reach = parseFloat(getComputedStyle(layout).getPropertyValue('--shell-top')) > 0 ? 0 : DRAWER_REACH;
    const bottom = () => reach && Math.max(0, window.screen.height - window.innerHeight - reach);
    const vars = { scroll: window.scrollY, 'page-height': document.documentElement.scrollHeight, reach, bottom: bottom() };
    for (const [name, px] of Object.entries(vars)) set(name, px);
    const fitBottom = () => set('bottom', bottom());
    window.addEventListener('resize', fitBottom);
    layout.setAttribute('data-drawer-preview', '');
    return () => {
      window.removeEventListener('resize', fitBottom);
      layout.removeAttribute('data-drawer-preview');
      for (const name of Object.keys(vars)) layout.style.removeProperty(`--drawer-${name}`);
    };
  }, [layoutRef, swipe.visible, isPhone]);
  const toggle = () => {
    swipe.toggle();
    if (!isPhone) withStorage(() => localStorage.setItem(KEY, String(!expanded)));
  };
  return { ...swipe, expanded, drawerRef, toggle };
}

export function Sidebar({ sidebar, inert, children }: { sidebar?: ReturnType<typeof useSidebar>; inert: boolean; children: ReactNode }) {
  const open = sidebar?.visible ?? false;
  return (
    <>
      <aside ref={sidebar?.drawerRef} className={`sidebar ${open ? "sidebar-expanded" : "sidebar-collapsed"}`} inert={inert}><Arriving value={sidebar?.swiping ?? false}>{children}</Arriving></aside>
      {open && <button type="button" className="sidebar-strip-close" onClick={sidebar?.close} aria-label="Close sidebar"><MenuButton faded /></button>}
    </>
  );
}
