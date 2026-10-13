import { ClipboardPaste, Copy, Folder, Keyboard, Laptop, MousePointer2, X, type LucideIcon } from 'lucide-react';
import { Fragment, useCallback, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type ComponentType } from 'react';

import { BrowserLiveFrame, type LiveViewConnection, type BrowserLiveFrameProps } from './browser-live-frame';
import { failureDetail } from './failure-detail';
import { FOLDER_ICON } from './files-app';

/** The chat's Agent Computer: its browser and who drives it while awake, and its last screenshot either way. */
export type AgentComputerState =
  | { state: 'awake'; browserSessionId: string; control: 'user' | 'agent'; screenshot: string | null }
  | { state: 'starting' | 'asleep'; screenshot: string | null };

interface ChatServiceOptions {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}

async function chatServiceRequest(
  path: string,
  query: Record<string, string>,
  method: 'GET' | 'POST',
  fallback: string,
  { chatServiceUrl, fetchImpl = fetch }: ChatServiceOptions,
  NotFound: new (message: string) => Error = Error,
): Promise<Response> {
  const url = new URL(path, chatServiceUrl);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await fetchImpl(url.toString(), { method, credentials: 'include' });
  if (response.ok) return response;
  throw new (response.status === 404 ? NotFound : Error)(await failureDetail(response, fallback));
}

type BrowserControl = (browserSessionId: string, options: ChatServiceOptions) => Promise<void>;

const browserControl =
  (path: string, fallback: string): BrowserControl =>
  async (browserSessionId, options) =>
    void (await chatServiceRequest(path, { session_id: browserSessionId }, 'POST', fallback, options));

/** Take-over: the agent's automation stream shuts off until the user hands the browser back. */
export const takeOverBrowser = browserControl('/browser-take-over', 'Take over failed');
/** Return control: the agent drives the browser again. */
export const handBackBrowser = browserControl('/browser-hand-back', 'Hand back failed');

const agentComputerRequest =
  (path: string, method: 'GET' | 'POST', fallback: string, NotFound?: new (message: string) => Error) =>
  async (threadId: string, options: ChatServiceOptions): Promise<AgentComputerState> =>
    (await (await chatServiceRequest(path, { thread_id: threadId }, method, fallback, options, NotFound)).json()) as AgentComputerState;

/** A wake before the chat's first message: a chat becomes a Session, with a computer to wake, at that message (ADR 0077). */
export class ChatNotStarted extends Error {}

/** The chat's Agent Computer, awake or asleep. */
export const loadAgentComputer = agentComputerRequest('/agent-computer', 'GET', 'Agent Computer request failed');
/** Wake: start the chat's browser from the account's browser profile. */
export const wakeAgentComputer = agentComputerRequest('/agent-computer/wake', 'POST', 'Wake failed', ChatNotStarted);

