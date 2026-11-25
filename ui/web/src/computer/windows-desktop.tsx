// The Agent Computer as Windows 11 (ADR 0093): Fluent UI parts on a virtual 1280x720 screen, windows from react-rnd.
// Fluent and react-rnd load only with this lazy chunk (the dependency-cruiser rule `computer-only-packages`).
import { FluentProvider, makeStyles, mergeClasses, Text, Toolbar, ToolbarToggleButton, tokens, webLightTheme } from '@fluentui/react-components';
import { Battery1020Regular, Grid24Filled, Search24Regular, Speaker220Regular, Wifi120Regular } from '@fluentui/react-icons';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { AppIcon, TITLE_BAR, WindowFrame, type DesktopWindow, type DockApp, type Life, type Rect } from './windows-window';

export type { DesktopWindow, DockApp } from './windows-window';

/** A resize's quiet time, in ms, before the desktop takes its new size. */
const RESTS = 150;
/** The virtual screen: Windows draws at its own sizes on 1280x720, scaled to fit the pane. */
const SCREEN = { width: 1280, height: 720 };
const TASKBAR = 48;
const PHONE = '(max-width: 640px)';

/** Where each window opens. The browser's content box is 16:9, as the live view's screen is. */
const PLACES: Record<DockApp, Rect> = {
  Files: { x: 40, y: 24, width: 760, height: 470 },
  Chromium: { x: 440, y: 44, width: 800, height: 450 + TITLE_BAR },
  Terminal: { x: 200, y: 330, width: 700, height: 320 },
};
const TASKBAR_APPS: readonly DockApp[] = ['Files', 'Chromium', 'Terminal'];

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
  taskbar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    display: 'flex',
    alignItems: 'center',
    height: `${TASKBAR}px`,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    backdropFilter: 'blur(40px)',
  },
  taskbarApps: { margin: '0 auto' },
  // Each app's button with its running pill beneath: wide and in the brand colour for the one in front.
  taskbarApp: { position: 'relative', display: 'flex' },
  running: {
    position: 'absolute',
    bottom: 0,
    left: '50%',
    width: '6px',
    height: '3px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralForeground3,
    transform: 'translateX(-50%)',
    pointerEvents: 'none',
    transitionProperty: 'width, opacity, background-color',
    transitionDuration: tokens.durationNormal,
  },
  runningActive: { width: '16px', backgroundColor: tokens.colorBrandForeground1 },
  notRunning: { width: 0, opacity: 0 },
  // Phones keep the taskbar to Start, the apps and the clock.
  desktopOnly: { display: 'none' },
  tray: { position: 'absolute', right: tokens.spacingHorizontalS, display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorNeutralForeground1 },
  trayIcons: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: `0 ${tokens.spacingHorizontalS}`, fontSize: '20px' },
  clock: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', padding: `0 ${tokens.spacingHorizontalS}` },
});


function Clock() {
  const styles = useStyles();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(tick);
  }, []);
  return (
    <Text size={200} className={styles.clock}>
      <span>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <span>{now.toLocaleDateString()}</span>
    </Text>
  );
}

/** The set without one app, or the same set when it lacks it. */
function without(set: ReadonlySet<DockApp>, app: DockApp): ReadonlySet<DockApp> {
  if (!set.has(app)) return set;
  const next = new Set(set);
  next.delete(app);
  return next;
}

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
 * The box the screen fills, measured as it resizes. Each frame of a resize sets only the screen's scale, `--screen-scale`
 * on the box, so the desktop is not drawn again while the chat beside it slides; its size reaches React once it rests.
 */
function useBoxSize(box: RefObject<HTMLElement | null>, fills: boolean) {
  const [size, setSize] = useState({ width: SCREEN.width, height: SCREEN.height });
  // A phone's windows fill the box at its own size, so there the size reaches React at once.
  const atOnce = useRef(fills);
  useLayoutEffect(() => { atOnce.current = fills; }, [fills]);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    let rest = 0;
    const settle = () => {
      const { clientWidth: width, clientHeight: height } = element;
      if (width > 0) setSize((prior) => (prior.width === width && prior.height === height ? prior : { width, height }));
    };
    const measure = () => {
      const width = element.clientWidth;
      if (width > 0) element.style.setProperty('--screen-scale', String(Math.min(1, width / SCREEN.width)));
      window.clearTimeout(rest);
      if (atOnce.current) settle();
      else rest = window.setTimeout(settle, RESTS);
    };
    measure();
    settle();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); window.clearTimeout(rest); };
  }, [box]);
  return size;
}

