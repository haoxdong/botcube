// The taskbar's flyouts, in stock Fluent (ADR 0093): Start, Search, Quick Settings and the calendar.
import { Calendar, defaultCalendarStrings } from '@fluentui/react-calendar-compat';
import { Button, Divider, makeStyles, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, mergeClasses, Persona, SearchBox, Slider, Text, tokens } from '@fluentui/react-components';
import { Battery1020Regular, Power20Regular, Speaker220Regular, Wifi120Regular, WifiOff20Regular } from '@fluentui/react-icons';
import { useState } from 'react';
import { AppIcon, type DockApp } from './windows-window';

const APPS: readonly DockApp[] = ['Files', 'Chromium', 'Terminal'];

/** The apps whose name holds the query, in any case, as Windows search matches them. */
function matchingApps(query: string) {
  const wanted = query.toLocaleLowerCase();
  return APPS.filter((app) => app.toLocaleLowerCase().includes(wanted));
}

// Each flyout keeps to the width of a 390 px phone, less its gutters; Quick settings and the calendar take Windows 11's.
const useStyles = makeStyles({
  start: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, width: 'min(560px, calc(100vw - 64px))' },
  search: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, width: 'min(360px, calc(100vw - 64px))' },
  searchBox: { width: '100%', maxWidth: 'none' },
  // Start's pinned apps: Windows' grid of icons, each named under it.
  pinned: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: tokens.spacingHorizontalS },
  pinnedApp: { flexDirection: 'column', gap: tokens.spacingVerticalXS, height: 'auto', paddingBlock: tokens.spacingVerticalS, fontWeight: tokens.fontWeightRegular },
  results: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start' },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  quick: { width: 'min(360px, calc(100vw - 32px))' },
  quickBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXL, padding: tokens.spacingHorizontalXXL },
  tiles: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacingHorizontalM },
  tileCell: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXXS, textAlign: 'center' },
  tile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    height: '48px',
    marginBottom: tokens.spacingVerticalXS,
    borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    fontSize: '20px',
  },
  tileOn: { backgroundColor: tokens.colorBrandBackground, border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandBackground}`, color: tokens.colorNeutralForegroundOnBrand },
  sliderRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, fontSize: '20px' },
  slider: { flexGrow: 1 },
  quickFooter: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    height: '48px',
    paddingInline: tokens.spacingHorizontalXXL,
    borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: '20px',
  },
  date: { width: 'min(334px, calc(100vw - 32px))' },
  dateHeader: { display: 'block', padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL}`, borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}` },
  // One month, as Windows' calendar: its grid spread over the flyout, each day a 40 px circle.
  month: {
    width: '100%',
    boxSizing: 'border-box',
    padding: tokens.spacingHorizontalL,
    '& .fui-CalendarDay': { width: 'auto', padding: 0 },
    '& .fui-CalendarDayGrid__wrapper, & .fui-CalendarDayGrid__table': { width: '100%' },
    '& .fui-CalendarDayGrid__dayCell': { width: 'auto', height: '40px' },
    '& .fui-CalendarDayGrid__dayButton': { width: '40px', height: '40px', borderRadius: tokens.borderRadiusCircular },
    '& .fui-CalendarDayGrid__dayTodayMarker': { width: '40px', height: '40px', lineHeight: '40px' },
    // Windows rings the picked day and fills today; neither boxes its cell.
    '& .fui-CalendarDayGrid__daySelected': { backgroundColor: 'transparent' },
    '& .fui-CalendarDayGrid__daySingleSelected > .fui-CalendarDayGrid__dayButton': { backgroundColor: 'transparent', borderRadius: tokens.borderRadiusCircular },
  },
});

const SHORT_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** A search over the apps: typing narrows them, Enter opens the first, and each opens on a press. */
function AppSearch({ placeholder, heading, grid, onOpen }: { placeholder: string; heading: string; grid: boolean; onOpen: (app: DockApp) => void }) {
  const styles = useStyles();
  const [query, setQuery] = useState('');
  const matches = matchingApps(query);
  return (
    <>
      <SearchBox
        className={styles.searchBox}
        placeholder={placeholder}
        aria-label={placeholder}
        value={query}
        onChange={(_, data) => setQuery(data.value)}
        onKeyDown={(event) => {
          const [first] = matches;
          if (event.key === 'Enter' && first !== undefined) onOpen(first);
        }}
      />
      <Text weight="semibold">{heading}</Text>
      <div className={grid ? styles.pinned : styles.results}>
        {matches.map((app) => (
          <Button key={app} appearance="subtle" className={mergeClasses(grid && styles.pinnedApp)} icon={<AppIcon app={app} size={24} />} onClick={() => onOpen(app)}>{app}</Button>
        ))}
      </div>
      <div hidden={matches.length > 0}><Text>No results for “{query}”</Text></div>
    </>
  );
}

/**
 * Start: search, the pinned apps, and the agent with its Power menu. Stop there is the chat's own Stop, and is disabled
 * while there is no run to stop.
 */
export function StartMenu({ agentName, onOpen, onStop }: { agentName: string | undefined; onOpen: (app: DockApp) => void; onStop: (() => void) | null }) {
  const styles = useStyles();
  return (
    <div className={styles.start}>
      <AppSearch placeholder="Search for apps, settings and documents" heading="Pinned" grid onOpen={onOpen} />
      <Divider />
      <div className={styles.footer}>
        <Persona {...(agentName === undefined ? {} : { name: agentName })} avatar={{ color: 'colorful' }} />
        <Menu positioning="above-end">
          <MenuTrigger disableButtonEnhancement>
            <Button appearance="subtle" aria-label="Power" icon={<Power20Regular />} />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem disabled={onStop === null} onClick={onStop ?? undefined}>Stop</MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
    </div>
  );
}

export function SearchFlyout({ onOpen }: { onOpen: (app: DockApp) => void }) {
  const styles = useStyles();
  return (
    <div className={styles.search}>
      <AppSearch placeholder="Search" heading="Apps" grid={false} onOpen={onOpen} />
    </div>
  );
}

/**
 * Quick Settings, laid out as Windows 11's with only what the computer has: its network as it is, the volume, and the
 * battery. Nothing here changes the computer.
 */
export function QuickSettings({ online }: { online: boolean }) {
  const styles = useStyles();
  const Network = online ? Wifi120Regular : WifiOff20Regular;
  return (
    <div className={styles.quick}>
      <div className={styles.quickBody}>
        <div className={styles.tiles}>
          <div className={styles.tileCell}>
            <span className={mergeClasses(styles.tile, online && styles.tileOn)}><Network /></span>
            <Text>Network</Text>
            <Text size={200}>{online ? 'Connected' : 'Not connected'}</Text>
          </div>
        </div>
        <div className={styles.sliderRow}>
          <Speaker220Regular />
          <Slider className={styles.slider} aria-label="Volume" defaultValue={100} />
        </div>
      </div>
      <div className={styles.quickFooter}>
        <Battery1020Regular />
        <Text>100%</Text>
      </div>
    </div>
  );
}

/** The clock's flyout, as Windows 11's: today's date, then one month with today marked. */
export function DateFlyout({ now }: { now: Date }) {
  const styles = useStyles();
  const [day, setDay] = useState(now);
  return (
    <div className={styles.date}>
      <Text className={styles.dateHeader} size={400} weight="semibold">{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</Text>
      <Calendar className={styles.month} value={day} today={now} onSelectDate={setDay} isMonthPickerVisible={false} showGoToToday={false} showSixWeeksByDefault strings={{ ...defaultCalendarStrings, shortDays: SHORT_DAYS }} />
    </div>
  );
}
