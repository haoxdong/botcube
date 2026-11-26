// The Agent Computer as Windows 11 (ADR 0093): Fluent UI parts on a virtual 1280x720 screen, windows from react-rnd.
// Fluent and react-rnd load only with this lazy chunk (the dependency-cruiser rule `computer-only-packages`).
import { FluentProvider, makeStyles, mergeClasses, tokens, useTimeout, webLightTheme } from '@fluentui/react-components';
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { dropZone, zoneRect, type Zone } from './windows-snap';
import { Taskbar, TASKBAR, TASKBAR_APPS } from './windows-taskbar';
import { TITLE_BAR, WindowFrame, type DesktopWindow, type DockApp, type Life, type Rect } from './windows-window';

export type { DesktopWindow, DockApp } from './windows-window';

/** A resize's quiet time, in ms, before the desktop takes its new size. */
const RESTS = 150;
/** The virtual screen: Windows draws at its own sizes on 1280x720, scaled to fit the pane. */
const SCREEN = { width: 1280, height: 720 };
/** Where windows go: the screen above the taskbar. */
const AREA = { width: SCREEN.width, height: SCREEN.height - TASKBAR };
const PHONE = '(max-width: 640px)';

/** Where each window opens. The browser's content box is 16:9, as the live view's screen is. */
const PLACES: Record<DockApp, Rect> = {
  Files: { x: 40, y: 24, width: 760, height: 470 },
  Chromium: { x: 440, y: 44, width: 800, height: 450 + TITLE_BAR },
  Terminal: { x: 200, y: 330, width: 700, height: 320 },
};

