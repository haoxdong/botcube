import {
  makeStyles, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, mergeClasses, MessageBar, MessageBarBody, tokens,
} from '@fluentui/react-components';
import { Copy20Regular, SelectAllOn20Regular } from '@fluentui/react-icons';
import { Fragment, useRef, useState } from 'react';

import { Conversation, ConversationContent } from '../components/ui/conversation';
import { Fades } from '../app/motion';

export interface ShellCommand {
  command: string;
  output: string;
}

// Windows Terminal's surface in Fluent's dark tokens (ADR 0093); its face, Cascadia Mono, falls back to Fluent's monospace.
const useStyles = makeStyles({
  // Windows Terminal's #0C0C0C: Fluent's nearest dark surface.
  root: { display: 'flex', flexDirection: 'column', backgroundColor: tokens.colorNeutralBackground4 },
  fill: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  scroll: { flex: 1, minHeight: 0 },
  log: {
    padding: `${tokens.spacingVerticalSNudge} ${tokens.spacingHorizontalS}`,
    color: tokens.colorNeutralForeground2,
    fontFamily: `'Cascadia Mono', ${tokens.fontFamilyMonospace}`,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    userSelect: 'text',
  },
  empty: { color: tokens.colorNeutralForeground3 },
  user: { color: tokens.colorPaletteLightGreenForeground1 },
  path: { color: tokens.colorBrandForeground1 },
  cursor: { display: 'inline-block', width: '1ch', height: tokens.lineHeightBase300, verticalAlign: 'top', backgroundColor: tokens.colorNeutralForeground2 },
  error: { padding: tokens.spacingHorizontalS },
});

function Prompt({ user }: { user: string }) {
  const styles = useStyles();
  return <><span className={styles.user}>{`${user}@computer`}</span>:<span className={styles.path}>~</span>{'$ '}</>;
}

/**
 * The Agent Computer's Terminal, drawn as Windows Terminal and read-only: the shell commands the agent ran, each after its
 * prompt with its output as plain text, then, while the agent is idle, a fresh prompt and cursor. It opens at the latest
 * output and follows new output until the user scrolls up to read; scrolling back to the end follows again.
 */
export function Terminal({ commands, error, user, idle }: { commands: readonly ShellCommand[]; error: string | null; user: string; idle: boolean }) {
  const styles = useStyles();
  return (
    <div className={mergeClasses('agent-computer-terminal', styles.root)}>
      <Fades>{error === null ? (
        <div key="log" className={styles.fill}><TerminalLog commands={commands} user={user} idle={idle} /></div>
      ) : (
        <div key="error" className={styles.error}>
          <MessageBar intent="error" role="alert"><MessageBarBody>{error}</MessageBarBody></MessageBar>
        </div>
      )}</Fades>
    </div>
  );
}

function TerminalLog({ commands, user, idle }: { commands: readonly ShellCommand[]; user: string; idle: boolean }) {
  const styles = useStyles();
  const contentRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState('');
  return (
    <Menu openOnContext onOpenChange={(_, { open }) => { if (open) setSelected(getSelection()?.toString() ?? ''); }}>
      <MenuTrigger disableButtonEnhancement>
        <div className={styles.fill}>
          <Conversation className={styles.scroll} initial="instant" resize="instant" aria-label="Terminal" tabIndex={0}>
            <ConversationContent className="block gap-0 p-0">
              <div ref={contentRef} className={styles.log}>
            <Fades>{commands.length === 0 ? (
              <div key="empty" className={mergeClasses('agent-computer-terminal-empty', styles.empty)}>No commands yet</div>
            ) : (
              commands.map(({ command, output }, index) => (
                <Fragment key={index}>
                  <div className="agent-computer-terminal-line"><Prompt user={user} />{command}</div>
                  <div className="agent-computer-terminal-output">{output}</div>
                </Fragment>
              ))
            )}</Fades>
            <Fades>{idle && commands.length > 0 && (
              <div key="prompt" className="agent-computer-terminal-prompt">
                <Prompt user={user} /><span className={styles.cursor} aria-hidden="true" />
              </div>
            )}</Fades>
              </div>
            </ConversationContent>
          </Conversation>
        </div>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem icon={<Copy20Regular />} secondaryContent="Ctrl+C" disabled={selected === ''} onClick={() => void navigator.clipboard.writeText(selected)}>Copy</MenuItem>
          <MenuItem icon={<SelectAllOn20Regular />} onClick={() => { if (contentRef.current !== null) getSelection()?.selectAllChildren(contentRef.current); }}>Select all</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
