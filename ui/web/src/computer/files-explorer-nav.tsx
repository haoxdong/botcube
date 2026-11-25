// File Explorer's address row and navigation pane, from stock Fluent parts (ADR 0093).
import {
  Breadcrumb, BreadcrumbButton, BreadcrumbDivider, BreadcrumbItem, Button, makeStyles, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, mergeClasses,
  SearchBox, tokens, Tree, TreeItem, TreeItemLayout, type TreeItemValue,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular, ArrowLeft20Regular, ArrowRight20Regular, ArrowUp20Regular, ChevronRight20Regular, Folder20Filled, Home20Regular, Search20Regular,
} from '@fluentui/react-icons';
import { Fragment, useEffect, useRef, useState, type ReactElement } from 'react';
import type { FolderTree, Place } from './files-items';
import { FOLDER } from './windows-window';

/** Below this window width Explorer keeps to the list's name and size, and the address row to Back, Up and the path. */
const NARROW = '@container (max-width: 560px)';

export const useExplorerStyles = makeStyles({
  wideOnly: { [NARROW]: { display: 'none' } },
  narrowOnly: { display: 'none', [NARROW]: { display: 'inline-flex' } },
  hidden: { display: 'none' },
  address: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
  },
  path: { display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, overflow: 'hidden', paddingLeft: tokens.spacingHorizontalXS },
  crumbs: { minWidth: 0, overflow: 'hidden' },
  search: { flexBasis: '220px', flexShrink: 1, minWidth: '120px' },
  searching: { [NARROW]: { flexGrow: 1 } },
  oneLine: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  nav: {
    flexShrink: 0,
    width: '200px',
    overflow: 'auto',
    padding: tokens.spacingVerticalXS,
    borderRight: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
});

/** A crumb of the open place's path: its name, and the place it opens. */
export type Crumb = { name: string; target: Place };

/**
 * Back, Forward, Up and Refresh, the open place's path, and the search of it. The path starts with the place's icon and
 * Places, a menu of Home, workspace and workspace's folders. A narrow window shows Search as a button, which swaps the
 * path for the search box until Escape, or leaving it empty.
 */
export function AddressRow({ crumbs, canBack, canForward, canUp, query, places, onBack, onForward, onUp, onRefresh, onOpen, onQuery }: {
  crumbs: readonly [Crumb, ...Crumb[]];
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  query: string;
  /** Workspace's folders, whose top ones Places lists. */
  places: FolderTree;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onOpen: (place: Place) => void;
  onQuery: (query: string) => void;
}) {
  const styles = useExplorerStyles();
  const [first, ...rest] = crumbs;
  const last = crumbs.at(-1);
  const [searching, setSearching] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (searching) box.current?.focus(); }, [searching]);
  const place = (name: string, to: Place, icon: ReactElement) => <MenuItem key={String(to)} icon={icon} onClick={() => onOpen(to)}>{name}</MenuItem>;
  const crumb = (item: Crumb) => (
    <BreadcrumbItem>
      <BreadcrumbButton current={item === last} onClick={() => onOpen(item.target)}>{item.name}</BreadcrumbButton>
    </BreadcrumbItem>
  );
  return (
    <div className={styles.address}>
      <Button appearance="subtle" icon={<ArrowLeft20Regular />} aria-label="Back" title="Back" disabled={!canBack} onClick={onBack} />
      <Button appearance="subtle" icon={<ArrowRight20Regular />} aria-label="Forward" title="Forward" disabled={!canForward} onClick={onForward} className={styles.wideOnly} />
      <Button appearance="subtle" icon={<ArrowUp20Regular />} aria-label="Up" title="Up" disabled={!canUp} onClick={onUp} />
      <Button appearance="subtle" icon={<ArrowClockwise20Regular />} aria-label="Refresh" title="Refresh" onClick={onRefresh} className={styles.wideOnly} />
      <div className={mergeClasses(styles.path, searching && styles.wideOnly)}>
        {first.target === null ? <Home20Regular /> : <Folder20Filled color={FOLDER} />}
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button appearance="subtle" size="small" icon={<ChevronRight20Regular />} aria-label="Places" title="Places" />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {place('Home', null, <Home20Regular />)}
              {place('workspace', '', <Folder20Filled color={FOLDER} />)}
              {places.map(({ name, path }) => place(name, path, <Folder20Filled color={FOLDER} />))}
            </MenuList>
          </MenuPopover>
        </Menu>
        <Breadcrumb size="small" aria-label="Path" className={styles.crumbs}>
          {crumb(first)}
          {rest.map((item) => (
            <Fragment key={item.target}>
              <BreadcrumbDivider />
              {crumb(item)}
            </Fragment>
          ))}
        </Breadcrumb>
      </div>
      <Button
        ref={(node: HTMLButtonElement | null) => { toggle.current = node; }}
        appearance="subtle"
        icon={<Search20Regular />}
        aria-label="Search"
        title="Search"
        onClick={() => setSearching(true)}
        className={searching ? styles.hidden : styles.narrowOnly}
      />
      <SearchBox
        ref={(node: HTMLInputElement | null) => { box.current = node; }}
        size="small"
        aria-label="Search"
        placeholder={first.target === null ? 'Search Home' : 'Search workspace'}
        value={query}
        onChange={(_, data) => onQuery(data.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !searching) return;
          setSearching(false);
          toggle.current?.focus();
        }}
        onBlur={() => { if (query === '') setSearching(false); }}
        className={mergeClasses(styles.search, searching ? styles.searching : styles.wideOnly)}
      />
    </div>
  );
}

/** The tree's value for a place: Home, or a folder's path, workspace's as `/`. */
const valueOf = (place: Place): TreeItemValue => place ?? 'home';
const WORKSPACE = '/';

/** Home, then workspace and its folders to any depth; the open place is marked current. */
export function NavPane({ folders, place, onOpen }: { folders: FolderTree; place: Place; onOpen: (place: Place) => void }) {
  const styles = useExplorerStyles();
  const [open, setOpen] = useState<Iterable<TreeItemValue>>([WORKSPACE]);
  const current = place === '' ? WORKSPACE : valueOf(place);
  const item = (name: string, path: string, below: FolderTree) => {
    const value = path === '' ? WORKSPACE : path;
    const props = { value, 'aria-current': value === current ? ('true' as const) : undefined, onClick: () => onOpen(path) };
    const layout = <TreeItemLayout iconBefore={<Folder20Filled color={FOLDER} />} main={{ className: styles.oneLine }} title={name}>{name}</TreeItemLayout>;
    if (below.length === 0) return <TreeItem key={value} {...props} itemType="leaf">{layout}</TreeItem>;
    return (
      <TreeItem key={value} {...props} itemType="branch">
        {layout}
        <Tree>{below.map((folder) => item(folder.name, folder.path, folder.folders))}</Tree>
      </TreeItem>
    );
  };
  return (
    <nav className={mergeClasses(styles.nav, styles.wideOnly)} aria-label="Folders">
      <Tree
        aria-label="Navigation"
        size="small"
        openItems={open}
        // A click opens the folder; its chevron and the arrow keys show or hide the folders inside it.
        onOpenChange={(_, data) => { if (data.type !== 'Click' && data.type !== 'Enter') setOpen(data.openItems); }}
      >
        <TreeItem value="home" itemType="leaf" aria-current={current === 'home' ? 'true' : undefined} onClick={() => onOpen(null)}>
          <TreeItemLayout iconBefore={<Home20Regular />} main={{ className: styles.oneLine }}>Home</TreeItemLayout>
        </TreeItem>
        {item('workspace', '', folders)}
      </Tree>
    </nav>
  );
}