/** The apps in the dock: Chrome is the live browser, Terminal the agent's commands and their output, Files the account's folder. */
export type DockApp = 'Chrome' | 'Terminal' | 'Files';
const DOCK_APPS: readonly DockApp[] = ['Files', 'Chrome', 'Terminal'];
/** Each dock app's icon shapes, drawn as dots' dock draws its apps; the app's name is its label and tooltip. */
const DOCK_ICONS: Record<DockApp, ReactNode> = {
  // The Chromium logo: three blue segments around a blue core in a white ring.
  Chrome: (
    <>
      <path d="M16 9.4H28.35A14 14 0 0 1 15.54 29.99L21.72 19.3Z" fill="#1a73e8" />
      <path d="M21.72 19.3L15.54 29.99A14 14 0 0 1 4.11 8.61L10.28 19.3Z" fill="#4285f4" />
      <path d="M10.28 19.3L4.11 8.61A14 14 0 0 1 28.35 9.4H16Z" fill="#8ab4f8" />
      <circle cx="16" cy="16" r="6.6" fill="#ffffff" />
      <circle cx="16" cy="16" r="5.2" fill="#4285f4" />
    </>
  ),
  // A grey tile with a prompt.
  Terminal: (
    <>
      <rect x="2" y="3" width="28" height="26" rx="6" fill="#71717a" />
      <path d="M9 12l5 4-5 4M16.5 21h6.5" fill="none" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  Files: FOLDER_ICON,
};

/** A shell command the agent ran, with the output its result carried. */
export interface ShellCommand {
  command: string;
  output: string;
}

/**
 * The Agent Computer: a desktop with a dock, framing the agent's live browser or, asleep, its last
 * screen, or its Terminal, or its Files.
 */
export function AgentComputer({
  agentName,
  BrowserFrame = BrowserLiveFrame,
  active = true,
  chatId,
  app,
  files,
  computer,
  commands,
  terminalError = null,
  liveViewExhausted = false,
  control,
  running,
  busy,
  error,
  notice,
  onTakeOver,
  onHandBack,
  starting,
  onStop,
  onOpenApp,
  onLive,
  onLiveEnded,
  onConnectionChange,
}: {
  agentName: string;
  BrowserFrame?: ComponentType<BrowserLiveFrameProps> | undefined;
  active?: boolean;
  /** The open chat's id: the Terminal's host is named after it, as dots names it after the agent's machine. */
  chatId: string;
  app: DockApp;
  /** The Files app's window. */
  files: ReactNode;
  computer: AgentComputerState;
  commands: readonly ShellCommand[];
  /** Failure to project the completed shell calls, separate from their upstream execution. */
  terminalError?: string | null;
  liveViewExhausted?: boolean;
  control: 'agent' | 'user';
  /** The agent is running a Turn, which Stop ends. */
  running: boolean;
  busy: boolean;
  error: string | null;
  /** Why a wake has nothing to start yet: status, not a failure. */
  notice: string | null;
  onTakeOver: (browserSessionId: string) => void;
  onHandBack: (browserSessionId: string) => void;
  /** A wake is starting the browser. */
  starting: boolean;
  onStop: (() => void) | null;
  onOpenApp: (app: DockApp) => void;
  /** The browser's live view shows: its first frame (`painted`), or the viewer's own state while none has come. */
  onLive?: (painted: boolean) => void;
  /** The stream the live view showed ended: it connects again once the computer is looked at again, a new value. */
  onLiveEnded?: () => void;
  onConnectionChange?: ((connected: boolean) => void) | undefined;
}) {
  // The awake browser's live view once it settles: its connection, or null when it failed and says why.
  const [live, setLive] = useState<{ sessionId: string; connection: LiveViewConnection | null } | null>(null);
  // The computer whose live view's stream ended: the live view connects again once the computer has been looked at
  // again, asleep or not.
  const [ended, setEnded] = useState<AgentComputerState | null>(null);
  const [sheet, setSheet] = useState(false);
  const returning = useRef(false);
  useLayoutEffect(() => {
    if (!active) { returning.current = false; setSheet(false); }
  }, [active]);
  useLayoutEffect(() => {
    if (returning.current && control === 'agent') {
      returning.current = false;
      setSheet(false);
    }
    if (!busy && error !== null) returning.current = false;
  }, [control, busy, error]);
  const browserSessionId = computer.state === 'awake' ? computer.browserSessionId : null;
  const currentBrowser = useRef(browserSessionId);
  currentBrowser.current = browserSessionId;
  const connectionCallback = useRef(onConnectionChange);
  connectionCallback.current = onConnectionChange;
  const availability = useRef<{ sessionId: string | null; connected: boolean }>({ sessionId: null, connected: false });
  const connectionChanged = useCallback((sessionId: string, connected: boolean) => {
    if (currentBrowser.current !== sessionId) return;
    if (availability.current.sessionId === sessionId && availability.current.connected === connected) return;
    availability.current = { sessionId, connected };
    connectionCallback.current?.(connected);
  }, []);
  const onBrowserConnectionChange = useCallback((connected: boolean) => {
    if (browserSessionId !== null) connectionChanged(browserSessionId, connected);
  }, [browserSessionId, connectionChanged]);
  const [watchedBrowser, setWatchedBrowser] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (active) setWatchedBrowser(browserSessionId);
  }, [active, browserSessionId, computer]);
  useLayoutEffect(() => { returning.current = false; }, [browserSessionId]);
  // The live view may report the same connection again: an unchanged report keeps the state, or each would render anew.
  const settle = (sessionId: string, connection: LiveViewConnection | null) => {
    if (currentBrowser.current !== sessionId) return;
    setLive((prior) => (prior?.sessionId === sessionId && prior.connection === connection ? prior : { sessionId, connection }));
  };
  const hasViewer = browserSessionId !== null && (active || watchedBrowser === browserSessionId) && ended !== computer && !liveViewExhausted;
  useLayoutEffect(() => {
    if (availability.current.sessionId === browserSessionId && (hasViewer || !availability.current.connected)) return;
    availability.current = { sessionId: browserSessionId, connected: false };
    connectionCallback.current?.(false);
  }, [hasViewer, browserSessionId]);
  const settled = live !== null && live.sessionId === browserSessionId;
  const connection = settled ? live.connection : null;
  // Chrome's last screen stands in for its live view until that settles; Terminal and Files cover both.
  const covered = app === 'Chrome' && !settled;
  const title = `${agentName}'s computer`;
  // The Terminal's host, named after the chat as dots names it after the agent's machine.
  const host = chatId.replaceAll('-', '').slice(0, 12);
  const handBack = (sessionId: string) => {
    returning.current = true;
    onHandBack(sessionId);
  };
  return (
    <div
      className={sheet ? 'agent-computer agent-computer-sheet' : 'agent-computer'}
      role={sheet ? 'dialog' : undefined}
      aria-label={sheet ? title : undefined}
    >
      {sheet && (
        <div className="agent-computer-sheet-head">
          <button type="button" className="agent-computer-sheet-close" aria-label="Close computer" title="Close computer" onClick={() => { returning.current = false; setSheet(false); }}>
            <X aria-hidden="true" />
          </button>
          <span className="agent-computer-sheet-title"><Laptop aria-hidden="true" />{title}</span>
        </div>
      )}
      <div className="agent-computer-desktop">
        <div className="agent-computer-window">
          {/* Every app draws on the agent's 16:9 screen. The live view stays connected under Terminal and Files, so
              going back to Chrome shows the browser at once. Until it shows the browser, its last screen stands in,
              dimmed, over the desktop: never a black frame. */}
          <div className={covered ? 'agent-computer-screen agent-computer-screen-covered' : 'agent-computer-screen'}>
            {hasViewer && (
              <BrowserFrame
                sessionId={browserSessionId}
                expanded={sheet}
                interactive={active && sheet && control === 'user' && !busy && app === 'Chrome'}
                lastScreen={computer.screenshot}
                recoverOnStall
                onConnectionChange={onBrowserConnectionChange}
                onReleased={() => settle(browserSessionId, null)}
                onConnection={(connection, painted) => {
                  if (currentBrowser.current !== browserSessionId) return;
                  onLive?.(painted);
                  settle(browserSessionId, connection);
                }}
                onError={() => settle(browserSessionId, null)}
                onEnded={() => {
                  if (currentBrowser.current !== browserSessionId) return;
                  setWatchedBrowser(null);
                  setEnded(computer);
                  setLive(null);
                  onLiveEnded?.();
                }}
              />
            )}
            {covered && (
              <div className="agent-computer-cover">
                {computer.screenshot !== null && (
                  <img className="agent-computer-screenshot" src={computer.screenshot} alt="The last screen" />
                )}
                {!liveViewExhausted && (starting || browserSessionId !== null) && <p className="agent-computer-starting" role="status">{computer.state === 'awake' ? 'Connecting…' : 'Starting…'}</p>}
                {notice && <p className="agent-computer-notice" role="status">{notice}</p>}
              </div>
            )}
            {/* Terminal and Files fill the window Chrome's live view fills; the dock switches between them, closing none. */}
            {app === 'Terminal' && (
              <section className="agent-computer-app" aria-label="Terminal">
                <div className="agent-computer-terminal-bar">
                  <Folder aria-hidden="true" />
                  <span>workspace — zsh</span>
                </div>
                <Terminal commands={commands} error={terminalError} prompt={`agent@${host} workspace %`} />
              </section>
            )}
            {app === 'Files' && <section className="agent-computer-app" aria-label="Files">{files}</section>}
            {!sheet && app === 'Chrome' && <button type="button" className="agent-computer-screen-open" aria-label="View computer" disabled={!active} onClick={() => { returning.current = false; setSheet(true); }} />}
          </div>
        </div>
        <nav className="agent-computer-dock" aria-label="Dock">
          {DOCK_APPS.map((dockApp) => (
              <button
                key={dockApp}
                type="button"
                className={`agent-computer-dock-app${dockApp === app ? ' agent-computer-dock-app-active' : ''}`}
                aria-label={dockApp}
                title={dockApp}
                aria-current={dockApp === app ? 'true' : undefined}
                onClick={() => onOpenApp(dockApp)}
              >
                <svg className="agent-computer-dock-icon" viewBox="0 0 32 32" aria-hidden="true">
                  {DOCK_ICONS[dockApp]}
                </svg>
              </button>
          ))}
        </nav>
      </div>
      {/* Who drives, attached under the desktop as in dots. */}
      <div className="agent-computer-bar">
        {browserSessionId !== null && (
          <span className="agent-computer-pill">
            {control === 'agent' ? `${agentName} has control` : 'You have control'}
            <span aria-hidden="true"> · </span>
            <button type="button" className="agent-computer-control" disabled={busy || !active} onClick={() => {
                if (control === 'agent') {
                  returning.current = false;
                  setSheet(true);
                  onTakeOver(browserSessionId);
                } else handBack(browserSessionId);
              }}>
              {control === 'agent' ? 'Take over' : 'Return control'}
            </button>
          </span>
        )}
        {running && <button type="button" className="agent-computer-stop" disabled={!active || onStop === null} onClick={onStop ?? undefined}>Stop</button>}
      </div>
      {active && sheet && browserSessionId !== null && control === 'user' && (
        <TouchToolbar connection={connection} busy={busy} />
      )}
      {error && <p className="agent-computer-error" role="alert">{error}</p>}
    </div>
  );
}

