// File Explorer's details view: a stock Fluent DataGrid, each row with its context menu (ADR 0093).
import {
  createTableColumn, DataGrid, DataGridBody, DataGridCell, DataGridHeader, DataGridHeaderCell, DataGridRow, Input, makeStyles, mergeClasses,
  Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, TableCellLayout, Text, tokens, useRestoreFocusTarget, type SortDirection, type TableColumnId,
} from '@fluentui/react-components';
import { ArrowDownload20Regular, Code20Regular, Cut20Regular, Delete20Regular, Document20Regular, DocumentText20Regular, Folder20Filled, Image20Regular, Open20Regular, Rename20Regular } from '@fluentui/react-icons';
import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';
import { fileExtension } from '../components/file-type-icon';
import { compare, dateText, kindOf, sizeText, typeText, type FilesItem } from './files-items';
import { useExplorerStyles } from './files-explorer-nav';
import { FOLDER } from './windows-window';

export type Sort = { sortColumn: TableColumnId | undefined; sortDirection: SortDirection };

const TEXT = new Set(['md', 'txt']);
const CODE = new Set(['js', 'json', 'py', 'ts']);

function ItemIcon({ item }: { item: FilesItem }) {
  const kind = kindOf(item);
  if (kind === 'folder') return <Folder20Filled color={FOLDER} />;
  if (kind === 'image') return <Image20Regular />;
  const extension = fileExtension(item.name);
  if (TEXT.has(extension)) return <DocumentText20Regular />;
  return CODE.has(extension) ? <Code20Regular /> : <Document20Regular />;
}

const useStyles = makeStyles({
  grid: { minWidth: 0 },
  // As in File Explorer, the column headers stay at the top while the rows scroll under them.
  header: { position: 'sticky', top: 0, zIndex: 1, backgroundColor: tokens.colorNeutralBackground1 },
  name: { flexGrow: 3, minWidth: 0 },
  modified: { minWidth: '150px' },
  size: { flexGrow: 1, minWidth: '72px' },
  oneLine: { minWidth: 0 },
  field: { width: '100%' },
  cut: { opacity: 0.5 },
});

/** What the list does to an item: open it, act on it from its menu, or end its rename (null cancels). */
export interface ListActions {
  onSelect: (path: string) => void;
  onOpen: (item: FilesItem) => void;
  onCut: (item: FilesItem) => void;
  onDownload: (item: FilesItem) => void;
  onStartRename: (item: FilesItem) => void;
  onDelete: (item: FilesItem) => void;
  onEndRename: (name: string | null) => void;
}

/** The name field of the file being renamed, its name selected up to its extension once it shows. */
function RenameField({ item, onEnd }: { item: FilesItem; onEnd: (name: string | null) => void }) {
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
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') onEnd(event.currentTarget.value);
        else if (event.key === 'Escape') {
          event.stopPropagation();
          onEnd(null);
        }
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

/** A row's menu: Open, then for a file Cut, Download, Rename and Delete. */
function RowMenu({ item, actions, children }: { item: FilesItem; actions: ListActions; children: ReactElement }) {
  const entries = [
    { label: 'Open', icon: <Open20Regular />, act: actions.onOpen },
    ...(item.folder ? [] : [
      { label: 'Cut', icon: <Cut20Regular />, act: actions.onCut },
      { label: 'Download', icon: <ArrowDownload20Regular />, act: actions.onDownload },
      { label: 'Rename', icon: <Rename20Regular />, act: actions.onStartRename },
      { label: 'Delete', icon: <Delete20Regular />, act: actions.onDelete },
    ]),
  ];
  return (
    <Menu openOnContext onOpenChange={(_, data) => { if (data.open) actions.onSelect(item.path); }}>
      <MenuTrigger disableButtonEnhancement>{children}</MenuTrigger>
      <MenuPopover>
        <MenuList>
          {entries.map(({ label, icon, act }) => <MenuItem key={label} icon={icon} onClick={() => act(item)}>{label}</MenuItem>)}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

/**
 * The open place's items in Explorer's details view: Name, Date modified, Type and Size, each column sorting on a click
 * of its header, folders first. A click selects a row; a double-click or Enter opens it; a right-click opens its menu.
 */
export function DetailsList({ items, sort, onSort, selected, cut, renaming, actions, className }: {
  items: readonly FilesItem[];
  sort: Sort;
  onSort: (sort: Sort) => void;
  selected: string | null;
  /** The cut file's path, its row dimmed until it is pasted. */
  cut: string | null;
  renaming: string | null;
  actions: ListActions;
  className?: string;
}) {
  const styles = useStyles();
  const explorer = useExplorerStyles();
  const restoreFocus = useRestoreFocusTarget();
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
  const cellClass: Record<TableColumnId, string> = { name: styles.name, modified: mergeClasses(styles.modified, explorer.wideOnly), type: explorer.wideOnly, size: styles.size };
  return (
    <DataGrid
      items={[...items]}
      columns={columns}
      getRowId={(item: FilesItem) => item.path}
      sortable
      sortState={sort}
      onSortChange={(_, next) => onSort(next)}
      focusMode="row_unstable"
      size="small"
      aria-label="Items"
      className={mergeClasses(styles.grid, className)}
    >
      <DataGridHeader className={styles.header}>
        <DataGridRow>
          {({ renderHeaderCell, columnId }) => <DataGridHeaderCell className={cellClass[columnId]}>{renderHeaderCell()}</DataGridHeaderCell>}
        </DataGridRow>
      </DataGridHeader>
      <DataGridBody<FilesItem>>
        {({ item, rowId }) => (
          <RowMenu key={rowId} item={item} actions={actions}>
            <DataGridRow<FilesItem>
              {...restoreFocus}
              className={mergeClasses('agent-computer-file', item.path === cut && styles.cut)}
              data-file-path={item.path}
              data-kind={kindOf(item)}
              aria-selected={item.path === selected}
              appearance={item.path === selected ? 'brand' : 'none'}
              onClick={() => actions.onSelect(item.path)}
              onDoubleClick={() => { if (item.path !== renaming) actions.onOpen(item); }}
              onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => { if (event.key === 'Enter' && event.target === event.currentTarget) actions.onOpen(item); }}
            >
              {({ renderCell, columnId }) => <DataGridCell className={cellClass[columnId]}>{renderCell(item)}</DataGridCell>}
            </DataGridRow>
          </RowMenu>
        )}
      </DataGridBody>
    </DataGrid>
  );
}
