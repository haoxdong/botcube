// One Agent Computer window: react-rnd moves and resizes it, stock Fluent draws its frame (ADR 0093).
import { Button, FluentProvider, makeStyles, mergeClasses, Text, tokens, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { Dismiss16Regular, Maximize16Regular, SquareMultiple16Regular, Subtract16Regular } from '@fluentui/react-icons';
import type { CSSProperties, ReactNode, TransitionEvent } from 'react';
import { Rnd } from 'react-rnd';
import chromium from './app-icons/chromium.svg';
import folder from './app-icons/file-folder-3d.png';
import terminal from './app-icons/windows-terminal.svg';

/** The computer's apps, each in its own window and on the taskbar. */
export type DockApp = 'Chrome' | 'Terminal' | 'Files';

export const TITLE_BAR = 40;
// Fluent 2 motion: decelerate in, accelerate out (its curveDecelerateMax and curveAccelerateMax).
const DECELERATE = 'cubic-bezier(0.1, 0.9, 0.2, 1)';
const ACCELERATE = 'cubic-bezier(0.9, 0.1, 1, 0.2)';
// Its curveEasyEase for close: an accelerate curve leaves the change to the last frames, so it reads as a cut.
const EASY_EASE = 'cubic-bezier(0.33, 0, 0.67, 1)';
// Windows 11's folder yellow: Fluent's icons ship no coloured folder.

export interface Rect { x: number; y: number; width: number; height: number }
export type Life = 'open' | 'minimised' | 'closed';

export interface DesktopWindow {
  app: DockApp;
  title: string;
  /** A dark window, as Windows Terminal draws itself: Fluent's own dark theme. */
  dark?: boolean;
  /** Not running until it is opened: closed, its contents unmount. */
  startsClosed?: boolean;
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
    // Today's Terminal at Windows Terminal's own size, until it is drawn in Fluent (PR (c)).
    '& .agent-computer-terminal': { fontSize: '14px', lineHeight: '20px' },
    '& .agent-computer-terminal-content': { padding: '6px 10px' },
  },
  phoneContent: { '& .agent-computer-terminal': { fontSize: '13px', lineHeight: '18px' } },
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
  captions: { display: 'flex', flexShrink: 0, marginLeft: 'auto' },
  appIcon: { display: 'block', flexShrink: 0, backgroundPosition: 'center', backgroundRepeat: 'no-repeat', backgroundSize: 'contain' },
});

/** Each app's own icon, pinned in `app-icons/` with its licence (botcube/NOTICE). */
const APP_ICON: Record<DockApp, string | { src: string }> = { Files: folder, Chrome: chromium, Terminal: terminal };

export function AppIcon({ app, size }: { app: DockApp; size: 16 | 24 }) {
  const styles = useStyles();
  const image = APP_ICON[app];
  // Decorative, beside the app's name: a background, so no picture is read out or taken for the screen's own.
  return <span className={styles.appIcon} style={{ width: size, height: size, backgroundImage: `url("${typeof image === 'string' ? image : image.src}")` }} aria-hidden="true" />;
}

