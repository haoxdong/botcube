'use client';

import { contentHasMedia, contentToText, type Message } from '@ag-ui/client';
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';

import type { ComputerViewProps } from 'botcube-ui-web/cartridge';
import { measureMoment } from 'botcube-ui-web/latency';
import { Loaded, useLoad } from 'botcube-ui-web/load-state';
import {
  AgentComputer,
  ChatNotStarted,
  handBackBrowser,
  loadAgentComputer,
  takeOverBrowser,
  wakeAgentComputer,
  type AgentComputerState,
  type DockApp,
  type ShellCommand,
} from './agent-computer';
import { FilesApp } from './files-app';

import { loadLiveView, type BrowserLiveFrameProps } from './browser-live-frame';

/** How long a sleeping computer waits before it is looked at again, while a Turn may wake it. */
const LOOK_AGAIN_MS = 3000;
const LIVE_VIEW_RECONNECT_LIMIT = 3;

/** The deepagents shell tool, whose arguments carry the command it runs. */
const SHELL_TOOL = 'execute';

/** A malformed completed shell call fails its Terminal projection, without changing the upstream Turn. */
export class TerminalArgumentsError extends Error {}

function shellCommand(args: string): string {
  try {
    return (JSON.parse(args) as { command: string }).command;
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw new TerminalArgumentsError('Cannot display Terminal commands: invalid shell arguments', { cause });
  }
}

/** The shell commands the agent has run in these messages, in order: each shell call with the result that answered it. */
export function shellCommands(messages: readonly Message[]): ShellCommand[] {
  const results = new Map(messages.flatMap((message) => (message.role === 'tool' ? [[message.toolCallId, message.content] as const] : [])));
  return messages.flatMap((message) =>
    message.role === 'assistant'
      ? (message.toolCalls ?? []).flatMap((call) => {
          const output = results.get(call.id);
          if (call.function.name !== SHELL_TOOL || output === undefined) return [];
          if (contentHasMedia(output)) {
            throw new TerminalArgumentsError('Cannot display Terminal commands: shell output contains media');
          }
          return [{ command: shellCommand(call.function.arguments), output: contentToText(output) }];
        })
      : [],
  );
}

