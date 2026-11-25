// The Files window as Windows 11 File Explorer, from stock Fluent parts (ADR 0093).
import { Button, makeStyles, mergeClasses, Tab, TabList, tokens, Tooltip } from '@fluentui/react-components';
import { Add16Regular, Dismiss12Regular, Folder16Filled, Home16Regular } from '@fluentui/react-icons';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useWindowKeytips } from './files-explorer-keytips';
import { EMPTY_CLIPBOARD, type Clipboard } from './files-explorer-actions';
import { ExplorerTab, type TabProps } from './files-explorer-tab';
import { useExplorerStyles } from './files-explorer-nav';
import type { Place, View } from './files-items';
import { FOLDER } from './windows-window';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, containerType: 'inline-size' },
  tabs: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    overflowX: 'auto',
    padding: `0 ${tokens.spacingHorizontalXS}`,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  tabAndClose: { display: 'flex', alignItems: 'center', flexShrink: 0 },
});

/** A tab's name: its place's folder, as Explorer's tab shows it. */
const nameOf = (place: Place) => (place === null ? 'Home' : place === '' ? 'workspace' : (place.split('/').at(-2) ?? ''));
/** The view memory's key for a place. */
const keyOf = (place: Place) => (place === null ? 'home' : `/${place}`);

/**
 * The Files window: its tabs, each a place of its own with its own history and view, above the open tab's Explorer. A
 * tab's ✕ closes it, + opens workspace in a new one; Ctrl+T and Ctrl+W do the same, Ctrl+Tab and Ctrl+Shift+Tab go to
 * the next and previous tab, and closing the last tab leaves workspace open. The tabs share the clipboard and each
 * folder's view. Alt shows the keytips of the tab in front.
 */
export function FilesWindow(props: Omit<TabProps, 'clipboard' | 'onClipboard' | 'viewOf' | 'onViewOf' | 'keytipping'>) {
  const styles = useStyles();
  const explorer = useExplorerStyles();
  const nextTab = useRef(1);
  const [tabs, setTabs] = useState<readonly { id: number; place: Place }[]>([{ id: 0, place: '' }]);
  const [current, setCurrent] = useState(0);
  const [clipboard, setClipboard] = useState<Clipboard>(EMPTY_CLIPBOARD);
  // The view each place was last shown in, this session.
  const [views, setViews] = useState<Readonly<Record<string, View>>>({});
  const newTab = () => {
    const id = nextTab.current++;
    setTabs((all) => [...all, { id, place: '' }]);
    setCurrent(id);
    props.onReload();
  };
  const closeTab = (id: number) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const rest = tabs.filter((tab) => tab.id !== id);
    if (rest.length === 0) {
      const fresh = nextTab.current++;
      setTabs([{ id: fresh, place: '' }]);
      setCurrent(fresh);
      return;
    }
    setTabs(rest);
    if (id === current) setCurrent((rest[Math.min(index, rest.length - 1)] ?? rest[0])?.id ?? current);
  };
  const { keytips, showing, onKeyDown, onKeyUp } = useWindowKeytips();
  const step = (by: number) => {
    const index = tabs.findIndex((tab) => tab.id === current);
    const next = tabs[(index + by + tabs.length) % tabs.length];
    if (next !== undefined) setCurrent(next.id);
  };
  const onKey = (event: KeyboardEvent) => {
    onKeyDown(event);
    if (showing.current || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 't') newTab();
    else if (key === 'w') closeTab(current);
    else if (key === 'tab') step(event.shiftKey ? -1 : 1);
    else return;
    event.preventDefault();
  };
  return (
    <div role="region" className={mergeClasses('agent-computer-files', styles.root)} aria-label="Files" onKeyDown={onKey} onKeyUp={onKeyUp}>
      {keytips}
      <div className={styles.tabs}>
        <TabList size="small" selectedValue={current} onTabSelect={(_, data) => setCurrent(Number(data.value))} aria-label="Tabs">
          {tabs.map(({ id, place }) => (
            <div key={id} className={styles.tabAndClose}>
              <Tab value={id} icon={place === null ? <Home16Regular /> : <Folder16Filled color={FOLDER} />}>{nameOf(place)}</Tab>
              <Button appearance="subtle" size="small" icon={<Dismiss12Regular />} aria-label={`Close tab ${nameOf(place)}`} onClick={() => closeTab(id)} />
            </div>
          ))}
        </TabList>
        <Tooltip content="New tab" relationship="label">
          <Button appearance="subtle" size="small" icon={<Add16Regular />} aria-label="New tab" onClick={newTab} />
        </Tooltip>
      </div>
      {tabs.map(({ id }) => (
        <ExplorerTab
          key={id}
          {...props}
          active={id === current}
          className={mergeClasses(id !== current && explorer.hidden)}
          clipboard={clipboard}
          onClipboard={setClipboard}
          viewOf={(place) => views[keyOf(place)]}
          onViewOf={(place, view) => setViews((all) => ({ ...all, [keyOf(place)]: view }))}
          keytipping={() => showing.current}
          onPlace={(place) => setTabs((all) => all.map((tab) => (tab.id === id ? { ...tab, place } : tab)))}
        />
      ))}
    </div>
  );
}