/** The Terminal: a read-only log of the shell commands the agent ran, each after zsh's prompt, and their output. */
function Terminal({ commands, error, prompt }: { commands: readonly ShellCommand[]; error: string | null; prompt: string }) {
  const log = useRef<HTMLDivElement>(null);
  // It opens at the latest output and follows new output, until the user scrolls up to read; scrolling back down follows again.
  const following = useRef(true);
  useLayoutEffect(() => {
    if (log.current !== null && following.current) log.current.scrollTop = log.current.scrollHeight;
  }, [commands, error]);
  if (error !== null) return <p className="agent-computer-error" role="alert">{error}</p>;
  return (
    <div
      ref={log}
      className="agent-computer-terminal"
      role="log"
      aria-label="Terminal"
      onScroll={({ currentTarget: { scrollHeight, scrollTop, clientHeight } }) => {
        following.current = scrollHeight - scrollTop - clientHeight < 2;
      }}
    >
      {commands.length === 0 ? (
        <div className="agent-computer-terminal-empty">No commands yet</div>
      ) : (
        commands.map(({ command, output }, index) => (
          <Fragment key={index}>
            <div className="agent-computer-terminal-line">{`${prompt} ${command}`}</div>
            <div className="agent-computer-terminal-output">{output}</div>
          </Fragment>
        ))
      )}
    </div>
  );
}

