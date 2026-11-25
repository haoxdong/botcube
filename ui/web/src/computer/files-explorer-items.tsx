// The open place's items in File Explorer's view, grouped or not, from stock Fluent parts (ADR 0093): each view's one
// virtualizer draws only what is in view, inside the one scroll of the list.
import { useStaticVirtualizerMeasure } from '@fluentui-contrib/react-virtualizer';
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, makeStyles, mergeClasses, useMergedRefs, type AccordionToggleData } from '@fluentui/react-components';
import { useRef, useState } from 'react';
import type { ItemMarks, ListActions, Reveal } from './files-explorer-actions';
import { DetailsList, GroupDetailsList } from './files-explorer-list';
import { useExplorerStyles } from './files-explorer-nav';
import { CardList, type Scroller } from './files-explorer-views';
import type { FilesItem, Group, GroupBy, Sort, View } from './files-items';

const useStyles = makeStyles({
  // The one scroll of the list; the flat details grid scrolls itself under its headers, so this one has nothing to.
  scroll: { flexGrow: 1, minHeight: 0, overflow: 'auto' },
  filled: { display: 'flex', flexDirection: 'column' },
});

/** The scroll's size until it is measured: a large window, so the virtual views draw enough at first. */
const UNMEASURED = { width: 1200, height: 1600 };

/**
 * The items in the view: Details as one grid, any other view as cards. Grouped, each group is an open section of its
 * own under its name and count, its grid under the one row of column headers at the top; a section's header folds it.
 * Flat, only the rows in view are drawn; grouped, Details draws every row of a group (a group's grid has no scroll of
 * its own to virtualise against), and the cards draw only the rows in view.
 */
export function ItemsView({ items, groups, groupBy, view, sort, onSort, marks, actions, shown, thumbnailUrl, onSelection, reveal, className }: {
  /** The items in the order shown. */
  items: readonly FilesItem[];
  groups: readonly Group[];
  groupBy: GroupBy;
  view: View;
  sort: Sort;
  onSort: (sort: Sort) => void;
  marks: ItemMarks;
  actions: ListActions;
  /** Whether the view is on screen, so pictures load. */
  shown: boolean;
  thumbnailUrl: (path: string) => Promise<string>;
  onSelection: (paths: string[]) => void;
  /** Brings a flat view's item into the drawn rows, by its index in `items`. */
  reveal: { current: Reveal | null };
  className?: string;
}) {
  const styles = useStyles();
  const explorer = useExplorerStyles();
  const grouped = groupBy !== 'none';
  const details = view === 'details';
  const cardView = view === 'details' ? 'large' : view;
  // The scroll and its size, for the cards' rows, as fluentui-contrib's virtualizer measures it: one measure down and
  // one across, each by the pixel, so any change of either size draws the rows afresh.
  const scrollRef = useRef<HTMLElement | null>(null);
  const tall = useStaticVirtualizerMeasure({ defaultItemSize: 1 });
  const wide = useStaticVirtualizerMeasure({ defaultItemSize: 1, direction: 'horizontal' });
  const ref = useMergedRefs(scrollRef, tall.scrollRef, wide.scrollRef);
  // The measures only say when to draw afresh: they read the scaled screen's box, so the rows are laid out at the
  // scroll's own size, the one Windows draws at before the screen is scaled to fit.
  const scroll = scrollRef.current;
  const scroller: Scroller = {
    ref: scrollRef,
    width: scroll?.clientWidth || wide.containerSizeRef.current || UNMEASURED.width,
    height: scroll?.clientHeight || tall.containerSizeRef.current || UNMEASURED.height,
  };
  // The sections folded away, for this grouping; every section starts open.
  const [folded, setFolded] = useState<{ by: GroupBy; keys: readonly string[] }>({ by: groupBy, keys: [] });
  const closed = folded.by === groupBy ? folded.keys : [];
  const sections = grouped ? groups : [];
  const onToggle = (_: unknown, { openItems }: AccordionToggleData) => {
    const open = new Set(openItems.map(String));
    setFolded({ by: groupBy, keys: sections.map(({ key }) => key).filter((key) => !open.has(key)) });
  };
  const common = { sort, onSort, marks, actions };
  const cards = { view: cardView, marks, actions, thumbnailUrl, onSelection, scroller };
  const flat = details
    ? <DetailsList {...common} items={items} reveal={reveal} />
    : <CardList {...cards} items={items} shown={shown} reveal={reveal} />;
  return (
    <div ref={ref} className={mergeClasses(styles.scroll, !grouped && details && styles.filled, className)}>
      {!grouped ? flat : (
        <>
          <GroupDetailsList {...common} items={[]} label="Columns" className={mergeClasses(!details && explorer.hidden)} />
          <Accordion multiple collapsible openItems={sections.map(({ key }) => key).filter((key) => !closed.includes(key))} onToggle={onToggle}>
            {sections.map((group) => (
              <AccordionItem key={group.key} value={group.key}>
                <AccordionHeader size="small">{group.label}</AccordionHeader>
                <AccordionPanel>
                  {details
                    ? <GroupDetailsList {...common} items={group.items} header={false} label={group.label} />
                    : <CardList {...cards} items={group.items} shown={shown} label={group.label} />}
                </AccordionPanel>
              </AccordionItem>
            ))}
          </Accordion>
        </>
      )}
    </div>
  );
}
