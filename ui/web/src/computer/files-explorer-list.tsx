// File Explorer's details view: Fluent's DataGrid, virtual through fluentui-contrib's react-window grid, each row with
// its context menu (ADR 0093).
import {
  createTableColumn, DataGrid, DataGridBody, DataGridCell, DataGridHeader, DataGridHeaderCell, DataGridRow, Input, makeStyles, mergeClasses,
  TableCellLayout, Text, useRestoreFocusTarget, type TableColumnId, type TableRowData,
} from '@fluentui/react-components';
import {
  DataGrid as VirtualGrid, DataGridBody as VirtualBody, DataGridHeader as VirtualHeader, DataGridRow as VirtualRow,
} from '@fluentui-contrib/react-data-grid-react-window';
import { useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { ItemIcon } from './files-explorer-icons';
import { RowMenu } from './files-explorer-menus';
import { useExplorerStyles } from './files-explorer-nav';
import type { ItemMarks, ListActions, Reveal } from './files-explorer-actions';
import { compare, dateText, kindOf, sizeText, typeText, type FilesItem, type Sort } from './files-items';

export type { Sort } from './files-items';

const useStyles = makeStyles({
  grid: { minWidth: 0 },
  filling: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  body: { flexGrow: 1, minHeight: 0 },
  // The rows and the row of headers above them each keep room for a scrollbar, scrolling or not, so their columns
  // line up: fluentui-contrib hides the headers' own scrollbar, so the room is kept on their row.
  gutter: { scrollbarGutter: 'stable' },
  headerRow: { overflowY: 'hidden', scrollbarGutter: 'stable' },
  // The headers keep their height above the rows, which take the rest.
  header: { flexShrink: 0 },
  // A virtual row is the list's width, however long its name: the name is cut, not the row widened.
  row: { minWidth: 0 },
  name: { flexGrow: 3, minWidth: 0 },
  modified: { minWidth: '150px' },
  size: { flexGrow: 1, minWidth: '72px' },
  oneLine: { minWidth: 0 },
  field: { width: '100%' },
  cut: { opacity: 0.5 },
});

/** The name field of the file being renamed, its name selected up to its extension once it shows. */
export function RenameField({ item, onEnd }: { item: FilesItem; onEnd: (name: string | null) => void }) {
  const styles = useStyles();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const dot = item.name.lastIndexOf('.');
    field.current?.focus();
    field.current?.setSelectionRange(0, dot > 0 ? dot : item.name.length);
  }, [item.name]);
  return (
    <Input
      ref={(node: HTMLInputElement | null) => { field.current = node; }}
      size="small"
      className={styles.field}
      aria-label={`Rename ${item.name}`}
      defaultValue={item.name}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // The field's keys are its own: not the view's arrows, nor Explorer's shortcuts.
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') onEnd(event.currentTarget.value);
        else if (event.key === 'Escape') onEnd(null);
      }}
      onBlur={(event) => onEnd(event.currentTarget.value)}
    />
  );
}

function NameCell({ item, renaming, onEnd }: { item: FilesItem; renaming: boolean; onEnd: (name: string | null) => void }) {
  if (renaming) return <TableCellLayout media={<ItemIcon item={item} />}><RenameField item={item} onEnd={onEnd} /></TableCellLayout>;
  return (
    <TableCellLayout media={<ItemIcon item={item} />} truncate title={item.name}>
      <span className="agent-computer-file-name">{item.name}</span>
    </TableCellLayout>
  );
}

/** Each row's height in pixels, as the small grid draws it, which the virtual grid places its rows by. */
const ROW = 34;
/**
 * How tall a stretch of rows the virtual grid keeps drawn, in pixels: more than any window is tall, so the rows on show
 * are always drawn, and never more than this many at once.
 */
const DRAWN = 1600;

/** What a details grid shows and does: its items, sort, marks and actions, and its accessible name. */
type GridProps = {
  items: readonly FilesItem[];
  sort: Sort;
  onSort: (sort: Sort) => void;
  marks: ItemMarks;
  actions: ListActions;
  label?: string;
  className?: string;
};

/** The grid's columns and the cell sizes that line them up, and a row's props for an item. */
function useGrid({ marks, actions }: Pick<GridProps, 'marks' | 'actions'>) {
  const styles = useStyles();
  const explorer = useExplorerStyles();
  const restoreFocus = useRestoreFocusTarget();
  const { selected, cut, renaming } = marks;
  // Date, type and size each keep to one line, cut short with an ellipsis rather than wrapping.
  const line = (text: string) => <Text truncate wrap={false} className={styles.oneLine}>{text}</Text>;
  const columns = [
    createTableColumn<FilesItem>({
      columnId: 'name',
      compare: compare.name,
      renderHeaderCell: () => 'Name',
      renderCell: (item) => <NameCell item={item} renaming={item.path === renaming} onEnd={actions.onEndRename} />,
    }),
    createTableColumn<FilesItem>({ columnId: 'modified', compare: compare.modified, renderHeaderCell: () => 'Date modified', renderCell: (item) => line(dateText(item.lastModified)) }),
    createTableColumn<FilesItem>({ columnId: 'type', compare: compare.type, renderHeaderCell: () => 'Type', renderCell: (item) => line(typeText(item)) }),
    createTableColumn<FilesItem>({ columnId: 'size', compare: compare.size, renderHeaderCell: () => 'Size', renderCell: (item) => line(item.folder ? '' : sizeText(item.size)) }),
  ];
  // Every grid sizes its columns the same, so a group's cells line up under the one row of headers.
  const cellClass: Record<TableColumnId, string> = { name: styles.name, modified: mergeClasses(styles.modified, explorer.wideOnly), type: explorer.wideOnly, size: styles.size };
  const rowProps = (item: FilesItem) => ({
    ...restoreFocus,
    className: mergeClasses('agent-computer-file', cut.has(item.path) && styles.cut),
    'data-file-path': item.path,
    'data-kind': kindOf(item),
    'aria-selected': selected.has(item.path),
    appearance: selected.has(item.path) ? ('brand' as const) : ('none' as const),
    onClick: (event: MouseEvent) => actions.onClick(item, event),
    onDoubleClick: () => { if (item.path !== renaming) actions.onOpen(item); },
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => { if (event.key === 'Enter' && !event.altKey && event.target === event.currentTarget) actions.onOpen(item); },
  });
  return { columns, cellClass, rowProps };
}