function TitleBar({ window: { app, title }, active, full, onMinimise, onMaximise, onClose }: { window: DesktopWindow; active: boolean; full: boolean; onMinimise: () => void; onMaximise: () => void; onClose: () => void }) {
  const styles = useStyles();
  return (
    <div className={mergeClasses('window-titlebar', styles.titleBar, active && styles.titleBarActive)} onDoubleClick={onMaximise}>
      {/* One document: the app's icon and title, as a Windows 11 title bar draws them. */}
      <AppIcon app={app} size={16} />
      <Text size={200} truncate wrap={false} className={styles.title}>{title}</Text>
      <span className={styles.captions}>
        <Button appearance="subtle" aria-label={`Minimise ${app}`} icon={<Subtract16Regular />} onClick={onMinimise} />
        <Button appearance="subtle" aria-label={full ? `Restore ${app}` : `Maximise ${app}`} icon={full ? <SquareMultiple16Regular /> : <Maximize16Regular />} onClick={onMaximise} />
        <Button appearance="subtle" aria-label={`Close ${app}`} icon={<Dismiss16Regular />} onClick={onClose} />
      </span>
    </div>
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
  /** The taskbar button a minimised window shrinks into, in the screen's pixels. */
  toward: { x: number; y: number } | undefined;
  scale: number;
  interactive: boolean;
  layer: number;
  snapping: boolean;
  phone: boolean;
  onRaise: () => void;
  onPlace: (place: Partial<Rect>) => void;
  onSnap: () => void;
  /** The snap's motion is over, or the user took the window: it moves without easing again. */
  onSnapped: () => void;
  onMinimise: () => void;
  onMaximise: () => void;
  onClose: () => void;
  /** The close motion is over: the window may unmount. */
  onClosed: () => void;
}

/** How a window goes away into its taskbar button, or comes back. */
function shrinkStyle(away: boolean, life: Life, toward: WindowFrameProps['toward'], { x, y, width, height }: Rect): CSSProperties {
  if (!away) return { transform: 'none', opacity: 1, transition: `transform 280ms ${DECELERATE}, opacity 200ms ${DECELERATE}` };
  return {
    // Closing is opening in reverse; minimising shrinks into the taskbar button; a phone's other windows step back.
    transform: life === 'closed' ? 'scale(0.92)' : toward === undefined ? 'scale(0.96)' : `translate(${toward.x - (x + width / 2)}px, ${toward.y - (y + height / 2)}px) scale(0.18)`,
    opacity: 0,
    visibility: 'hidden',
    transition: life === 'closed' ? `transform 200ms ${EASY_EASE}, opacity 200ms ${EASY_EASE}, visibility 0s 200ms` : `transform 220ms ${ACCELERATE}, opacity 220ms ${ACCELERATE}, visibility 0s 220ms`,
  };
}

/** One window: react-rnd moves and resizes it, Fluent draws its frame in the window's own theme. */
export function WindowFrame({ window: win, life, opening, active, away, place, full, toward, scale, interactive, layer, snapping, phone, onRaise, onPlace, onSnap, onSnapped, onMinimise, onMaximise, onClose, onClosed }: WindowFrameProps) {
  const styles = useStyles();
  return (
    <Rnd
      data-window={win.app}
      data-state={away ? (life === 'open' ? 'behind' : life) : 'open'}
      scale={scale}
      size={{ width: place.width, height: place.height }}
      position={{ x: place.x, y: place.y }}
      onDragStart={onSnapped}
      onResizeStart={onSnapped}
      onDragStop={(_, drag) => {
        // Snap: a window dragged to the top edge fills the screen.
        if (drag.y <= 0) onSnap();
        else onPlace({ x: drag.x, y: drag.y });
      }}
      onResizeStop={(_, __, ___, delta, position) => onPlace({ x: position.x, y: position.y, width: place.width + delta.width, height: place.height + delta.height })}
      onTransitionEnd={(event: TransitionEvent<HTMLElement>) => { if (event.target === event.currentTarget) onSnapped(); }}
      disableDragging={full || !interactive}
      enableResizing={!full && interactive}
      bounds="parent"
      minWidth={380}
      minHeight={240}
      dragHandleClassName="window-titlebar"
      cancel=".fui-Button"
      style={{ zIndex: layer, pointerEvents: away ? 'none' : 'auto', transition: snapping ? `transform 250ms ${DECELERATE}, width 250ms ${DECELERATE}, height 250ms ${DECELERATE}` : undefined }}
      onMouseDown={onRaise}
    >
      <div
        className={styles.frame}
        style={shrinkStyle(away, life, toward, place)}
        onTransitionEnd={(event: TransitionEvent<HTMLElement>) => { if (event.target === event.currentTarget && event.propertyName === 'opacity' && life === 'closed') onClosed(); }}
      >
        {/* Each window in its own theme: Fluent draws its surface, in dark for Terminal. */}
        <FluentProvider theme={win.dark === true ? webDarkTheme : webLightTheme} className={mergeClasses('agent-computer-windows-window', styles.window, opening && styles.opening, active && styles.windowActive, full && styles.windowFull)}>
          <TitleBar window={win} active={active} full={full} onMinimise={onMinimise} onMaximise={onMaximise} onClose={onClose} />
          <div className={mergeClasses(styles.content, phone && styles.phoneContent)}>{win.children}</div>
        </FluentProvider>
      </div>
    </Rnd>
  );
}
