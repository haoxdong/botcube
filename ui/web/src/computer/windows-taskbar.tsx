// The Windows 11 taskbar, in stock Fluent (ADR 0093): Start, Search, the apps, the tray, the clock and Show desktop.
import { Button, makeStyles, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, mergeClasses, Popover, PopoverSurface, PopoverTrigger, Text, Toolbar, ToolbarToggleButton, tokens, Tooltip } from '@fluentui/react-components';
import { Battery1020Regular, Dismiss16Regular, Grid24Filled, Search24Regular, Speaker220Regular, Wifi120Regular, WifiOff20Regular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import { DateFlyout, QuickSettings, SearchFlyout, StartMenu } from './windows-flyouts';
import { AppIcon, type DesktopWindow, type DockApp, type Life } from './windows-window';

export const TASKBAR = 48;
export const TASKBAR_APPS: readonly DockApp[] = ['Files', 'Chromium', 'Terminal'];

const useStyles = makeStyles({
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
  // Quick settings and the calendar float as Windows 11's: 12 px above the taskbar and in from the screen's right edge.
  corner: { position: 'absolute', top: 0, right: tokens.spacingHorizontalM, width: 0, height: 0 },
  panel: { padding: 0, overflow: 'hidden', borderRadius: tokens.borderRadiusXLarge },
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
  tray: { position: 'absolute', top: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  trayIcons: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, fontSize: '20px' },
  clock: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
  // Windows' sliver at the taskbar's far right.
  showDesktop: { alignSelf: 'stretch', minWidth: 0, width: '10px', height: 'auto', padding: 0 },
  // A running window's preview: its title bar over its app's tile.
  preview: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, width: '200px' },
  previewTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  previewTile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '96px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
});

/** The time and date, as the taskbar shows them; pressed, the date over a calendar. */
function Clock({ corner }: { corner: HTMLElement | null }) {
  const styles = useStyles();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(tick);
  }, []);
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString();
  return (
    <Popover positioning={{ position: 'above', align: 'end', offset: 12, target: corner }}>
      <PopoverTrigger disableButtonEnhancement>
        <Button appearance="subtle" aria-label={`${time}, ${date}`}>
          <Text size={200} className={styles.clock}>
            <span>{time}</span>
            <span>{date}</span>
          </Text>
        </Button>
      </PopoverTrigger>
      <PopoverSurface aria-label="Calendar" className={styles.panel}>
        <DateFlyout now={now} />
      </PopoverSurface>
    </Popover>
  );
}

/**
 * A window's preview on hover: its title bar over its app's icon. Not a live copy: the browser's live view connects
 * once and Files loads its listing, so a second copy of either would be a second connection or request.
 */
function Preview({ window: { app, title } }: { window: DesktopWindow }) {
  const styles = useStyles();
  return (
    <span className={styles.preview}>
      <span className={styles.previewTitle}>
        <AppIcon app={app} size={16} />
        <Text size={200} truncate wrap={false}>{title}</Text>
      </span>
      <span className={styles.previewTile}><AppIcon app={app} size={24} /></span>
    </span>
  );
}

interface TaskbarAppProps {
  window: DesktopWindow;
  life: Life;
  active: boolean;
  onPick: () => void;
  onOpen: () => void;
  onClose: () => void;
}

/** One app on the taskbar: a press switches to it, a hover previews its window, a right click offers its menu. */
function TaskbarApp({ window: win, life, active, onPick, onOpen, onClose }: TaskbarAppProps) {
  const styles = useStyles();
  const { app } = win;
  const running = life !== 'closed';
  return (
    <span className={styles.taskbarApp}>
      <Menu openOnContext positioning="above">
        <MenuTrigger disableButtonEnhancement>
          {/* Inaccessible: a description Tooltip would portal on the server, and the button's label already names the app. */}
          <Tooltip relationship="inaccessible" positioning="above" content={running ? <Preview window={win} /> : app}>
            <ToolbarToggleButton name="app" value={app} appearance="subtle" className="agent-computer-taskbar-app" aria-label={app} icon={<AppIcon app={app} size={24} />} onClick={onPick} />
          </Tooltip>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            <MenuItem icon={<AppIcon app={app} size={16} />} onClick={onOpen}>{app}</MenuItem>
            <MenuItem icon={<Dismiss16Regular />} disabled={!running} onClick={onClose}>Close window</MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>
      <span className={mergeClasses(styles.running, active && styles.runningActive, !running && styles.notRunning)} />
    </span>
  );
}

