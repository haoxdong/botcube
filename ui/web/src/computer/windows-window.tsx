// One Agent Computer window: react-rnd moves and resizes it, stock Fluent draws its frame (ADR 0093).
import { Button, FluentProvider, makeStyles, Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger, mergeClasses, Tab, TabList, Text, Tooltip, tokens, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { Add16Regular, ChevronDown16Regular, Dismiss16Regular, Maximize16Regular, SquareMultiple16Regular, Subtract16Regular } from '@fluentui/react-icons';
import { useId, type CSSProperties, type ReactNode, type TransitionEvent } from 'react';
import { Rnd } from 'react-rnd';
import chromium from './app-icons/chromium.svg';
import folder from './app-icons/file-folder-3d.png';
import terminal from './app-icons/windows-terminal.svg';
import { SnapLayouts, type Zone } from './windows-snap';

/** The computer's apps, each in its own window and on the taskbar. */
export type DockApp = 'Chromium' | 'Terminal' | 'Files';

export const TITLE_BAR = 40;
/** A maximised window, and every window on a phone: the whole area above the taskbar, in CSS rather than numbers. */
const FILL = { size: { width: '100%', height: '100%' }, position: { x: 0, y: 0 } };
// Windows 11's folder yellow: Fluent's icons ship no coloured folder.
export const FOLDER = '#f8c246';

export interface Rect { x: number; y: number; width: number; height: number }
export type Life = 'open' | 'minimised' | 'closed';

export interface DesktopWindow {
  app: DockApp;
  title: string;
  /** A dark window, as Windows Terminal draws itself: Fluent's own dark theme. */
  dark?: boolean;
  /** Windows Terminal's tab strip: the one session as a tab, then + and ⌄, which stay disabled and say why. */
  tabs?: { disabledNote: string };
  /** Mounted even while closed, as the live view stays connected. */
  keepMounted?: boolean;
  children: ReactNode;
}

// Stock Fluent (ADR 0093): its parts keep their own look and theme; these rules only place them and draw the desktop's
// own surfaces, from Fluent's tokens.
const useStyles = makeStyles({
  frame: { width: '100%', height: '100%' },
  window: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    // The provider around it draws no box (display: contents), so the window paints its theme's surface itself.
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusXLarge,
    // Windows 11: every window has a hairline edge and a shadow, deeper on the active one.
    boxShadow: `${tokens.shadow28}, 0 0 0 ${tokens.strokeWidthThin} ${tokens.colorNeutralStroke2}`,
    transitionProperty: 'box-shadow',
    transitionDuration: tokens.durationNormal,
  },
  opening: {
    animationName: { from: { opacity: 0, transform: 'scale(0.92)' }, to: { opacity: 1, transform: 'none' } },
    animationDuration: tokens.durationNormal,
    animationTimingFunction: tokens.curveDecelerateMax,
    animationFillMode: 'both',
  },
  windowActive: { boxShadow: `${tokens.shadow64}, 0 0 0 ${tokens.strokeWidthThin} ${tokens.colorNeutralStroke2}` },
  windowFull: { borderRadius: 0 },
  content: {
    position: 'relative',
    flex: 1,
    minHeight: 0,
  },
  // Mica: the title area tints while its window is active.
  titleBar: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    height: `${TITLE_BAR}px`,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalXS,
    gap: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground3,
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationNormal,
  },
  titleBarActive: { backgroundColor: tokens.colorNeutralBackground2 },
  title: { minWidth: 0 },
  tabs: { display: 'flex', alignItems: 'center', minWidth: 0, alignSelf: 'stretch' },
  tabList: { minWidth: 0 },
  sessionTab: { minWidth: 0, maxWidth: '240px' },
  captions: { display: 'flex', flexShrink: 0, marginLeft: 'auto' },
  appIcon: { display: 'block', flexShrink: 0, backgroundPosition: 'center', backgroundRepeat: 'no-repeat', backgroundSize: 'contain' },
});

/** Each app's own icon, pinned in `app-icons/` with its licence (botcube/NOTICE). */
const APP_ICON: Record<DockApp, string | { src: string }> = { Files: folder, Chromium: chromium, Terminal: terminal };

export function AppIcon({ app, size }: { app: DockApp; size: 16 | 24 }) {
  const styles = useStyles();
  const image = APP_ICON[app];
  // Decorative, beside the app's name: a background, so no picture is read out or taken for the screen's own.
  return <span className={styles.appIcon} style={{ width: size, height: size, backgroundImage: `url("${typeof image === 'string' ? image : image.src}")` }} aria-hidden="true" />;
}

interface TitleBarProps {
  window: DesktopWindow;
  /** Where Windows' own flyouts open, in the system's light theme rather than the app's. */
  system: HTMLElement | null;
  /** The id of the window's contents, which Terminal's session tab controls. */
  panel: string;
  active: boolean;
  full: boolean;
  /** Snapped to a zone or maximised: Restore puts it back where it was. */
  snapped: boolean;
  phone: boolean;
  onMinimise: () => void;
  onMaximise: () => void;
  onRestore: () => void;
  onSnap: (zone: Zone) => void;
  onClose: () => void;
}

