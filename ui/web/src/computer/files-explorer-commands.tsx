// File Explorer's command bar, from stock Fluent parts (ADR 0093): commands that don't fit go into See more.
import {
  makeStyles, Menu, MenuButton, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger, mergeClasses, Overflow, OverflowDivider, OverflowItem, tokens,
  Toolbar, ToolbarButton, ToolbarDivider, Tooltip, useIsOverflowItemVisible, useMergedRefs, useOverflowMenu, useRestoreFocusTarget,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowDownload20Regular, Copy20Regular, ArrowSort20Regular, ArrowSwap20Regular, ClipboardPaste20Regular, Cut20Regular,
  Delete20Regular, Grid20Regular, GroupList20Regular, Info20Regular, MoreHorizontal20Regular, Rename20Regular, SelectAllOff20Regular,
  SelectAllOn20Regular, type FluentIcon,
} from '@fluentui/react-icons';
import type { ReactElement } from 'react';
import { LETTERS, useKeytip } from './files-explorer-keytips';
import { GroupMenuList, NewItems, SortMenuList, Submenu, ViewMenuList, type Arrangement, type NewCommands } from './files-explorer-menus';
import { useExplorerStyles } from './files-explorer-nav';

const useStyles = makeStyles({
  commands: { borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}` },
});

/** A command of the bar, as its icon button and as its See more item. */
type Command = { id: keyof typeof LETTERS.commands; label: string; Icon: FluentIcon; disabled: boolean; act: () => void };

/** A command's icon button, its name as its tooltip, with its keytip. */
function CommandButton({ id, label, Icon, disabled, act, keytips, restoreFocus }: Command & { keytips: boolean; restoreFocus: object }) {
  return (
    <OverflowItem id={id} groupId="edit">
      <Tooltip content={label} relationship="label">
        <ToolbarButton {...restoreFocus} ref={useKeytip(LETTERS.commands[id], keytips)} icon={<Icon />} aria-label={label} disabled={disabled} onClick={act} />
      </Tooltip>
    </OverflowItem>
  );
}

/** View's or Sort's menu button, with its keytip. */
function ArrangeButton({ id, label, Icon, keytips, children }: { id: 'view' | 'sort'; label: string; Icon: FluentIcon; keytips: boolean; children: ReactElement }) {
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <OverflowItem id={id} groupId="arrange">
          <MenuButton ref={useKeytip(LETTERS.commands[id], keytips)} appearance="subtle" size="small" icon={<Icon />}>{label}</MenuButton>
        </OverflowItem>
      </MenuTrigger>
      <MenuPopover>{children}</MenuPopover>
    </Menu>
  );
}

/** A command's See more item, shown while its button doesn't fit. */
function OverflowCommand({ id, label, Icon, disabled, act }: Command) {
  const explorer = useExplorerStyles();
  const visible = useIsOverflowItemVisible(id);
  return <MenuItem icon={<Icon />} disabled={disabled} onClick={act} className={mergeClasses(visible && explorer.hidden)}>{label}</MenuItem>;
}

/** View's or Sort's See more item, shown while its button doesn't fit. */
function OverflowMenu({ id, label, Icon, children }: { id: string; label: string; Icon: FluentIcon; children: ReactElement }) {
  const explorer = useExplorerStyles();
  const visible = useIsOverflowItemVisible(id);
  return <Submenu label={label} icon={<Icon />} className={mergeClasses(visible && explorer.hidden)}>{children}</Submenu>;
}

/** What See more selects, and Properties. */
type SelectionCommands = { onSelectAll: () => void; onSelectNone: () => void; onInvert: () => void; onProperties: () => void };

/** Sort's items, with Group by. */
function SortAndGroup({ arrangement }: { arrangement: Arrangement }) {
  return (
    <SortMenuList arrangement={arrangement}>
      <MenuDivider />
      <Submenu label="Group by" icon={<GroupList20Regular />}><GroupMenuList arrangement={arrangement} /></Submenu>
    </SortMenuList>
  );
}

/**
 * See more, at the end of the bar: Select all, Select none, Invert selection and Properties, after the commands whose
 * buttons don't fit and New's items.
 */
function SeeMore({ commands, arrangement, selection, keytips, news }: { commands: readonly Command[]; arrangement: Arrangement; selection: SelectionCommands; keytips: boolean; news: NewCommands }) {
  const explorer = useExplorerStyles();
  const newVisible = useIsOverflowItemVisible('new');
  // Always shown, for its own items; the bar leaves room for it as it overflows.
  const { ref } = useOverflowMenu<HTMLButtonElement>();
  const keytip = useKeytip(LETTERS.commands.more, keytips);
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Tooltip content="See more" relationship="label">
          <ToolbarButton ref={useMergedRefs(ref, keytip)} icon={<MoreHorizontal20Regular />} aria-label="See more" />
        </Tooltip>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <Submenu label="New" icon={<Add20Regular />} className={mergeClasses(newVisible && explorer.hidden)}><MenuList><NewItems {...news} /></MenuList></Submenu>
          {commands.map((command) => <OverflowCommand key={command.id} {...command} />)}
          <OverflowMenu id="view" label="View" Icon={Grid20Regular}><ViewMenuList arrangement={arrangement} /></OverflowMenu>
          <OverflowMenu id="sort" label="Sort" Icon={ArrowSort20Regular}><SortAndGroup arrangement={arrangement} /></OverflowMenu>
          <MenuItem icon={<SelectAllOn20Regular />} onClick={selection.onSelectAll}>Select all</MenuItem>
          <MenuItem icon={<SelectAllOff20Regular />} onClick={selection.onSelectNone}>Select none</MenuItem>
          <MenuItem icon={<ArrowSwap20Regular />} onClick={selection.onInvert}>Invert selection</MenuItem>
          <MenuDivider />
          <MenuItem icon={<Info20Regular />} onClick={selection.onProperties}>Properties</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

/**
 * New, then each command as an icon button with its name as a tooltip, acting on every selected file, then View and
 * Sort, and See more. Whatever doesn't fit the window's width goes, from the end, into See more.
 */
export function CommandBar({ hasFiles, canCopy, canRename, canPaste, canNewFolder, arrangement, selection, keytips, onNewFolder, onUpload, onCut, onCopy, onPaste, onDownload, onRename, onDelete }: {
  /** Whether a file is selected, for Cut, Download and Delete to act on. */
  hasFiles: boolean;
  /** Whether anything is selected, a folder too, for Copy. */
  canCopy: boolean;
  /** Whether one item alone is selected, for Rename. */
  canRename: boolean;
  canPaste: boolean;
  /** Whether a folder is open to make one in: not Home. */
  canNewFolder: boolean;
  arrangement: Arrangement;
  selection: SelectionCommands;
  /** Whether Alt shows the bar's letters: its tab is in front, with no context menu over it. */
  keytips: boolean;
  onNewFolder: () => void;
  onUpload: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const styles = useStyles();
  const restoreFocus = useRestoreFocusTarget();
  const commands: Command[] = [
    { id: 'cut', label: 'Cut', Icon: Cut20Regular, disabled: !hasFiles, act: onCut },
    { id: 'copy', label: 'Copy', Icon: Copy20Regular, disabled: !canCopy, act: onCopy },
    { id: 'paste', label: 'Paste', Icon: ClipboardPaste20Regular, disabled: !canPaste, act: onPaste },
    { id: 'download', label: 'Download', Icon: ArrowDownload20Regular, disabled: !hasFiles, act: onDownload },
    { id: 'rename', label: 'Rename', Icon: Rename20Regular, disabled: !canRename, act: onRename },
    { id: 'delete', label: 'Delete', Icon: Delete20Regular, disabled: !hasFiles, act: onDelete },
  ];
  const newKeytip = useKeytip(LETTERS.commands.new, keytips);
  const news = { canNewFolder, onNewFolder, onUpload };
  return (
    <Overflow>
      <Toolbar aria-label="Commands" size="small" className={styles.commands}>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <OverflowItem id="new" groupId="new">
              <ToolbarButton ref={newKeytip} icon={<Add20Regular />}>New</ToolbarButton>
            </OverflowItem>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <NewItems {...news} />
            </MenuList>
          </MenuPopover>
        </Menu>
        <OverflowDivider groupId="new">
          <ToolbarDivider />
        </OverflowDivider>
        {commands.map((command) => <CommandButton key={command.id} {...command} keytips={keytips} restoreFocus={command.id === 'delete' ? restoreFocus : {}} />)}
        <OverflowDivider groupId="edit">
          <ToolbarDivider />
        </OverflowDivider>
        <ArrangeButton id="view" label="View" Icon={Grid20Regular} keytips={keytips}><ViewMenuList arrangement={arrangement} /></ArrangeButton>
        <ArrangeButton id="sort" label="Sort" Icon={ArrowSort20Regular} keytips={keytips}><SortAndGroup arrangement={arrangement} /></ArrangeButton>
        <SeeMore commands={commands} arrangement={arrangement} selection={selection} keytips={keytips} news={news} />
      </Toolbar>
    </Overflow>
  );
}