/** The Computer tab: the open chat's Agent Computer, with Take-over and Stop, its Terminal, and the account's Files. */
export function ComputerView({ agentName, conversation, shown, activity, onConnectionChange, chatServiceUrl, onRequestError, BrowserFrame }: ComputerViewProps & { chatServiceUrl: string; onRequestError?: (cause: Error) => void; BrowserFrame?: ComponentType<BrowserLiveFrameProps> }) {
  const { running } = activity;
  let commands: ShellCommand[] = [];
  let terminalError: TerminalArgumentsError | null = null;
  try {
    commands = shellCommands(activity.messages);
  } catch (cause) {
    if (!(cause instanceof TerminalArgumentsError)) throw cause;
    terminalError = cause;
  }
  const active = useRef(shown);
  active.current = shown;
  useEffect(() => () => { active.current = false; }, []);
  // Each showing after the first: the tab looks at the computer again, as opening it did, while the live view of
  // the same browser stays connected.
  const [showings, setShowings] = useState(0);
  const [wasShown, setWasShown] = useState(shown);
  // When the tab last opened, moved to another chat, or retried a failed look: a computer found asleep is timed from
  // then, its first look included.
  const [openedAt, setOpenedAt] = useState(() => performance.now());
  // The live view's code loads while the browser wakes, which takes seconds, rather than after it.
  useEffect(() => { if (!BrowserFrame) void loadLiveView(); }, [BrowserFrame]);
  // A sleeping computer's opening, timed as computer-cold from the tab opening until its live view shows: it lasts
  // only while that chat's wake runs and its live view connects, and leaving the chat or the tab drops it.
  const cold = useRef<{ chat: string; start: number } | null>(null);
  useEffect(
    () => () => {
      cold.current = null;
    },
    [conversation.id, shown],
  );
  // A live view shown before its first frame, having waited long enough, leaves the opening to that frame.
  const live = (painted: boolean) => {
    if (!painted) return;
    if (cold.current?.chat === conversation.id) measureMoment('computer-cold', cold.current.start);
    cold.current = null;
  };
  // Each look at the computer after the stream its live view showed ended, and the showing it ended in:
  // a computer that went to sleep under the open tab stays asleep until the tab shows again, since only opening the tab
  // wakes it (ADR 0077), so a tab left open never keeps its browser awake.
  const [looks, setLooks] = useState(0);
  const [endedIn, setEndedIn] = useState<string | null>(null);
  const showing = `${conversation.id} ${showings}`;
  const currentShowing = useRef(showing);
  currentShowing.current = showing;
  const controlRequest = useRef(0);
  const [reconnects, setReconnects] = useState({ showing, attempts: 0 });
  const reconnectAttempts = reconnects.showing === showing ? reconnects.attempts : 0;
  const liveViewExhausted = reconnectAttempts > LIVE_VIEW_RECONNECT_LIMIT;
  const { state, retry, update: updateLoaded } = useLoad(
    async () => ({ computer: await loadAgentComputer(conversation.id, { chatServiceUrl: chatServiceUrl }), showing }),
    `${showing} ${looks}`,
  );
  useLayoutEffect(() => {
    if (state.status !== 'loaded') onConnectionChange?.(false);
  }, [state.status, onConnectionChange]);
  const checking = state.status === 'loaded' && state.value.showing !== showing;
  const update = (change: (computer: AgentComputerState) => AgentComputerState) =>
    updateLoaded((current) => ({ ...current, computer: change(current.computer) }));
  // Moved to another chat, the tab loads that chat's computer afresh: the last chat's never stands in for it.
  const [chat, setChat] = useState(conversation.id);
  if (chat !== conversation.id) {
    setChat(conversation.id);
    setReconnects({ showing, attempts: 0 });
    setOpenedAt(performance.now());
    retry();
  }
  const [app, setApp] = useState<DockApp>('Chrome');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A wake starting the browser, which takes seconds.
  const [starting, setStarting] = useState(false);
  // The chat whose wake came before its first message: that message's Turn wakes it again.
  const [chatToStart, setChatToStart] = useState<string | null>(null);
  if (shown !== wasShown) {
    setWasShown(shown);
    if (shown) {
      setOpenedAt(performance.now());
      // Showing the tab again is the retry its failures name.
      setShowings((count) => count + 1);
      setError(null);
      setNotice(null);
      setChatToStart(null);
    }
  }

  // The agent's browser commands wake the computer during a Turn: until it is awake, look again.
  // A computer still starting counts as asleep: the wake below joins its start.
  const asleep = state.status === 'loaded' && state.value.computer.state !== 'awake';
  useEffect(
    () => {
      if (!shown || checking || !running || !asleep) return;
      let current = true;
      let timer: ReturnType<typeof setTimeout>;
      const look = () => {
        timer = setTimeout(() => {
          loadAgentComputer(conversation.id, { chatServiceUrl: chatServiceUrl }).then(
            (computer) => {
              if (!current) return;
              update(() => computer);
              look();
            },
            (cause: Error) => current && setError(cause.message),
          );
        }, LOOK_AGAIN_MS);
      };
      look();
      return () => {
        current = false;
        clearTimeout(timer);
      };
    },
    // Stryker disable next-line ArrayDeclaration: `update` is a fresh closure each render; these name what is looked at
    [shown, checking, running, asleep, conversation.id],
  );

  const fail = (cause: Error, retry?: string) => {
    // Not a failure: the chat's first message starts its computer, so the tab explains that instead.
    if (cause instanceof ChatNotStarted) {
      setNotice(cause.message);
      return;
    }
    setError(retry === undefined ? cause.message : `${cause.message.replace(/\.?$/, '.')} ${retry}`);
    onRequestError?.(cause);
  };

  const run = (request: () => Promise<void>, complete: () => void) => {
    if (!active.current || checking) return;
    const identity = ++controlRequest.current;
    const current = () => active.current && currentShowing.current === showing && controlRequest.current === identity;
    setBusy(true);
    setError(null);
    setNotice(null);
    request()
      .then(() => { if (current()) complete(); }, (cause: Error) => { if (current()) fail(cause); })
      .finally(() => { if (current()) setBusy(false); });
  };

  // Who drives the browser lives in its browser Session, so a reload shows a Take-over in progress.
  const controlBy = (control: 'user' | 'agent', sessionId: string) =>
    update((current) =>
      current.state === 'awake' && current.browserSessionId === sessionId ? { ...current, control } : current,
    );
  const takeOver = (sessionId: string) =>
    run(() => takeOverBrowser(sessionId, { chatServiceUrl: chatServiceUrl }), () => controlBy('user', sessionId));
  const handBack = (sessionId: string) =>
    run(() => handBackBrowser(sessionId, { chatServiceUrl: chatServiceUrl }), () => controlBy('agent', sessionId));

  // A different chat gets its own initial wake attempt, including when the user returns to it.
  useEffect(() => {
    setChatToStart(null);
    setEndedIn(null);
  }, [conversation.id]);

  // Opening the tab, or showing it again, wakes a computer still asleep: opening its chat usually has (ADR 0077).
  useEffect(
    () => {
      if (!shown || checking || !asleep || endedIn === showing || (chatToStart === conversation.id && (!running || error !== null))) return;
      let current = true;
      // A chat its first message starts had no computer asleep to open: computer-cold leaves it out.
      if (chatToStart !== conversation.id) cold.current = { chat: conversation.id, start: openedAt };
      setStarting(true);
      setError(null);
      setNotice(null);
      // Once the user moves to another chat, this chat's wake answers nobody, its failure included.
      wakeAgentComputer(conversation.id, { chatServiceUrl: chatServiceUrl })
        .then(
          (computer) => current && update(() => computer),
          // With no Wake control, opening the tab again is the retry: it says so, never leaving the cover dimmed silently.
          (cause: Error) => {
            if (!current) return;
            // The opening failed before its live view showed: a later wake, such as a Turn's, is not timed as it.
            cold.current = null;
            if (cause instanceof ChatNotStarted) setChatToStart(conversation.id);
            fail(cause, 'Reopen the Computer tab to try again.');
          },
        )
        .finally(() => current && setStarting(false));
      return () => {
        current = false;
      };
    },
    // Stryker disable next-line ArrayDeclaration: `fail` and `update` are fresh closures each render; these name what is woken
    [shown, checking, asleep, conversation.id, chatToStart === conversation.id && running, showings],
  );

  useEffect(() => {
    if (!shown) { setStarting(false); setBusy(false); }
  }, [shown]);

  return (
    <Loaded
      state={state}
      label="Agent Computer"
      onRetry={() => {
        setOpenedAt(performance.now());
        retry();
      }}
    >
      {({ computer }) => (
        <AgentComputer
          BrowserFrame={BrowserFrame}
          agentName={agentName}
          active={shown && !checking}
          chatId={conversation.id}
          app={app}
          files={<FilesApp chatServiceUrl={chatServiceUrl} />}
          computer={computer}
          commands={commands}
          terminalError={terminalError?.message ?? null}
          control={computer.state === 'awake' && computer.control === 'user' ? 'user' : 'agent'}
          running={running}
          starting={starting}
          busy={busy}
          error={liveViewExhausted
            ? `Live view disconnected after ${LIVE_VIEW_RECONNECT_LIMIT} reconnect attempts. Reopen the Computer tab to try again.${error === null ? '' : ` ${error}`}`
            : error}
          liveViewExhausted={liveViewExhausted}
          notice={notice}
          onTakeOver={takeOver}
          onHandBack={handBack}
          onStop={activity.stop}
          onOpenApp={setApp}
          onLive={live}
          onConnectionChange={onConnectionChange}
          onLiveEnded={() => {
            setEndedIn(showing);
            // A hidden tab looks when it shows: connecting fetches a signed URL, which keeps the browser awake for nobody.
            if (!shown || liveViewExhausted) return;
            setReconnects({ showing, attempts: reconnectAttempts + 1 });
            if (reconnectAttempts < LIVE_VIEW_RECONNECT_LIMIT) setLooks((count) => count + 1);
          }}
        />
      )}
    </Loaded>
  );
}