export interface TaskbarProps {
  windows: readonly DesktopWindow[];
  life: Record<DockApp, Life>;
  active: DockApp | null;
  phone: boolean;
  agentName: string | undefined;
  onStop: (() => void) | null;
  online: boolean;
  /** A taskbar press: brings the app forward, or minimises it if it is already in front. */
  onPick: (app: DockApp) => void;
  /** Opens the app, or brings it forward. */
  onOpen: (app: DockApp) => void;
  onClose: (app: DockApp) => void;
  onShowDesktop: () => void;
}

type Flyout = 'start' | 'search';

export function Taskbar({ windows, life, active, phone, agentName, onStop, online, onPick, onOpen, onClose, onShowDesktop }: TaskbarProps) {
  const styles = useStyles();
  const [flyout, setFlyout] = useState<Flyout | null>(null);
  const toggle = (name: Flyout) => (_: unknown, data: { open: boolean }) => setFlyout(data.open ? name : null);
  const open = (app: DockApp) => {
    setFlyout(null);
    onOpen(app);
  };
  const Network = online ? Wifi120Regular : WifiOff20Regular;
  const [corner, setCorner] = useState<HTMLElement | null>(null);
  return (
    <div className={styles.taskbar}>
      <span ref={setCorner} className={styles.corner} />
      <Toolbar className={styles.taskbarApps} size="large" aria-label="Taskbar" checkedValues={{ app: active === null ? [] : [active], flyout: flyout === null ? [] : [flyout] }}>
        <Popover open={flyout === 'start'} onOpenChange={toggle('start')} positioning={{ position: 'above', offset: 12 }} trapFocus>
          <PopoverTrigger disableButtonEnhancement>
            <ToolbarToggleButton name="flyout" value="start" appearance="subtle" aria-label="Start" icon={<Grid24Filled color={tokens.colorBrandForeground1} />} />
          </PopoverTrigger>
          <PopoverSurface aria-label="Start">
            <StartMenu agentName={agentName} onOpen={open} onStop={onStop} />
          </PopoverSurface>
        </Popover>
        <Popover open={flyout === 'search'} onOpenChange={toggle('search')} positioning={{ position: 'above', offset: 12 }} trapFocus>
          <PopoverTrigger disableButtonEnhancement>
            <ToolbarToggleButton name="flyout" value="search" appearance="subtle" aria-label="Search" icon={<Search24Regular />} className={mergeClasses(phone && styles.desktopOnly)} />
          </PopoverTrigger>
          <PopoverSurface aria-label="Search">
            <SearchFlyout onOpen={open} />
          </PopoverSurface>
        </Popover>
        {TASKBAR_APPS.map((app) => {
          const win = windows.find((each) => each.app === app) ?? { app, title: app, children: null };
          return <TaskbarApp key={app} window={win} life={life[app]} active={app === active} onPick={() => onPick(app)} onOpen={() => open(app)} onClose={() => onClose(app)} />;
        })}
      </Toolbar>
      <span className={styles.tray}>
        <Popover positioning={{ position: 'above', align: 'end', offset: 12, target: corner }}>
          <PopoverTrigger disableButtonEnhancement>
            <Button appearance="subtle" aria-label="Quick settings" className={mergeClasses(phone && styles.desktopOnly)}>
              <span className={styles.trayIcons}><Network /><Speaker220Regular /><Battery1020Regular /></span>
            </Button>
          </PopoverTrigger>
          <PopoverSurface aria-label="Quick settings" className={styles.panel}>
            <QuickSettings online={online} />
          </PopoverSurface>
        </Popover>
        <Clock corner={corner} />
        <Button appearance="subtle" aria-label="Show desktop" className={mergeClasses(styles.showDesktop, phone && styles.desktopOnly)} onClick={onShowDesktop} />
      </span>
    </div>
  );
}