// DOM key locations, as DCV takes them.
const STANDARD = 0;
const LEFT = 1;

const pressKey = (connection: LiveViewConnection, key: string) => connection.sendKeyboardShortcut([{ key, location: STANDARD }]);

/** Text as one key press per character: a phone's keyboard and clipboard give text, not keys. */
function typeText(connection: LiveViewConnection, text: string) {
  for (const key of text) pressKey(connection, key);
}

const KEY_FOR_INPUT: Partial<Record<string, string>> = { deleteContentBackward: 'Backspace', insertLineBreak: 'Enter' };

/** One of the touch toolbar's round icon buttons. */
function TouchTool({
  label,
  Icon,
  disabled,
  pressed,
  onClick,
}: {
  label: string;
  Icon: LucideIcon;
  disabled: boolean;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="agent-computer-touch-tool" aria-label={label} title={label} disabled={disabled} aria-pressed={pressed} onClick={onClick}>
      <Icon aria-hidden="true" />
    </button>
  );
}

/** Take-over on a phone: a keyboard, a trackpad pointer, and the clipboard, by touch. */
function TouchToolbar({ connection, busy }: { connection: LiveViewConnection | null; busy: boolean }) {
  const currentConnection = useRef(connection);
  currentConnection.current = connection;
  useLayoutEffect(() => () => { currentConnection.current = null; }, []);
  const keys = useRef<HTMLTextAreaElement>(null);
  const [pointer, setPointer] = useState(connection?.getTrackpadMode() ?? false);
  const inputPermission = useRef(false);
  useLayoutEffect(() => {
    inputPermission.current = !busy && connection !== null;
    setPointer(connection?.getTrackpadMode() ?? false);
    return () => { inputPermission.current = false; };
  }, [connection, busy]);
  const [error, setError] = useState<string | null>(null);

  // The live-view controls wait for the live view's connection.
  const live =
    <Args extends unknown[]>(action: (connection: LiveViewConnection, ...args: Args) => void) =>
    (...args: Args) => {
      if (connection !== null && inputPermission.current) action(connection, ...args);
    };

  const type = live((connection, event: FormEvent<HTMLTextAreaElement>) => {
    const { inputType, data } = event.nativeEvent as InputEvent;
    const key = KEY_FOR_INPUT[inputType];
    if (key !== undefined) pressKey(connection, key);
    else if (data !== null) typeText(connection, data);
    event.currentTarget.value = '';
  });

  const togglePointer = live((connection) => {
    connection.setTrackpadMode(!pointer);
    setPointer(!pointer);
  });

  const copy = live((connection) => {
    connection.sendKeyboardShortcut([
      { key: 'Control', location: LEFT },
      { key: 'c', location: STANDARD },
    ]);
    setError(connection.syncClipboards() ? null : "Copy failed: the browser's clipboard has not reached this device yet");
  });

  const paste = live((connection) => {
    navigator.clipboard.readText().then(
      (text) => {
        if (!inputPermission.current || currentConnection.current !== connection) return;
        setError(null);
        typeText(connection, text);
      },
      (cause: Error) => {
        if (inputPermission.current && currentConnection.current === connection) setError(`Paste failed: ${cause.message}`);
      },
    );
  });

  const connecting = connection === null || busy;
  return (
    <div className="agent-computer-touch" role="toolbar" aria-label="Take-over">
      {/* Who drives and Stop stay in the bar under the screen. Round icon buttons, as dots' phone toolbar (Fig 8); each is named by its label and tooltip. */}
      <span className="agent-computer-touch-tools">
        <TouchTool label="Keyboard" Icon={Keyboard} disabled={connecting} onClick={() => keys.current?.focus()} />
        <TouchTool label="Pointer" Icon={MousePointer2} disabled={connecting} pressed={pointer} onClick={togglePointer} />
        <TouchTool label="Copy" Icon={Copy} disabled={connecting} onClick={copy} />
        <TouchTool label="Paste" Icon={ClipboardPaste} disabled={connecting} onClick={paste} />
      </span>
      <textarea
        ref={keys}
        className="agent-computer-keys"
        aria-label="Keyboard input"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={connecting}
        onInput={type}
      />
      {error && <p className="agent-computer-error" role="alert">{error}</p>}
    </div>
  );
}