/** The app's icon and title (Terminal's session tab), the caption buttons, and Windows' window menu on a right click. */
function TitleBar({ window: { app, title, tabs }, system, panel, active, full, snapped, phone, onMinimise, onMaximise, onRestore, onSnap, onClose }: TitleBarProps) {
  const styles = useStyles();
  return (
    <Menu openOnContext>
      <MenuTrigger disableButtonEnhancement>
        <div className={mergeClasses('window-titlebar', styles.titleBar, active && styles.titleBarActive)} onDoubleClick={onMaximise}>
          {tabs === undefined ? (
            <>
              {/* One document: the app's icon and title, as a Windows 11 title bar draws them. */}
              <AppIcon app={app} size={16} />
              <Text size={200} truncate wrap={false} className={styles.title}>{title}</Text>
            </>
          ) : (
            // Windows Terminal: its session as a tab with its close, then New tab and the profiles menu. The Tooltip is
            // inaccessible as a description Tooltip would portal on the server; aria-description says the same.
            <span className={styles.tabs}>
              <TabList className={styles.tabList} size="small" selectedValue="session" aria-label={`${app} tabs`}>
                <Tab id={`${panel}-tab`} aria-controls={panel} className={styles.sessionTab} value="session" icon={<AppIcon app={app} size={16} />}>{title}</Tab>
              </TabList>
              <Button appearance="subtle" size="small" aria-label={`Close ${title}`} icon={<Dismiss16Regular />} onClick={onClose} />
              <Tooltip content={tabs.disabledNote} relationship="inaccessible">
                <Button appearance="subtle" size="small" disabledFocusable aria-label="New tab" aria-description={tabs.disabledNote} icon={<Add16Regular />} />
              </Tooltip>
              <Tooltip content={tabs.disabledNote} relationship="inaccessible">
                <Button appearance="subtle" size="small" disabledFocusable aria-label="Open a profile" aria-description={tabs.disabledNote} icon={<ChevronDown16Regular />} />
              </Tooltip>
            </span>
          )}
          <span className={styles.captions}>
            <Button appearance="subtle" aria-label={`Minimise ${app}`} icon={<Subtract16Regular />} onClick={onMinimise} />
            <SnapLayouts app={app} mountNode={system} enabled={!phone} label={full ? `Restore ${app}` : `Maximise ${app}`} icon={full ? <SquareMultiple16Regular /> : <Maximize16Regular />} onMaximise={onMaximise} onSnap={onSnap} />
            <Button appearance="subtle" aria-label={`Close ${app}`} icon={<Dismiss16Regular />} onClick={onClose} />
          </span>
        </div>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem icon={<SquareMultiple16Regular />} disabled={phone || !snapped} onClick={onRestore}>Restore</MenuItem>
          <MenuItem icon={<Subtract16Regular />} onClick={onMinimise}>Minimise</MenuItem>
          <MenuItem icon={<Maximize16Regular />} disabled={full} onClick={() => onSnap('max')}>Maximise</MenuItem>
          <MenuDivider />
          <MenuItem icon={<Dismiss16Regular />} onClick={onClose}>Close</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

export interface WindowFrameProps {
  window: DesktopWindow;
  life: Life;
  /** Opened after the desktop appeared: it plays its open motion. */
  opening: boolean;
  active: boolean;
  away: boolean;
  place: Rect;
  full: boolean;
  snapped: boolean;
  scale: number;
  interactive: boolean;
  layer: number;
  snapping: boolean;
  /** The phone layout: windows fill the screen, so they neither snap nor restore. */
  phone: boolean;
  /** Where Windows' own flyouts open, in the system's light theme rather than the app's. */
  system: HTMLElement | null;
  onRaise: () => void;
  onPlace: (place: Partial<Rect>) => void;
  /** Let go after a drag by its title bar, at `at`: the desktop snaps it if the pointer held an edge. */
  onDrop: (at: { x: number; y: number }) => void;
  /** A snapped window is being dragged: it leaves its zone. */
  onUnsnap: (at: { x: number; y: number }) => void;
  /** The pointer dragging the title bar is at this client point. */
  onDragAt: (pointer: { clientX: number; clientY: number }) => void;
  onSnap: (zone: Zone) => void;
  onRestore: () => void;
  /** The snap's motion is over, or the user took the window: it moves without easing again. */
  onSnapped: () => void;
  onMinimise: () => void;
  onMaximise: () => void;
  onClose: () => void;
  /** The close motion is over: the window may unmount. */
  onClosed: () => void;
}

/**
 * How a window goes away, or comes back, in Fluent 2 motion: decelerate in, accelerate out. Closing is opening in reverse,
 * on curveEasyEase (an accelerate curve leaves the change to the last frames, so it reads as a cut); minimised, or behind
 * on a phone, a window scales back and fades.
 */
function awayStyle(away: boolean, life: Life): CSSProperties {
  if (!away) return { transform: 'none', opacity: 1, transition: `transform ${tokens.durationSlow} ${tokens.curveDecelerateMax}, opacity ${tokens.durationNormal} ${tokens.curveDecelerateMax}` };
  const curve = life === 'closed' ? tokens.curveEasyEase : tokens.curveAccelerateMax;
  const { durationNormal: time } = tokens;
  return {
    transform: life === 'closed' ? 'scale(0.92)' : 'scale(0.96)',
    opacity: 0,
    visibility: 'hidden',
    transition: `transform ${time} ${curve}, opacity ${time} ${curve}, visibility 0s ${time}`,
  };
}

/** One window: react-rnd moves and resizes it (a full one fills the area), Fluent draws its frame in the window's own theme. */
export function WindowFrame({ window: win, life, opening, active, away, place, full, snapped, scale, interactive, layer, snapping, phone, system, onRaise, onPlace, onDrop, onUnsnap, onDragAt, onSnap, onRestore, onSnapped, onMinimise, onMaximise, onClose, onClosed }: WindowFrameProps) {
  const styles = useStyles();
  const panel = useId();
  const state = away ? (life === 'open' ? 'behind' : life) : 'open';
  const contents = (
    <div
      className={styles.frame}
      style={awayStyle(away, life)}
      onTransitionEnd={(event: TransitionEvent<HTMLElement>) => { if (event.target === event.currentTarget && event.propertyName === 'opacity' && life === 'closed') onClosed(); }}
    >
      {/* Each window in its own theme: Fluent draws its surface, in dark for Terminal. */}
      {/* Fluent copies a provider's className onto every Portal under it (Dialog, Menu, Tooltip), so the provider
          carries the theme and styles.css's shield alone, and the window is the div inside it; an inline style is not copied. */}
      <FluentProvider theme={win.dark === true ? webDarkTheme : webLightTheme} className="agent-computer-fluent" style={{ display: 'contents' }}>
        <div className={mergeClasses('agent-computer-windows-window', styles.window, opening && styles.opening, active && styles.windowActive, full && styles.windowFull)}>
          <TitleBar window={win} system={system} panel={panel} active={active} full={full} snapped={snapped} phone={phone} onMinimise={onMinimise} onMaximise={onMaximise} onRestore={onRestore} onSnap={onSnap} onClose={onClose} />
          {/* A session's tab controls the window's contents, its tab panel. */}
          <div className={styles.content} {...(win.tabs === undefined ? {} : { id: panel, role: 'tabpanel', 'aria-labelledby': `${panel}-tab` })}>{win.children}</div>
        </div>
      </FluentProvider>
    </div>
  );
  return (
    <Rnd
      data-window={win.app}
      data-state={state}
      scale={phone ? 1 : scale}
      // A full window fills the area in CSS, whatever react-rnd last placed or the desktop's scale. It stays in react-rnd,
      // fixed, so maximising, or the sheet opening from the preview, keeps the window and its live view mounted.
      size={full ? FILL.size : { width: place.width, height: place.height }}
      position={full ? FILL.position : { x: place.x, y: place.y }}
      onDragStart={onSnapped}
      onResizeStart={onSnapped}
      onDrag={(event, drag) => { if (snapped && !full) onUnsnap({ x: drag.x, y: drag.y }); onDragAt(pointerAt(event)); }}
      onDragStop={(_, drag) => onDrop({ x: drag.x, y: drag.y })}
      onResizeStop={(_, __, ___, delta, position) => onPlace({ x: position.x, y: position.y, width: place.width + delta.width, height: place.height + delta.height })}
      onTransitionEnd={(event: TransitionEvent<HTMLElement>) => { if (event.target === event.currentTarget) onSnapped(); }}
      disableDragging={full || !interactive}
      enableResizing={!full && interactive}
      bounds="parent"
      minWidth={380}
      minHeight={240}
      dragHandleClassName="window-titlebar"
      cancel=".fui-Button"
      style={{ zIndex: layer, pointerEvents: away ? 'none' : 'auto', transition: snapping ? `transform ${tokens.durationGentle} ${tokens.curveDecelerateMax}, width ${tokens.durationGentle} ${tokens.curveDecelerateMax}, height ${tokens.durationGentle} ${tokens.curveDecelerateMax}` : undefined }}
      onMouseDown={onRaise}
    >
      {contents}
    </Rnd>
  );
}

/** Where a drag's pointer is, in client pixels, from a mouse or a touch. */
function pointerAt(event: { clientX?: number; clientY?: number; changedTouches?: ArrayLike<{ clientX: number; clientY: number }> }) {
  const at = event.changedTouches?.[0] ?? event;
  return { clientX: at.clientX ?? Number.NaN, clientY: at.clientY ?? Number.NaN };
}
