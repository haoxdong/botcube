import { useDrag } from '@use-gesture/react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

type DragSession =
  | { phase: 'idle' }
  | { phase: 'pending'; startExpanded: boolean }
  | { phase: 'dragging'; startExpanded: boolean; movement: number; width: number }
  | { phase: 'settling'; targetExpanded: boolean; width: number; offset: number };
type DragStyle = CSSProperties & { '--sidebar-drag-offset'?: string; '--sidebar-drag-progress'?: number };
type Options = {
  layoutRef: RefObject<HTMLDivElement | null>;
  drawerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
};

function excludesSwipe(target: EventTarget | null) {
  if (!(target instanceof Element)) return true;
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return true;
  if (window.getSelection()?.toString()) return true;
  for (let node: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement; node; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

function offset(session: Extract<DragSession, { phase: 'dragging' }>) {
  return Math.max(0, Math.min(session.width, (session.startExpanded ? session.width : 0) + session.movement));
}

function canStart(event: TouchEvent, enabled: boolean) {
  const x = event.changedTouches[0]?.clientX ?? 0;
  return enabled && event.touches.length === 1 && x > 20 && !excludesSwipe(event.target);
}

function recognize(session: DragSession, dx: number, dy: number, last: boolean, drawer: HTMLElement | null): DragSession {
  if (session.phase !== 'pending') return session;
  if (last || (Math.abs(dy) >= 8 && Math.abs(dy) >= Math.abs(dx))) return { phase: 'idle' };
  if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy) * 1.5) return session;
  if (session.startExpanded ? dx >= 0 : dx <= 0) return { phase: 'idle' };
  return { phase: 'dragging', startExpanded: session.startExpanded, movement: dx,
    width: session.startExpanded ? drawer?.getBoundingClientRect().width ?? 0 : 0 };
}

export function usePhoneSidebarSwipe({ layoutRef, drawerRef, enabled, expanded, onExpandedChange }: Options) {
  const sessionRef = useRef<DragSession>({ phase: 'idle' });
  const [session, setSession] = useState<DragSession>(sessionRef.current);
  const suppressClickUntil = useRef(0);
  const changeSession = (next: DragSession) => {
    sessionRef.current = next;
    setSession(next);
  };
  const settle = (current: Extract<DragSession, { phase: 'dragging' }>, targetExpanded: boolean) => {
    changeSession({ phase: 'settling', targetExpanded, width: current.width, offset: offset(current) });
  };
  useDrag(({ event, first, last, movement: [dx, dy], velocity: [vx], direction: [direction], canceled, cancel }) => {
    if (!('touches' in event)) return;
    const touch = event;
    if (first) {
      suppressClickUntil.current = 0;
      changeSession(canStart(touch, enabled) ? { phase: 'pending', startExpanded: expanded } : { phase: 'idle' });
    }
    if (touch.touches.length > 1) {
      changeSession({ phase: 'idle' });
      cancel();
      return;
    }
    let current = sessionRef.current;
    if (canceled || event.type === 'touchcancel') {
      if (current.phase === 'dragging') {
        suppressClickUntil.current = Date.now() + 400;
        settle(current, current.startExpanded);
      } else changeSession({ phase: 'idle' });
      return;
    }
    current = recognize(current, dx, dy, last, drawerRef.current);
    if (current.phase !== 'dragging') { changeSession(current); return; }
    current = { ...current, movement: dx };
    if (!last) {
      if (event.cancelable) event.preventDefault();
      changeSession(current);
      return;
    }
    suppressClickUntil.current = Date.now() + 400;
    // use-gesture computes release velocity only for recent movement (Engine's 32ms window).
    const flick = vx >= 0.5;
    const targetExpanded = flick ? direction > 0 : offset(current) > current.width / 2;
    settle(current, targetExpanded);
    onExpandedChange(targetExpanded);
  }, {
    target: layoutRef,
    enabled,
    pointer: { touch: true, keys: false },
    eventOptions: { passive: false },
    preventScroll: false,
  });

  useLayoutEffect(() => {
    if (session.phase !== 'dragging' || session.width !== 0) return;
    const width = drawerRef.current?.getBoundingClientRect().width ?? 0;
    if (width > 0) changeSession({ ...session, width });
  }, [session, drawerRef]);

  useEffect(() => {
    const current = sessionRef.current;
    if (enabled && current.phase === 'settling' && current.targetExpanded === expanded) return;
    changeSession({ phase: 'idle' });
  }, [enabled, expanded]);
  useEffect(() => {
    if (session.phase !== 'settling') return;
    const frame = requestAnimationFrame(() => {
      const current = sessionRef.current;
      if (current.phase === 'settling') changeSession({ ...current, offset: current.targetExpanded ? current.width : 0 });
    });
    const timer = window.setTimeout(() => changeSession({ phase: 'idle' }), 220);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [session.phase]);
  useEffect(() => {
    const layout = layoutRef.current;
    const suppress = (event: MouseEvent) => {
      if (event.detail > 0 && Date.now() < suppressClickUntil.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClickUntil.current = 0;
      }
    };
    const interrupt = () => changeSession({ phase: 'idle' });
    const multipleTouches = (event: TouchEvent) => { if (event.touches.length > 1) interrupt(); };
    // Safari needs a non-passive move listener before touchstart (pmndrs/use-gesture#685).
    const keepMovesCancelable = () => undefined;
    if (enabled) layout?.addEventListener('touchmove', keepMovesCancelable, { passive: false });
    layout?.addEventListener('click', suppress, true);
    layout?.addEventListener('touchstart', multipleTouches, true);
    window.addEventListener('resize', interrupt);
    window.addEventListener('blur', interrupt);
    return () => {
      layout?.removeEventListener('touchmove', keepMovesCancelable);
      layout?.removeEventListener('click', suppress, true);
      layout?.removeEventListener('touchstart', multipleTouches, true);
      window.removeEventListener('resize', interrupt);
      window.removeEventListener('blur', interrupt);
    };
  }, [enabled, layoutRef]);

  const dragging = enabled && session.phase === 'dragging';
  const swiping = enabled && (session.phase === 'dragging' || session.phase === 'settling');
  const pixels = session.phase === 'dragging' ? offset(session) : session.phase === 'settling' ? session.offset : 0;
  const width = session.phase === 'dragging' || session.phase === 'settling' ? session.width : 0;
  const style: DragStyle = swiping ? {
    '--sidebar-drag-offset': `${pixels}px`,
    '--sidebar-drag-progress': width ? pixels / width : 0,
  } : {};
  return { visible: expanded || swiping, dragging, swiping, style };
}
