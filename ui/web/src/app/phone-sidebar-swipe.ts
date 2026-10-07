import { useDrag } from '@use-gesture/react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

type DragSession =
  | { phase: 'idle' }
  | { phase: 'pending'; startExpanded: boolean }
  | { phase: 'dragging'; startExpanded: boolean; movement: number; width: number }
  | { phase: 'settling'; targetExpanded: boolean; width: number; offset: number };
const IDLE: DragSession = { phase: 'idle' };
type DragStyle = CSSProperties & Record<`--${string}`, string | number>;
type Options = {
  layoutRef: RefObject<HTMLDivElement | null>;
  drawerRef: RefObject<HTMLElement | null>;
  /** The screen edge the panel enters from: a swipe away from it opens the panel, a swipe back toward it closes it. */
  side: 'left' | 'right';
  /** Names the style's `--<name>-drag-offset` and `--<name>-drag-progress`. */
  name: string;
  enabled: boolean;
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
};

function excludesSwipe(target: EventTarget | null, drawer: HTMLElement | null) {
  if (!(target instanceof Element)) return true;
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return true;
  if (window.getSelection()?.toString()) return true;
  // An open sheet, such as the sign-in sheet or the Agent Profile over the chat, keeps the panels behind it shut.
  if (Array.from(document.querySelectorAll('[role="dialog"]')).some((sheet) => sheet !== drawer && !sheet.closest('[hidden]'))) return true;
  for (let node: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement; node; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

/** +1 when the panel opens with a rightward swipe (it enters from the left), -1 when it opens leftward. */
function opening(side: Options['side']) {
  return side === 'left' ? 1 : -1;
}

function offset(session: Extract<DragSession, { phase: 'dragging' }>, side: Options['side']) {
  return Math.max(0, Math.min(session.width, (session.startExpanded ? session.width : 0) + opening(side) * session.movement));
}

// The 20px at the panel's own edge stays Safari's, whose edge swipe goes back or forward.
function canStart(event: TouchEvent, enabled: boolean, side: Options['side'], drawer: HTMLElement | null) {
  const x = event.changedTouches[0]?.clientX ?? 0;
  const clearOfEdge = side === 'left' ? x > 20 : x < window.innerWidth - 20;
  return enabled && event.touches.length === 1 && clearOfEdge && !excludesSwipe(event.target, drawer);
}

function recognize(session: DragSession, dx: number, dy: number, last: boolean, drawer: HTMLElement | null, side: Options['side']): DragSession {
  if (session.phase !== 'pending') return session;
  if (last || (Math.abs(dy) >= 8 && Math.abs(dy) >= Math.abs(dx))) return IDLE;
  if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy) * 1.5) return session;
  const towardOpen = opening(side) * dx;
  if (session.startExpanded ? towardOpen >= 0 : towardOpen <= 0) return IDLE;
  return { phase: 'dragging', startExpanded: session.startExpanded, movement: dx,
    width: session.startExpanded ? drawer?.getBoundingClientRect().width ?? 0 : 0 };
}

/**
 * A phone panel that follows a sideways swipe across `layoutRef` and snaps open or shut on release: the app sidebar
 * from the left, the Agent Profile from the right.
 */
export function usePhoneSidebarSwipe({ layoutRef, drawerRef, side, name, enabled, expanded, onExpandedChange }: Options) {
  const sessionRef = useRef<DragSession>(IDLE);
  const [session, setSession] = useState<DragSession>(sessionRef.current);
  const suppressClickUntil = useRef(0);
  const changeSession = (next: DragSession) => {
    sessionRef.current = next;
    // A touch that has not moved sideways yet renders as no touch. Rendering it would re-run use-gesture's binding
    // effect inside the touchstart's dispatch, and the other panel's listener on the same layout would miss it.
    setSession(next.phase === 'pending' ? IDLE : next);
  };
  const settle = (current: Extract<DragSession, { phase: 'dragging' }>, targetExpanded: boolean) => {
    changeSession({ phase: 'settling', targetExpanded, width: current.width, offset: offset(current, side) });
  };
  useDrag(({ event, first, last, movement: [dx, dy], velocity: [vx], direction: [direction], canceled, cancel }) => {
    if (!('touches' in event)) return;
    const touch = event;
    if (first) {
      suppressClickUntil.current = 0;
      changeSession(canStart(touch, enabled, side, drawerRef.current) ? { phase: 'pending', startExpanded: expanded } : IDLE);
    }
    if (touch.touches.length > 1) {
      changeSession(IDLE);
      cancel();
      return;
    }
    let current = sessionRef.current;
    if (canceled || event.type === 'touchcancel') {
      if (current.phase === 'dragging') {
        suppressClickUntil.current = Date.now() + 400;
        settle(current, current.startExpanded);
      } else changeSession(IDLE);
      return;
    }
    current = recognize(current, dx, dy, last, drawerRef.current, side);
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
    const targetExpanded = flick ? opening(side) * direction > 0 : offset(current, side) > current.width / 2;
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
    changeSession(IDLE);
  }, [enabled, expanded]);
  useEffect(() => {
    if (session.phase !== 'settling') return;
    const frame = requestAnimationFrame(() => {
      const current = sessionRef.current;
      if (current.phase === 'settling') changeSession({ ...current, offset: current.targetExpanded ? current.width : 0 });
    });
    const timer = window.setTimeout(() => changeSession(IDLE), 220);
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
    const interrupt = () => changeSession(IDLE);
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
  const pixels = session.phase === 'dragging' ? offset(session, side) : session.phase === 'settling' ? session.offset : 0;
  const width = session.phase === 'dragging' || session.phase === 'settling' ? session.width : 0;
  const style: DragStyle = swiping ? {
    [`--${name}-drag-offset`]: `${pixels}px`,
    [`--${name}-drag-progress`]: width ? pixels / width : 0,
  } : {};
  /** Shuts the panel as a released swipe does, so it stays shown while what covers it slides back. */
  const close = () => {
    const width = drawerRef.current?.getBoundingClientRect().width ?? 0;
    if (enabled && expanded && width > 0) changeSession({ phase: 'settling', targetExpanded: false, width, offset: width });
    onExpandedChange(false);
  };
  return { visible: expanded || swiping, dragging, swiping, style, close };
}