/** The grid's props in common, whichever grid draws it. */
const gridProps = ({ items, sort, onSort, label = 'Items' }: GridProps) => ({
  items: [...items],
  getRowId: (item: FilesItem) => item.path,
  sortable: true,
  sortState: sort,
  onSortChange: (_: unknown, next: Sort) => onSort(next),
  focusMode: 'row_unstable' as const,
  size: 'small' as const,
  'aria-label': label,
  'aria-multiselectable': true,
});

/**
 * Items in Explorer's details view: Name, Date modified, Type and Size, each column sorting on a click of its header,
 * folders first. A click selects a row, Ctrl and Shift adding to it; a double-click or Enter opens it; a right-click
 * opens its menu. The grid draws only the rows in view and either side of them, so a folder of thousands scrolls as
 * fast as one of ten; it scrolls itself, under its headers.
 */
export function DetailsList({ reveal, ...props }: GridProps & { reveal: { current: Reveal | null } }) {
  const styles = useStyles();
  const { columns, cellClass, rowProps } = useGrid(props);
  const onList = useCallback((list: Reveal | null) => { if (list !== null) reveal.current = list; }, [reveal]);
  // The grid's virtual list takes each row's drawing as its own component, so a new function each render would draw its
  // rows afresh and lose their focus: the list keeps one, which draws each row as this render says.
  const draw = ({ item, rowId }: TableRowData<FilesItem>, style: CSSProperties) => {
    const own = rowProps(item);
    return (
      <RowMenu key={rowId} item={item} open={props.marks.menuOn === item.path} actions={props.actions}>
        <VirtualRow<FilesItem> {...own} className={mergeClasses(own.className, styles.row)} style={style}>
          {({ renderCell, columnId }) => <DataGridCell className={cellClass[columnId]}>{renderCell(item)}</DataGridCell>}
        </VirtualRow>
      </RowMenu>
    );
  };
  const drawing = useRef(draw);
  drawing.current = draw;
  const row = useCallback((item: TableRowData<FilesItem>, style: CSSProperties) => drawing.current(item, style), []);
  return (
    <VirtualGrid {...gridProps(props)} columns={columns} className={mergeClasses(styles.grid, styles.filling, props.className)}>
      <VirtualHeader className={styles.header}>
        <VirtualRow className={styles.headerRow}>
          {({ renderHeaderCell, columnId }) => <DataGridHeaderCell className={cellClass[columnId]}>{renderHeaderCell()}</DataGridHeaderCell>}
        </VirtualRow>
      </VirtualHeader>
      <VirtualBody<FilesItem>
        itemSize={ROW}
        height={DRAWN}
        className={styles.body}
        // The list fills the space under the headers; its drawn stretch stays DRAWN tall, each row keyed by its path.
        listProps={{ ref: onList, className: styles.gutter, style: { height: '100%' }, itemKey: (index: number, rows: TableRowData<FilesItem>[]) => rows[index]?.rowId ?? index }}
      >
        {row}
      </VirtualBody>
    </VirtualGrid>
  );
}

/**
 * A group's items in the details view, as a stock grid drawn whole under the one row of headers: `header` shows a
 * grid's own. Every group scrolls in the one scroll of the list, so a group draws all its rows.
 */
export function GroupDetailsList({ header = true, ...props }: GridProps & { header?: boolean }) {
  const styles = useStyles();
  const explorer = useExplorerStyles();
  const { columns, cellClass, rowProps } = useGrid(props);
  return (
    <DataGrid {...gridProps(props)} columns={columns} className={mergeClasses(styles.grid, props.className)}>
      <DataGridHeader className={mergeClasses(!header && explorer.hidden)}>
        <DataGridRow>
          {({ renderHeaderCell, columnId }) => <DataGridHeaderCell className={cellClass[columnId]}>{renderHeaderCell()}</DataGridHeaderCell>}
        </DataGridRow>
      </DataGridHeader>
      <DataGridBody<FilesItem>>
        {({ item, rowId }) => (
          <RowMenu key={rowId} item={item} open={props.marks.menuOn === item.path} actions={props.actions}>
            <DataGridRow<FilesItem> {...rowProps(item)}>
              {({ renderCell, columnId }) => <DataGridCell className={cellClass[columnId]}>{renderCell(item)}</DataGridCell>}
            </DataGridRow>
          </RowMenu>
        )}
      </DataGridBody>
    </DataGrid>
  );
}
