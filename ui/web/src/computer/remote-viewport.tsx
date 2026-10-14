import { usePinch } from '@use-gesture/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { zoomOf } from '../lib/utils';

type Viewport = { scale: number; x: number; y: number };
const HOME: Viewport = { scale: 1, x: 0, y: 0 };
// A finger held still this long is a remote press, so a long-press reaches the browser; a pinch's second finger comes sooner.
const HOLD_MS = 250;
type TouchOwnership = { kind: 'idle' } | { kind: 'pending'; touch: Touch; target: EventTarget; start: TouchEvent } | { kind: 'remote'; touch: Touch; target: EventTarget } | { kind: 'local' };

export function RemoteViewport({ expanded, interactive, sessionId, completeTouch, children }: {
  expanded: boolean;
  interactive: boolean;
  sessionId: string;
  children: ReactNode;
  completeTouch: (end: () => void) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(HOME);
  const current = useRef(HOME);
  const ownership = useRef<TouchOwnership>({ kind: 'idle' });
  const replaying = useRef(false);
  // A touch event of the adapter's own, which the guard lets through to the remote browser.
  const replay = (target: EventTarget, type: string, touches: Pick<TouchEvent, 'touches' | 'targetTouches' | 'changedTouches'>) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { touches: { value: touches.touches }, targetTouches: { value: touches.targetTouches }, changedTouches: { value: touches.changedTouches } });
    replaying.current = true;
    try {
      target.dispatchEvent(event);
    } finally {
      replaying.current = false;
    }
  };
  const release = () => {
    const owned = ownership.current;
    if (owned.kind !== 'remote') return;
    ownership.current = { kind: 'idle' };
    // DCV's touchcancel only stops the DOM event. An end releases its remote touch before local pinch begins.
    completeTouch(() => replay(owned.target, 'touchend', { touches: [] as unknown as TouchList, targetTouches: [] as unknown as TouchList, changedTouches: [owned.touch] as unknown as TouchList }));
  };
  usePinch(({ first, offset: [scale], origin, memo }) => {
    const box = host.current;
    if (!expanded || !interactive || box === null) return;
    const rect = box.getBoundingClientRect();
    // The pinch and the rect are in the screen's pixels, the translate in the box's own, which a zoomed app has fewer of.
    const zoom = zoomOf(box);
    const cx = (origin[0] - rect.left) / zoom;
    const cy = (origin[1] - rect.top) / zoom;
    const anchor = first ? { ...current.current, cx, cy } : memo as Viewport & { cx: number; cy: number };
    const ratio = scale / anchor.scale;
    const x = Math.min(0, Math.max((rect.width / zoom) * (1 - scale), cx - (anchor.cx - anchor.x) * ratio));
    const y = Math.min(0, Math.max((rect.height / zoom) * (1 - scale), cy - (anchor.cy - anchor.y) * ratio));
    current.current = { scale, x, y };
    setViewport(current.current);
    return anchor;
  }, { enabled: expanded && interactive, target: host, pointer: { touch: true }, eventOptions: { passive: false, capture: true }, scaleBounds: { min: 1, max: 4 }, rubberband: false, from: () => [current.current.scale, 0] });

  useLayoutEffect(() => {
    release();
    ownership.current = { kind: 'idle' };
    current.current = HOME;
    setViewport(HOME);
    if (!interactive && content.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }, [expanded, interactive, sessionId]);

  useLayoutEffect(() => {
    const box = host.current;
    if (box === null) return;
    let hold: ReturnType<typeof setTimeout> | undefined;
    const activate = (pending: Extract<TouchOwnership, { kind: 'pending' }>) => {
      clearTimeout(hold);
      ownership.current = { kind: 'remote', touch: pending.touch, target: pending.target };
      replay(pending.target, 'touchstart', pending.start);
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        release();
        ownership.current = { kind: 'local' };
        return;
      }
      const touch = event.touches[0];
      if (ownership.current.kind !== 'idle' || !touch || event.target === null) return;
      const pending = { kind: 'pending', touch, target: event.target, start: event } as const;
      ownership.current = pending;
      hold = setTimeout(() => { if (ownership.current === pending) activate(pending); }, HOLD_MS);
    };
    const move = (event: TouchEvent) => {
      const prior = ownership.current;
      if (prior.kind !== 'remote' && prior.kind !== 'pending') return;
      const touch = [...event.touches].find((candidate) => candidate.identifier === prior.touch.identifier);
      if (!touch) return;
      if (prior.kind === 'pending') {
        if (Math.hypot(touch.clientX - prior.touch.clientX, touch.clientY - prior.touch.clientY) <= 5) return;
        activate(prior);
      }
      ownership.current = { kind: 'remote', touch, target: prior.target };
    };
    const touchAllowed = (event: TouchEvent) => {
      if (event.type === 'touchstart' && interactive) start(event);
      if (event.type === 'touchmove') move(event);
      if (event.type === 'touchend' && ownership.current.kind === 'pending') activate(ownership.current);
      if (event.type === 'touchcancel') {
        release();
        ownership.current = { kind: 'local' };
      }
      const local = ownership.current.kind === 'local' || ownership.current.kind === 'pending';
      if (event.touches.length === 0) ownership.current = { kind: 'idle' };
      return interactive && !local;
    };
    const guard = (event: Event) => {
      if (replaying.current || (interactive && !expanded)) return;
      // A trackpad pinch arrives as a ctrl-wheel: it zooms this view, never the remote page as well.
      const pinch = event instanceof WheelEvent && event.ctrlKey;
      const allowed = event instanceof TouchEvent ? touchAllowed(event) : interactive && !pinch && ownership.current.kind !== 'local';
      if (allowed) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const events = ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'wheel', 'keydown', 'keyup'];
    for (const name of events) box.addEventListener(name, guard, { capture: true, passive: false });
    return () => {
      clearTimeout(hold);
      release();
      for (const name of events) box.removeEventListener(name, guard, true);
    };
  }, [interactive, expanded]);

  useEffect(() => {
    const box = host.current;
    if (box === null) return;
    const observer = new ResizeObserver(() => {
      current.current = HOME;
      setViewport(HOME);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  return <div ref={host} className="remote-viewport" data-scale={viewport.scale} style={{ touchAction: expanded ? 'none' : undefined }}>
    <div ref={content} className="remote-viewport-content" inert={!interactive} style={{ width: `${100 * viewport.scale}%`, height: `${100 * viewport.scale}%`, transform: `translate(${viewport.x}px, ${viewport.y}px)` }}>{children}</div>
    {!interactive && <div className="remote-viewport-shield" aria-hidden="true" />}
  </div>;
}
