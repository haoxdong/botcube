

import { ClipboardPaste, Copy, Keyboard, Laptop, MousePointer2, X, type LucideIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button } from "@/components/ui/button";
import { useCallback, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type ComponentType } from 'react';

import { BrowserLiveFrame, type LiveViewConnection, type BrowserLiveFrameProps } from './browser-live-frame';
import { failureDetail } from './failure-detail';
import { Fades, Glides, useAfterMove } from '../app/motion';
import { Terminal, type ShellCommand } from './terminal';
import { WindowsDesktop, type DockApp } from './windows-desktop';


/**
 * The chat's Agent Computer: its browser and who drives it while awake, and its last screenshot either way. An awake
 * local Agent Computer says its screen comes as `screenshots`, frame by frame; one under the BotCube Config's
 * `liveView: none` says `none`, and shows no live view; without either, it is a DCV live view.
 */
export type AgentComputerState =
  | { state: 'awake'; browserSessionId: string; control: 'user' | 'agent'; screenshot: string | null; liveView?: 'screenshots' | 'none' }
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

export const loadAgentComputer = agentComputerRequest('/agent-computer', 'GET', 'Agent Computer request failed');
export const wakeAgentComputer = agentComputerRequest('/agent-computer/wake', 'POST', 'Wake failed', ChatNotStarted);

/** The browser Session the desktop watches: none under `liveView: none`, which its cover says. */
function watching(computer: AgentComputerState, notice: string | null) {
  const off = computer.state === 'awake' && computer.liveView === 'none';
  return { off, browserSessionId: computer.state === 'awake' && !off ? computer.browserSessionId : null, coverNotice: notice ?? (off ? 'Live view is off in this deployment.' : null) };
}

export type { DockApp } from './windows-desktop';

