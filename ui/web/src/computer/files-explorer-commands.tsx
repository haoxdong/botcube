// File Explorer's command bar, from stock Fluent parts (ADR 0093): commands that don't fit go into See more.
import {
  makeStyles, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, mergeClasses, Overflow, OverflowDivider, OverflowItem, tokens, Toolbar,
  ToolbarButton, ToolbarDivider, Tooltip, useIsOverflowItemVisible, useOverflowMenu, useRestoreFocusTarget,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowDownload20Regular, ArrowUpload20Regular, ClipboardPaste20Regular, Cut20Regular, Delete20Regular, MoreHorizontal20Regular,
  Rename20Regular, type FluentIcon,
} from '@fluentui/react-icons';
import { useExplorerStyles } from './files-explorer-nav';

const useStyles = makeStyles({
  commands: { borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}` },
});

/** A command of the bar, as its icon button and as its See more item. */
type Command = { id: string; label: string; Icon: FluentIcon; disabled: boolean; act: () => void };

/** A command's See more item, shown while its button doesn't fit. */
function OverflowCommand({ id, label, Icon, disabled, act }: Command) {
  const explorer = useExplorerStyles();
  const visible = useIsOverflowItemVisible(id);
  return <MenuItem icon={<Icon />} disabled={disabled} onClick={act} className={mergeClasses(visible && explorer.hidden)}>{label}</MenuItem>;
}

/** See more: the commands whose buttons don't fit, Upload for New. */
function SeeMore({ commands, onUpload }: { commands: readonly Command[]; onUpload: () => void }) {
  const explorer = useExplorerStyles();
  const restoreFocus = useRestoreFocusTarget();
  const { ref, isOverflowing } = useOverflowMenu<HTMLButtonElement>();
  const newVisible = useIsOverflowItemVisible('new');
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <ToolbarButton
          {...restoreFocus}
          ref={(node: HTMLButtonElement | null) => { ref.current = node; }}
          icon={<MoreHorizontal20Regular />}
          aria-label="See more"
          className={mergeClasses(!isOverflowing && explorer.hidden)}
        />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem icon={<ArrowUpload20Regular />} onClick={onUpload} className={mergeClasses(newVisible && explorer.hidden)}>Upload</MenuItem>
          {commands.map((command) => <OverflowCommand key={command.id} {...command} />)}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

/**
 * New, the only labelled command, then each command as an icon button with its name as a tooltip. Whatever doesn't fit
 * the window's width goes, from the end, into See more.
 */
export function CommandBar({ hasFile, canPaste, onUpload, onCut, onPaste, onDownload, onRename, onDelete }: {
  /** Whether a file is selected, for Cut, Download, Rename and Delete to act on. */
  hasFile: boolean;
  canPaste: boolean;
  onUpload: () => void;
  onCut: () => void;
  onPaste: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const styles = useStyles();
  const restoreFocus = useRestoreFocusTarget();
  const commands: Command[] = [
    { id: 'cut', label: 'Cut', Icon: Cut20Regular, disabled: !hasFile, act: onCut },
    { id: 'paste', label: 'Paste', Icon: ClipboardPaste20Regular, disabled: !canPaste, act: onPaste },
    { id: 'download', label: 'Download', Icon: ArrowDownload20Regular, disabled: !hasFile, act: onDownload },
    { id: 'rename', label: 'Rename', Icon: Rename20Regular, disabled: !hasFile, act: onRename },
    { id: 'delete', label: 'Delete', Icon: Delete20Regular, disabled: !hasFile, act: onDelete },
  ];
  return (
    <Overflow>
      <Toolbar aria-label="Commands" size="small" className={styles.commands}>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <OverflowItem id="new" groupId="new">
              <ToolbarButton icon={<Add20Regular />}>New</ToolbarButton>
            </OverflowItem>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<ArrowUpload20Regular />} onClick={onUpload}>Upload</MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
        <OverflowDivider groupId="new">
          <ToolbarDivider />
        </OverflowDivider>
        {commands.map(({ id, label, Icon, disabled, act }) => (
          <OverflowItem key={id} id={id} groupId="edit">
            <Tooltip content={label} relationship="label">
              <ToolbarButton {...(id === 'delete' ? restoreFocus : {})} icon={<Icon />} aria-label={label} disabled={disabled} onClick={act} />
            </Tooltip>
          </OverflowItem>
        ))}
        <SeeMore commands={commands} onUpload={onUpload} />
      </Toolbar>
    </Overflow>
  );
}