/**
 * Windows 11: each app in its own window, over the wallpaper, above the taskbar. `front` is the app the computer shows
 * in front; picking another calls `onFront`. Windows move, resize, minimise and snap only while `interactive` (the
 * sheet); otherwise the desktop is a preview. Every window stays mounted, minimised or closed, so the live view stays
 * connected under the others.
 */
export function WindowsDesktop({ windows, front, interactive, onFront }: { windows: readonly DesktopWindow[]; front: DockApp; interactive: boolean; onFront: (app: DockApp) => void }) {
  const styles = useStyles();
  const box = useRef<HTMLDivElement>(null);
  const phoneLayout = usePhone() && interactive;
  const boxSize = useBoxSize(box, phoneLayout);
  // The virtual screen scales to fill its box's width, never past its own size.
  const scale = Math.min(1, boxSize.width / SCREEN.width);
  const [life, setLife] = useState<Record<DockApp, Life>>(() => {
    const closed = (app: DockApp): Life => (app !== front && windows.some((win) => win.app === app && win.startsClosed === true) ? 'closed' : 'open');
    return { Files: closed('Files'), Chromium: closed('Chromium'), Terminal: closed('Terminal') };
  });
  // The windows already open when the desktop appears arrive with it: only a window opened later plays its open motion.
  const [arrived, setArrived] = useState<ReadonlySet<DockApp>>(() => new Set(TASKBAR_APPS.filter((app) => life[app] === 'open')));
  const [order, setOrder] = useState<DockApp[]>(() => [...TASKBAR_APPS.filter((app) => app !== front), front]);
  const [maxed, setMaxed] = useState<ReadonlySet<DockApp>>(new Set());
  const [snapping, setSnapping] = useState<DockApp | null>(null);
  const [rects, setRects] = useState(PLACES);
  // Windows playing their close motion, still mounted until it ends.
  const [closing, setClosing] = useState<ReadonlySet<DockApp>>(new Set());
  const [toward, setToward] = useState<Partial<Record<DockApp, { x: number; y: number }>>>({});
  const buttons = useRef<Partial<Record<DockApp, HTMLButtonElement | null>>>({});
  const screen = useRef<HTMLDivElement>(null);
  // The computer's own pick comes to the front, open.
  useLayoutEffect(() => {
    setLife((all) => (all[front] === 'open' ? all : { ...all, [front]: 'open' }));
    setOrder((list) => (list.at(-1) === front ? list : [...list.filter((item) => item !== front), front]));
  }, [front]);
  const open = order.filter((app) => life[app] === 'open');
  const active = open.at(-1) ?? null;
  const raise = (app: DockApp) => {
    setLife((all) => (all[app] === 'open' ? all : { ...all, [app]: 'open' }));
    setClosing((set) => without(set, app));
    setOrder((list) => (list.at(-1) === app ? list : [...list.filter((item) => item !== app), app]));
    onFront(app);
  };
  const putAway = (app: DockApp, next: Life) => {
    // A minimised window shrinks into its taskbar button, as Windows 11 does; a closed one plays its close motion first.
    if (next === 'closed') {
      setClosing((set) => new Set(set).add(app));
      setArrived((set) => without(set, app));
    }
    const button = next === 'minimised' ? buttons.current[app]?.getBoundingClientRect() : undefined;
    const area = screen.current?.getBoundingClientRect();
    const ratio = phoneLayout ? 1 : scale;
    if (button !== undefined && area !== undefined) setToward((all) => ({ ...all, [app]: { x: (button.left + button.width / 2 - area.left) / ratio, y: (button.top + button.height / 2 - area.top) / ratio } }));
    setLife((all) => ({ ...all, [app]: next }));
    const below = open.filter((item) => item !== app).at(-1);
    if (below !== undefined) onFront(below);
  };
  const toggleMax = (app: DockApp) => {
    setSnapping(app);
    setMaxed((set) => { const next = new Set(set); if (next.has(app)) next.delete(app); else next.add(app); return next; });
  };
  const pick = (app: DockApp) => {
    if (!phoneLayout && life[app] === 'open' && app === active) putAway(app, 'minimised');
    else raise(app);
  };
  const width = phoneLayout ? boxSize.width : SCREEN.width;
  const height = (phoneLayout ? boxSize.height : SCREEN.height) - TASKBAR;
  const screenStyle: CSSProperties = phoneLayout ? {} : { width: SCREEN.width, height: SCREEN.height, transform: 'scale(var(--screen-scale, 1))' };
  return (
    // A preview takes no focus or presses: the sheet is where the desktop is used.
    <div ref={box} className="agent-computer-windows" data-layout={phoneLayout ? 'phone' : 'desktop'} inert={!interactive}>
      {/* Its className reaches every Portal under it (styles.css relies on that); its place, inline, does not. */}
      <FluentProvider theme={webLightTheme} className="agent-computer-fluent" style={{ position: 'absolute', inset: 0 }}>
        <div ref={screen} className={mergeClasses(styles.screen, phoneLayout && styles.phoneScreen)} style={screenStyle}>
          <div className={styles.area} style={{ height }}>
            {windows.map((win) => {
              const { app } = win;
              if (life[app] === 'closed' && win.keepMounted !== true && !closing.has(app)) return null;
              const full = phoneLayout || maxed.has(app);
              const rect = rects[app];
              return (
                <WindowFrame
                  key={app}
                  window={win}
                  life={life[app]}
                  opening={!arrived.has(app)}
                  active={app === active}
                  // On a phone only the window in front shows.
                  away={life[app] !== 'open' || (phoneLayout && app !== active)}
                  place={full ? { x: 0, y: 0, width, height } : rect}
                  full={full}
                  toward={phoneLayout ? undefined : toward[app]}
                  scale={phoneLayout ? 1 : scale}
                  interactive={interactive}
                  layer={closing.has(app) ? order.length + 1 : order.indexOf(app) + 1}
                  snapping={snapping === app}
                  onRaise={() => { if (app !== active) raise(app); }}
                  onPlace={(next) => setRects((all) => ({ ...all, [app]: { ...all[app], ...next } }))}
                  onSnap={() => toggleMax(app)}
                  onSnapped={() => setSnapping((now) => (now === app ? null : now))}
                  onMinimise={() => putAway(app, 'minimised')}
                  onMaximise={() => { if (!phoneLayout) toggleMax(app); }}
                  onClose={() => putAway(app, 'closed')}
                  onClosed={() => setClosing((set) => without(set, app))}
                />
              );
            })}
          </div>
          <div className={styles.taskbar}>
            <Toolbar className={styles.taskbarApps} size="large" aria-label="Taskbar" checkedValues={{ app: active === null ? [] : [active] }}>
              <ToolbarToggleButton name="start" value="start" appearance="subtle" aria-label="Start" icon={<Grid24Filled color={tokens.colorBrandForeground1} />} />
              <ToolbarToggleButton name="search" value="search" appearance="subtle" aria-label="Search" icon={<Search24Regular />} className={mergeClasses(phoneLayout && styles.desktopOnly)} />
              {TASKBAR_APPS.map((app) => (
                <span key={app} className={styles.taskbarApp}>
                  <ToolbarToggleButton
                    ref={(node: HTMLButtonElement | null) => { buttons.current[app] = node; }}
                    name="app"
                    value={app}
                    appearance="subtle"
                    className="agent-computer-taskbar-app"
                    aria-label={app}
                    title={app}
                    icon={<AppIcon app={app} size={24} />}
                    onClick={() => pick(app)}
                  />
                  <span className={mergeClasses(styles.running, app === active && styles.runningActive, life[app] === 'closed' && styles.notRunning)} />
                </span>
              ))}
            </Toolbar>
            <span className={styles.tray}>
              <span className={mergeClasses(styles.trayIcons, phoneLayout && styles.desktopOnly)}><Wifi120Regular /><Speaker220Regular /><Battery1020Regular /></span>
              <Clock />
            </span>
          </div>
        </div>
      </FluentProvider>
    </div>
  );
}
