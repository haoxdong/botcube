// File Explorer's icon, list, tiles and content views: a stock Fluent List of stock Cards, virtual through
// fluentui-contrib's virtualizer (ADR 0093).
import { Virtualizer } from '@fluentui-contrib/react-virtualizer';
import { Card, CardHeader, CardPreview, List, ListItem, makeStyles, mergeClasses, Text, tokens } from '@fluentui/react-components';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { ItemGlyph, Thumbnail, type IconSize } from './files-explorer-icons';
import type { ItemMarks, ListActions, Reveal } from './files-explorer-actions';
import { RenameField } from './files-explorer-list';
import { RowMenu } from './files-explorer-menus';
import { dateText, kindOf, sizeText, typeText, type FilesItem, type View } from './files-items';

/** Every view but Details, which is a grid of columns. */
type CardView = Exclude<View, 'details'>;

/** Each view's icon size, card orientation, the lines under the name, and whether pictures show as themselves. */
const LAYOUTS: Record<CardView, { size: IconSize; orientation: 'vertical' | 'horizontal'; lines: (item: FilesItem) => string[]; pictures: boolean }> = {
  xl: { size: 256, orientation: 'vertical', lines: () => [], pictures: true },
  large: { size: 96, orientation: 'vertical', lines: () => [], pictures: true },
  medium: { size: 48, orientation: 'vertical', lines: () => [], pictures: true },
  small: { size: 16, orientation: 'horizontal', lines: () => [], pictures: false },
  list: { size: 16, orientation: 'horizontal', lines: () => [], pictures: false },
  tiles: { size: 48, orientation: 'horizontal', lines: (item) => [typeText(item), item.folder ? '' : sizeText(item.size)], pictures: true },
  content: {
    size: 48,
    orientation: 'horizontal',
    lines: (item) => [typeText(item), `Date modified: ${dateText(item.lastModified)}`, item.folder ? '' : `Size: ${sizeText(item.size)}`],
    pictures: true,
  },
};

/** Each view's narrowest card, in pixels, and its row's height: the rows of cards are all one height, so a virtual list places them. */
const SIZES: Record<CardView, { width: number; height: number }> = {
  xl: { width: 280, height: 332 },
  large: { width: 128, height: 172 },
  medium: { width: 96, height: 124 },
  small: { width: 200, height: 36 },
  list: { width: 240, height: 36 },
  tiles: { width: 260, height: 84 },
  content: { width: Number.MAX_SAFE_INTEGER, height: 92 },
};
/** The most cards a row holds, and the room around and between them, in pixels (spacingHorizontalS and XS). */
const MOST = 12;
const PADDING = 8;
const GAP = 4;

const useStyles = makeStyles({
  root: { display: 'block', padding: tokens.spacingHorizontalS },
  row: { display: 'grid', columnGap: tokens.spacingHorizontalXS, alignItems: 'start', overflow: 'hidden', boxSizing: 'border-box', paddingBottom: tokens.spacingVerticalXS },
  xl: { height: `${SIZES.xl.height}px` },
  large: { height: `${SIZES.large.height}px` },
  medium: { height: `${SIZES.medium.height}px` },
  small: { height: `${SIZES.small.height}px`, paddingBottom: 0 },
  list: { height: `${SIZES.list.height}px`, paddingBottom: 0 },
  tiles: { height: `${SIZES.tiles.height}px` },
  content: { height: `${SIZES.content.height}px` },
  item: { minWidth: 0 },
  // Fluent's card never shrinks its header, so a long name would run past the card's edge uncut.
  card: { width: '100%', minWidth: 0, '& > .fui-CardHeader': { flexShrink: 1, minWidth: 0 } },
  cut: { opacity: 0.5 },
  // A tile's lines, as Windows gives them: each on its own.
  lines: { display: 'flex', flexDirection: 'column' },
  // A header's name that may narrow below its length, so a long name ends with an ellipsis.
  shrinks: { minWidth: 0 },
  wraps: { width: '100%', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: '2', overflow: 'hidden', textAlign: 'center', overflowWrap: 'anywhere' },
});

/** A row of so many cards, from 1 to MOST. */
const useColumns = makeStyles(Object.fromEntries(Array.from({ length: MOST }, (_, index) => [`c${index + 1}`, { gridTemplateColumns: `repeat(${index + 1}, minmax(0, 1fr))` }])));

/** An item's card: its picture or icon at the view's size, its name, and the view's lines about it. */
function ItemCard({ item, view, marks, shown, thumbnailUrl, onEndRename }: {
  item: FilesItem;
  view: CardView;
  marks: ItemMarks;
  shown: boolean;
  thumbnailUrl: (path: string) => Promise<string>;
  onEndRename: (name: string | null) => void;
}) {
  const styles = useStyles();
  const { size, orientation, lines, pictures } = LAYOUTS[view];
  const icon = pictures ? <Thumbnail item={item} size={size} shown={shown} thumbnailUrl={thumbnailUrl} /> : <ItemGlyph item={item} size={size} />;
  const name = item.path === marks.renaming
    ? <RenameField item={item} onEnd={onEndRename} />
    : orientation === 'vertical'
      // Under an icon, as in Windows 11, a name wraps to two centred lines and ends with an ellipsis past them.
      ? <Text title={item.name} className={styles.wraps}><span className="agent-computer-file-name">{item.name}</span></Text>
      : <Text truncate wrap={false} title={item.name} className={styles.shrinks}><span className="agent-computer-file-name">{item.name}</span></Text>;
  return (
    <Card
      appearance="subtle"
      size="small"
      orientation={orientation}
      selected={marks.selected.has(item.path)}
      checkbox={null}
      className={mergeClasses(styles.card, marks.cut.has(item.path) && styles.cut)}
    >
      <CardPreview>{icon}</CardPreview>
      <CardHeader
        header={{ className: styles.shrinks, children: name }}
        description={{ className: styles.lines, children: lines(item).filter(Boolean).map((line) => <Text key={line} size={200}>{line}</Text>) }}
      />
    </Card>
  );
}