// Stock Fluent (ADR 0093): its parts keep their own look and theme; these rules only place them and draw the desktop's
// own surfaces, from Fluent's tokens.
const useStyles = makeStyles({
  screen: {
    position: 'absolute',
    top: 0,
    left: 0,
    overflow: 'hidden',
    userSelect: 'none',
    // The wallpaper: Windows 11's light bloom.
    background:
      'radial-gradient(900px 520px at 68% 58%, rgba(255,255,255,0.8) 0%, transparent 55%), radial-gradient(1100px 700px at 30% 85%, #5b9ff0 0%, transparent 60%), linear-gradient(160deg, #d3e6fb 0%, #8ab8ef 55%, #2f6fd0 100%)',
    transformOrigin: '0 0',
  },
  phoneScreen: { width: '100%', height: '100%' },
  area: { position: 'absolute', top: 0, left: 0, right: 0 },
  // Where a dragged window will snap, as Windows 11 outlines it under the window while the pointer holds an edge.
  snapHint: {
    position: 'absolute',
    boxSizing: 'border-box',
    padding: tokens.spacingHorizontalXS,
    pointerEvents: 'none',
    animationName: { from: { opacity: 0 }, to: { opacity: 1 } },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveDecelerateMax,
  },
  snapHintFill: {
    height: '100%',
    boxSizing: 'border-box',
    borderRadius: tokens.borderRadiusXLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStrokeAlpha}`,
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    backdropFilter: 'blur(30px)',
    boxShadow: tokens.shadow28,
  },
});

/**
 * Where a window is in its life. `opening` plays its open motion (a window open when the desktop appears arrives with
 * it); `closing` plays its close motion, still mounted.
 */
export type WindowPhase = 'opening' | 'open' | 'minimised' | 'closing' | 'closed';
type DesktopEntry = { app: DockApp; phase: WindowPhase };

const isOpen = (phase: WindowPhase) => phase === 'open' || phase === 'opening';
const lifeOf = (phase: WindowPhase): Life => (isOpen(phase) ? 'open' : phase === 'minimised' ? 'minimised' : 'closed');
const frontOf = (stack: readonly DesktopEntry[]) => stack.findLast(({ phase }) => isOpen(phase))?.app ?? null;

/**
 * The desktop's windows, bottom to top: one list owns opening, minimising, closing and focus, so the taskbar, the title
 * bars and Take over all raise a window through `raise`. `first` starts in front; Files starts closed otherwise.
 * `onFrontChange` hears the app in front change, or null when no window is open.
 */
export function useDesktopWindows(first: DockApp, onFrontChange?: (app: DockApp | null) => void) {
  const [stack, setStack] = useState<readonly DesktopEntry[]>(() => [
    ...TASKBAR_APPS.filter((app) => app !== first).map((app): DesktopEntry => ({ app, phase: app === 'Files' ? 'closed' : 'open' })),
    { app: first, phase: 'open' },
  ]);
  // The windows Show desktop put away, for a second press to bring back.
  const [shown, setShown] = useState<readonly DockApp[] | null>(null);
  const front = frontOf(stack);
  const commit = (next: readonly DesktopEntry[]) => {
    const top = frontOf(next);
    if (top !== front) onFrontChange?.(top);
    setStack(next);
  };
  const phaseOf = (app: DockApp) => stack.find((entry) => entry.app === app)?.phase ?? 'closed';
  return {
    stack,
    front,
    phaseOf,
    raise(app: DockApp) {
      setShown(null);
      if (app === front) return;
      const phase = phaseOf(app);
      commit([...stack.filter((entry) => entry.app !== app), { app, phase: isOpen(phase) ? phase : phase === 'minimised' ? 'open' : 'opening' }]);
    },
    putAway(app: DockApp, phase: 'minimised' | 'closing') {
      commit(stack.map((entry) => (entry.app === app ? { app, phase } : entry)));
    },
    /** The close motion is over: the window may unmount. */
    closed(app: DockApp) {
      setStack((all) => all.map((entry) => (entry.app === app && entry.phase === 'closing' ? { app, phase: 'closed' } : entry)));
    },
    /** Show desktop minimises every open window; pressed again, it brings back those it put away. */
    showDesktop() {
      setShown(shown === null ? stack.filter(({ phase }) => isOpen(phase)).map(({ app }) => app) : null);
      commit(stack.map((entry): DesktopEntry => {
        if (shown === null) return isOpen(entry.phase) ? { ...entry, phase: 'minimised' } : entry;
        return shown.includes(entry.app) && entry.phase === 'minimised' ? { ...entry, phase: 'open' } : entry;
      }));
    },
  };
}

type DesktopWindows = ReturnType<typeof useDesktopWindows>;

const subscribePhone = (change: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
};

/** Phones: one window at a time above the taskbar, at the phone's own size. */
function usePhone() {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
}

/**
 * The screen's scale, filling its box's width but never past its own size. Each frame of a resize sets only
 * `--screen-scale` on the box, so the desktop is not drawn again while the chat beside it slides; the scale reaches React,
 * for react-rnd's drags, once the resize rests. A phone's windows fill the box in CSS, so there nothing is measured.
 */
function useScale(box: RefObject<HTMLElement | null>, measures: boolean) {
  const [scale, setScale] = useState(1);
  const [later, cancel] = useTimeout();
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || !measures) return;
    const measure = (atOnce: boolean) => {
      const width = element.clientWidth;
      if (width === 0) return;
      const next = Math.min(1, width / SCREEN.width);
      element.style.setProperty('--screen-scale', String(next));
      cancel();
      if (atOnce) setScale(next);
      else later(() => setScale(next), RESTS);
    };
    measure(true);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(element);
    return () => { observer.disconnect(); cancel(); };
  }, [box, measures, later, cancel]);
  return scale;
}

export interface WindowsDesktopProps {
  windows: readonly DesktopWindow[];
  /** Its windows' order and lives, from `useDesktopWindows` in the computer that owns them. */
  desktop: DesktopWindows;
  interactive: boolean;
  /** Named on Start, by the agent's avatar. */
  agentName?: string | undefined;
  /** The chat's Stop, on Start's Power menu; null while there is no run to stop. */
  onStop?: (() => void) | null;
  /** The computer is awake, so its network is up. */
  online?: boolean;
}

/**
 * Windows 11: each app in its own window, over the wallpaper, above the taskbar, in `desktop`'s order. Windows move,
 * resize, minimise and snap only while `interactive` (the sheet); otherwise the desktop is a preview. Every window
 * stays mounted, minimised or closed, so the live view stays connected under the others.
 */
export function WindowsDesktop({ windows, desktop, interactive, agentName, onStop = null, online = false }: WindowsDesktopProps) {
  const styles = useStyles();
  const box = useRef<HTMLDivElement>(null);
  const phoneLayout = usePhone() && interactive;
  const scale = useScale(box, !phoneLayout);
  const { stack, front: active, raise, putAway } = desktop;
  // Each snapped window's zone; 'max' is maximised. Unsnapped, a window keeps its own place in `rects`.
  const [zones, setZones] = useState<Record<DockApp, Zone | null>>({ Files: null, Chromium: null, Terminal: null });
  const [snapping, setSnapping] = useState<DockApp | null>(null);
  // The zone a window being dragged would snap to, outlined until it drops.
  const [hint, setHint] = useState<Zone | null>(null);
  const [rects, setRects] = useState(PLACES);
  const screen = useRef<HTMLDivElement>(null);
  // Windows' own flyouts mount here, under the desktop's light theme, whatever the app's theme.
  const [system, setSystem] = useState<HTMLElement | null>(null);
  const placeOf = (app: DockApp): Rect => {
    const zone = zones[app];
    return zone === null ? rects[app] : zoneRect(zone, AREA);
  };
  const snap = (app: DockApp, zone: Zone | null) => {
    if (phoneLayout) return;
    setSnapping(app);
    setZones((all) => ({ ...all, [app]: zone }));
  };
  const toggleMax = (app: DockApp) => snap(app, zones[app] === 'max' ? null : 'max');
  // Moved or resized, a window leaves its snap; dragged off one, it takes back its own size, as Windows does.
  const reshape = (app: DockApp, next: Partial<Rect>) => {
    setRects((all) => ({ ...all, [app]: { ...all[app], ...next } }));
    setZones((all) => (all[app] === null ? all : { ...all, [app]: null }));
  };
  const zoneUnder = ({ clientX, clientY }: { clientX: number; clientY: number }) => {
    const area = screen.current?.getBoundingClientRect();
    return area === undefined ? null : dropZone({ x: (clientX - area.left) / scale, y: (clientY - area.top) / scale }, AREA);
  };
  // Let go: a window snaps to the zone outlined under it; otherwise it stays where it was dragged, if it moved.
  const drop = (app: DockApp, at: { x: number; y: number }) => {
    setHint(null);
    if (hint !== null) snap(app, hint);
    else if (at.x !== placeOf(app).x || at.y !== placeOf(app).y) reshape(app, at);
  };
  const pick = (app: DockApp) => {
    if (!phoneLayout && app === active) putAway(app, 'minimised');
    else raise(app);
  };
  const screenStyle: CSSProperties = phoneLayout ? {} : { width: SCREEN.width, height: SCREEN.height, transform: 'scale(var(--screen-scale, 1))' };
  return (
    // A preview takes no focus or presses: the sheet is where the desktop is used.
    <div ref={box} className="agent-computer-windows" data-layout={phoneLayout ? 'phone' : 'desktop'} inert={!interactive}>
      {/* Its className reaches every Portal under it (styles.css relies on that); its place, inline, does not. */}
      <FluentProvider theme={webLightTheme} className="agent-computer-fluent" style={{ position: 'absolute', inset: 0 }}>
        <div ref={screen} className={mergeClasses(styles.screen, phoneLayout && styles.phoneScreen)} style={screenStyle}>
          <div className={styles.area} style={{ height: phoneLayout ? `calc(100% - ${TASKBAR}px)` : AREA.height }}>
            {hint !== null && (
              <div key={hint} data-snap-hint={hint} className={styles.snapHint} style={{ ...rectStyle(zoneRect(hint, AREA)), zIndex: stack.length }}>
                <div className={styles.snapHintFill} />
              </div>
            )}
            {windows.map((win) => {
              const { app } = win;
              const layer = stack.findIndex((entry) => entry.app === app) + 1;
              const phase = desktop.phaseOf(app);
              if (phase === 'closed' && win.keepMounted !== true) return null;
              const full = phoneLayout || zones[app] === 'max';
              return (
                <WindowFrame
                  key={app}
                  window={win}
                  life={lifeOf(phase)}
                  opening={phase === 'opening'}
                  active={app === active}
                  // On a phone only the window in front shows.
                  away={!isOpen(phase) || (phoneLayout && app !== active)}
                  place={placeOf(app)}
                  full={full}
                  snapped={zones[app] !== null}
                  scale={scale}
                  interactive={interactive}
                  layer={phase === 'closing' ? stack.length + 1 : layer}
                  snapping={snapping === app}
                  phone={phoneLayout}
                  system={system}
                  onRaise={() => raise(app)}
                  onPlace={(next) => reshape(app, next)}
                  onDrop={(at) => drop(app, at)}
                  onUnsnap={(at) => reshape(app, at)}
                  onDragAt={(pointer) => { const zone = zoneUnder(pointer); setHint((now) => (now === zone ? now : zone)); }}
                  onSnap={(zone) => snap(app, zone)}
                  onRestore={() => snap(app, null)}
                  onSnapped={() => setSnapping((now) => (now === app ? null : now))}
                  onMinimise={() => putAway(app, 'minimised')}
                  onMaximise={() => toggleMax(app)}
                  onClose={() => putAway(app, 'closing')}
                  onClosed={() => desktop.closed(app)}
                />
              );
            })}
          </div>
          <Taskbar
            windows={windows}
            life={{ Files: lifeOf(desktop.phaseOf('Files')), Chromium: lifeOf(desktop.phaseOf('Chromium')), Terminal: lifeOf(desktop.phaseOf('Terminal')) }}
            active={active}
            phone={phoneLayout}
            agentName={agentName}
            onStop={onStop}
            online={online}
            onPick={pick}
            onOpen={raise}
            onClose={(app) => putAway(app, 'closing')}
            onShowDesktop={desktop.showDesktop}
          />
        </div>
        <div ref={setSystem} />
      </FluentProvider>
    </div>
  );
}

const rectStyle = ({ x, y, width, height }: Rect): CSSProperties => ({ left: x, top: y, width, height });