/**
 * The Agent Computer: Windows 11, with the agent's live browser or, asleep, its last screen in one window, and its
 * Terminal and Files in others. Beside the chat it is a preview that opens the sheet.
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
    chatId: string;
  app: DockApp;
    files: ReactNode;
  computer: AgentComputerState;
  commands: readonly ShellCommand[];
    terminalError?: string | null;
  liveViewExhausted?: boolean;
  control: 'agent' | 'user';
    running: boolean;
  busy: boolean;
  error: string | null;
    notice: string | null;
  onTakeOver: (browserSessionId: string) => void;
  onHandBack: (browserSessionId: string) => void;
  /** A wake is starting the browser. */
  starting: boolean;
  onStop: (() => void) | null;
  onOpenApp: (app: DockApp) => void;
    onLive?: (painted: boolean) => void;
    onLiveEnded?: () => void;
  onConnectionChange?: ((connected: boolean) => void) | undefined;
}) {
  const [live, setLive] = useState<{ sessionId: string; connection: LiveViewConnection | null } | null>(null);
  const [generation, setGeneration] = useState(0);
  const [ended, setEnded] = useState<AgentComputerState | null>(null);
  const [sheet, setSheet] = useState(false);
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  const returning = useRef(false);
  const zoom = (open: boolean) => { returning.current = false; setSheet(open); };
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
  const { off, browserSessionId, coverNotice } = watching(computer, notice);
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
  const covered = !settled;
  const waited = useAfterMove(covered);
  const title = `${agentName}'s computer`;
  const host = chatId.replaceAll('-', '').slice(0, 12);
  const handBack = (sessionId: string) => {
    returning.current = true;
    onHandBack(sessionId);
  };
  return (
    <div
      ref={(element) => setLayer(element?.parentElement ?? null)}
      className={sheet ? 'agent-computer agent-computer-sheet' : 'agent-computer'}
      role={sheet ? 'dialog' : undefined}
      aria-label={sheet ? title : undefined}
      onKeyDown={(event) => {
        if (!sheet || control !== 'agent' || event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        zoom(false);
      }}
    >
      {/* Beside this size container, not in it, so it still covers the screen as the desktop springs back. */}
      {layer !== null && createPortal(<Fades>{sheet && <div className="agent-computer-sheet-backdrop" />}</Fades>, layer)}
      <Fades>{sheet && (
        <div className="agent-computer-sheet-head">
          <Button variant="ghost" size="icon" className="agent-computer-sheet-close" aria-label="Close computer" title="Close computer" onClick={() => zoom(false)}>
            <X aria-hidden="true" />
          </Button>
          <span className="agent-computer-sheet-title"><Laptop aria-hidden="true" />{title}</span>
        </div>
      )}</Fades>
      {/* Only a zoom springs the desktop between its place and the full-screen sheet. */}
      <Glides on dependency={sheet} scales className="agent-computer-desktop">
        <WindowsDesktop
          front={app}
          interactive={active && sheet}
          onFront={onOpenApp}
          windows={[
            { app: 'Files', title: 'Files', startsClosed: true, children: <section className="agent-computer-app" aria-label="Files">{files}</section> },
            {
              app: 'Chrome',
              title: 'Chrome',
              keepMounted: true,
              // The live view stays connected under the other windows, so bringing Chrome forward shows the browser at
              // once. Until it shows the browser, its last screen stands in, dimmed: never a black frame.
              children: (
                <div className={covered ? 'agent-computer-screen agent-computer-screen-covered' : 'agent-computer-screen'}>
                  <Fades>{hasViewer && (
                    <div key={`${browserSessionId}:${generation}`} className="agent-computer-live"><BrowserFrame
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
                        setGeneration((current) => current + 1);
                        setLive(null);
                        onLiveEnded?.();
                      }}
                    /></div>
                  )}</Fades>
                  {covered && (
                    <div className="agent-computer-cover">
                      <Fades>{computer.screenshot !== null && (
                        <img className="agent-computer-screenshot" src={computer.screenshot} alt="The last screen" />
                      )}</Fades>
                      {waited && !liveViewExhausted && !off && (starting || browserSessionId !== null) && <p className="agent-computer-starting" role="status">{computer.state === 'awake' ? 'Connecting…' : 'Starting…'}</p>}
                      <Fades>{coverNotice && <p className="agent-computer-notice" role="status">{coverNotice}</p>}</Fades>
                    </div>
                  )}
                </div>
              ),
            },
            {
              app: 'Terminal',
              title: 'workspace — zsh',
              dark: true,
              children: <section className="agent-computer-app" aria-label="Terminal"><Terminal commands={commands} error={terminalError} prompt={`agent@${host} workspace %`} /></section>,
            },
          ]}
        />
        {/* Beside the chat the desktop is a preview: a press anywhere on it opens the sheet. */}
        {!sheet && <Button variant="link" className="agent-computer-screen-open" aria-label="View computer" disabled={!active} onClick={() => zoom(true)} />}
      </Glides>
      {/* Who drives, attached under the desktop as in dots. */}
      <div className="agent-computer-bar">
        <Fades>{browserSessionId !== null && (
          <span className="agent-computer-pill">
            {control === 'agent' ? `${agentName} has control` : 'You have control'}
            <span aria-hidden="true"> · </span>
            <Button size="sm" disabled={busy || !active} onClick={() => {
                if (control === 'agent') {
                  zoom(true);
                  onOpenApp('Chrome');
                  onTakeOver(browserSessionId);
                } else handBack(browserSessionId);
              }}>
              {control === 'agent' ? 'Take over' : 'Return control'}
            </Button>
          </span>
        )}</Fades>
        <Fades>{running && <Button variant="outline" size="sm" disabled={!active || onStop === null} onClick={onStop ?? undefined}>Stop</Button>}</Fades>
      </div>
      <Fades>{active && sheet && browserSessionId !== null && control === 'user' && (
        <div className="agent-computer-touch-slot"><TouchToolbar connection={connection} busy={busy} /></div>
      )}</Fades>
      <Fades>{error && <p className="agent-computer-error" role="alert">{error}</p>}</Fades>
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
    <Button variant={pressed ? "secondary" : "default"} size="icon-lg" aria-label={label} title={label} disabled={disabled} aria-pressed={pressed} onClick={onClick}>
      <Icon aria-hidden="true" />
    </Button>
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
      <Fades>{error && <p className="agent-computer-error" role="alert">{error}</p>}</Fades>
    </div>
  );
}