/** The scroll the views are in, and its size; until it is measured, the window is taken as large. */
export type Scroller = { ref: { current: HTMLElement | null }; width: number; height: number };

/**
 * Items as cards in a stock Fluent List, laid out in rows of as many as the view's width holds. A click selects an
 * item, Ctrl and Shift adding to it, and Space toggles it; a double-click or Enter opens it; a right-click opens its
 * menu, as a row's does. Up and Down move through the items, and so do Left and Right. Only the rows in view and either
 * side of them are drawn, by fluentui-contrib's virtualizer, against the one scroll the views are in.
 */
export function CardList({ items, view, marks, actions, shown, thumbnailUrl, onSelection, scroller, reveal, label = 'Items', className }: {
  items: readonly FilesItem[];
  view: CardView;
  marks: ItemMarks;
  actions: ListActions;
  /** Whether the view is on screen, so its pictures load. */
  shown: boolean;
  thumbnailUrl: (path: string) => Promise<string>;
  /** Space's toggle, as the List gives it: every selected path. */
  onSelection: (paths: string[]) => void;
  scroller: Scroller;
  reveal?: { current: Reveal | null };
  label?: string;
  className?: string;
}) {
  const styles = useStyles();
  const columnStyles = useColumns();
  const id = useId();
  const { width, height } = SIZES[view];
  const columns = Math.min(MOST, Math.max(1, Math.floor((scroller.width - 2 * PADDING + GAP) / (width + GAP))));
  const rows = Math.ceil(items.length / columns);
  const shownRows = Math.ceil(scroller.height / height) + 1;
  const buffer = Math.max(1, Math.ceil(shownRows / 4));
  const length = shownRows + 2 * buffer;
  const containerSize = useRef(scroller.height);
  containerSize.current = scroller.height;
  // The first row drawn: the virtualizer moves it as the scroll does, and an item revealed moves it to the item.
  const [first, setFirst] = useState(0);
  if (reveal !== undefined) {
    reveal.current = { scrollToItem: (index) => setFirst(Math.max(0, Math.min(Math.floor(index / columns) - buffer, rows - length))) };
  }
  const step = (event: KeyboardEvent<HTMLElement>, item: FilesItem) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' && !event.altKey) {
      event.preventDefault();
      actions.onOpen(item);
      return;
    }
    const by = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (by === 0) return;
    event.preventDefault();
    const all = [...(event.currentTarget.closest('.fui-List')?.querySelectorAll<HTMLElement>('.fui-ListItem') ?? [])];
    all[all.indexOf(event.currentTarget) + by]?.focus();
  };
  const card = (item: FilesItem, index: number) => (
    <RowMenu key={item.path} item={item} open={marks.menuOn === item.path} actions={actions}>
      <ListItem
        as="div"
        id={`${id}-${index}`}
        value={item.path}
        checkmark={null}
        className={mergeClasses('agent-computer-file', styles.item)}
        data-file-path={item.path}
        data-kind={kindOf(item)}
        onClick={(event) => {
          // Explorer's click, not the List's toggle.
          event.preventDefault();
          actions.onClick(item, event);
        }}
        onDoubleClick={() => { if (item.path !== marks.renaming) actions.onOpen(item); }}
        onKeyDown={(event) => step(event, item)}
      >
        <ItemCard item={item} view={view} marks={marks} shown={shown} thumbnailUrl={thumbnailUrl} onEndRename={actions.onEndRename} />
      </ListItem>
    </RowMenu>
  );
  return (
    <List
      as="div"
      // Fluent's List asks for "items" where its items hold nothing focusable, as these cards don't: "composite" is
      // for items with controls inside, and Fluent warns of the grid role without them.
      navigationMode="items"
      selectionMode="multiselect"
      selectedItems={[...marks.selected]}
      onSelectionChange={(_, data) => onSelection(data.selectedItems.map(String))}
      aria-label={label}
      className={mergeClasses(styles.root, className)}
    >
      <Virtualizer
        numItems={rows}
        itemSize={height}
        virtualizerLength={length}
        bufferItems={buffer}
        bufferSize={Math.max(1, Math.floor(height / 2))}
        scrollViewRef={scroller.ref}
        containerSizeRef={containerSize}
        virtualizerContext={{ contextIndex: first, setContextIndex: setFirst }}
      >
        {(row) => (
          <div key={row} role="presentation" className={mergeClasses(styles.row, styles[view], columnStyles[`c${columns}`])}>
            {items.slice(row * columns, (row + 1) * columns).map((item, at) => card(item, row * columns + at))}
          </div>
        )}
      </Virtualizer>
    </List>
  );
}
