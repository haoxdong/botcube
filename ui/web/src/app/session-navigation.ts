"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@ag-ui/client";
import {
  buildDirectAgent,
  ChatServiceError,
  createSideChat,
  deleteConversation,
  fetchMainChat,
  fetchChatList,
  markChatRead,
  isUnread,
  openConversation,
  renameSideChat,
  stopFailure,
  stopTurn,
  type ConversationEntry,
  type ReplayedSession,
  type SavedTurnFailure,
} from "./conversations";
import { keepMainChatCopy, mainChatCopy, storedMainChatCopy, withStorage, type MainChatCopy, type StoredMainChatCopy } from "./main-chat-copy";
import type { Moment } from "./latency";

/** The URL's `?chat=<id>` names the open Side Chat. */
const CHAT_PARAMETER = "chat";

/** The moment that ends as the Main Chat's history first shows after the page opens. */
export type HistoryMoment = Extract<Moment, "history-returning" | "history-first-visit">;

/**
 * The copy the page opens with while the account session loads, and the moment its Main Chat's history ends: neither
 * for a link to a Side Chat. A device that opened the page before is one that kept a Main Chat copy: every load of the
 * Main Chat keeps one, and it is what lets a returning opening show history without the network. A device whose copy
 * a sign-out forgot, or whose storage is blocked, opens as on a first visit, as slow as one.
 */
export function openingMainChat(): { copy: StoredMainChatCopy | null; historyMoment: HistoryMoment | null } {
  if (new URLSearchParams(window.location.search).get(CHAT_PARAMETER) !== null) return { copy: null, historyMoment: null };
  const copy = storedMainChatCopy();
  return { copy, historyMoment: copy === null ? "history-first-visit" : "history-returning" };
}
/** How often a visible page with no Turn streaming reloads the Side Chats and the open Main Chat. */
const REFRESH_INTERVAL_MS = 30_000;
/** How often the open chat reloads while its Turn runs on the server with no stream here, as after a reload mid-Turn. */
const RUNNING_POLL_MS = 3_000;

/** `load`, counted in `out` while it is out. */
function counted<T>(out: { current: number }, load: Promise<T>): Promise<T> {
  out.current += 1;
  return load.finally(() => {
    out.current -= 1;
  });
}

/**
 * Owns which Session is open and reconciles navigation, deletion and background
 * replay with its agent. Callers render the view and submit user actions; they
 * never replace messages or coordinate competing requests themselves.
 */
export function useSessionNavigation({
  ready,
  accountId,
  chatServiceUrl,
  agentId,
  opening,
  reading,
}: {
  ready: boolean;
  reading: boolean;
  accountId: string | undefined;
  chatServiceUrl: string;
  agentId: string;
  /** Browser copy shown before account initialization. */
  opening: StoredMainChatCopy | null;
}) {
  const [sideChats, setSideChats] = useState<ConversationEntry[]>([]);
  const [mainChatEntry, setMainChatEntry] = useState<ConversationEntry | undefined>(undefined);
  const [sideChatsError, setSideChatsError] = useState<string | null>(null);
  const [sideChatsListedFor, setSideChatsListedFor] = useState<{ accountId: typeof accountId } | null>(null);
  const [mainChatId, setMainChatId] = useState<string | null>(null);
  const [mainChatError, setMainChatError] = useState<string | null>(null);
  /** Linked Side Chat failure; fall back to Main. */
  const [linkedChatError, setLinkedChatError] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<{ id: string; accountId: string | undefined } | null>(null);
  const activeId = activeChat?.id ?? null;
  /** Message targeted by a run card. */
  const [openAt, setOpenAt] = useState<string | null>(null);
  const [newChatOwner, setNewChatOwner] = useState<{ accountId: typeof accountId } | null>(null);
  // Only the latest navigation may open or fail.
  const navigation = useRef(0);
  const navigationDestination = useRef<string | null>(null);
  const deletedChats = useRef(new Set<string>());
  // A browser copy belongs to the account that mounted it, including while its history loads.
  const copiedAccount = useRef<string | undefined>(undefined);
  const [turnSubmitted, setTurnSubmitted] = useState(false);
  const [activeInitialMessages, setActiveInitialMessages] = useState<Message[]>([]);
  const [activeProvider, setActiveProvider] = useState<string | undefined>(undefined);
  const [activeReadOnly, setActiveReadOnly] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  /** The open Session's latest Turn runs on the server, as its last load said, with its run ID for a Stop. */
  const [serverTurn, setServerTurn] = useState<{ runId: string | undefined; runningSince?: string | undefined; unasked?: true } | null>(null);
  const turnRunsOnServer = serverTurn !== null;
  /** Whether the open chat came from a load, which says whether its Turn runs, rather than from this browser's copy. */
  const [turnKnown, setTurnKnown] = useState(true);
  // The reload reads the run it waits on, which may start or change between reloads, and is kept while its Stop is asked.
  const awaitedRunId = useRef<string | undefined>(undefined);
  if (serverTurn === null) awaitedRunId.current = undefined;
  else if (serverTurn.runId !== undefined) awaitedRunId.current = serverTurn.runId;
  // The refresh and the reload never load the open chat alongside each other: the 30 s refresh leaves it
  // to the reload while a Turn runs on the server or a reload is still out, and a reload waits for any load still out.
  const turnRunsOnServerNow = useRef(false);
  turnRunsOnServerNow.current = turnRunsOnServer;
  const refreshesOut = useRef(0);
  const reloadsOut = useRef(0);
  /** Why the open Session's latest Turn failed, as its last load said: a new value per load, so a repeated failure shows again. */
  const [turnFailure, setTurnFailure] = useState<SavedTurnFailure | null>(null);
  const { agent, selfManagedAgents } = useMemo(() => {
    const threadId = activeId ?? "";
    const onStopFailed = (error: Error) => setStopError(stopFailure(error));
    const threadAgent = buildDirectAgent({
      chatServiceUrl,
      threadId,
      messages: activeInitialMessages,
      onStopFailed,
    });
    return {
      agent: threadAgent,
      selfManagedAgents: {
        default: buildDirectAgent({
          chatServiceUrl,
          threadId,
          messages: activeInitialMessages,
          onStopFailed,
        }),
        [agentId]: threadAgent,
      },
    };
  }, [activeId, activeInitialMessages]);
  const changes = () => {
    const before = agent.messages;
    const count = before.length;
    return () => agent.isRunning || agent.messages !== before || agent.messages.length !== count;
  };
  // The agent showing now, for a load that answers after the render that started it.
  const agentRef = useRef(agent);
  agentRef.current = agent;

  /** Run a Side Chat action, showing its failure in the sidebar until the next one succeeds. */
  const sideChatAction = async (failure: string, action: () => Promise<void>) => {
    try {
      await action();
      setSideChatsError(null);
    } catch (error) {
      setSideChatsError(`${failure}: ${(error as Error).message}`);
    }
  };

  const readingNow = useRef(reading);
  readingNow.current = reading;
  const sideChatsRequest = useRef(0);
  const listedAccount = useRef(accountId);
  const refreshSideChats = async () => {
    const request = ++sideChatsRequest.current;
    try {
      const { threads: chats, mainChat } = await fetchChatList({ chatServiceUrl });
      if (request !== sideChatsRequest.current) return;
      listedAccount.current = accountId;
      setMainChatEntry(mainChat);
      setSideChats(chats.filter(({ id }) => !deletedChats.current.has(id)));
      setSideChatsListedFor({ accountId });
      setSideChatsError(null);
    } catch (error) {
      console.error(error);
      if (request !== sideChatsRequest.current) return;
      setSideChatsError(`Side Chats could not load: ${(error as Error).message}`);
    }
  };

  useEffect(() => {
    if (!ready || !reading || activeId === null || listedAccount.current !== accountId) return;
    let mounted = true;
    let pending = false;
    const isMounted = () => mounted;
    const acknowledge = () => {
      if (document.visibilityState !== "visible" || pending) return;
      const entry = activeId === mainChatEntry?.id ? mainChatEntry : sideChats.find(({ id }) => id === activeId);
      const completedAt = entry?.turn_completed_at;
      if (completedAt === undefined || entry?.read_at === completedAt) return;
      pending = true;
      const showAndRead = async () => {
        const shown = agentRef.current;
        const before = shown.messages;
        const streaming = () => shown.isRunning;
        if (streaming()) return;
        const loaded = activeId === mainChatId ? await fetchMainChat({ chatServiceUrl }) : await openConversation({ id: activeId, chatServiceUrl });
        if (!isMounted() || document.visibilityState !== "visible" || streaming() || shown.messages !== before) return;
        if (JSON.stringify(loaded.messages) !== JSON.stringify(before)) shown.setMessages(loaded.messages);
        await markChatRead(chatServiceUrl, activeId, completedAt);
        if (!isMounted()) return;
        const read = (chat: ConversationEntry) => chat.id === activeId && chat.turn_completed_at === completedAt ? { ...chat, read_at: completedAt } : chat;
        setSideChats((chats) => chats.map(read));
        setMainChatEntry((chat) => chat === undefined ? undefined : read(chat));
      };
      showAndRead().catch((error: Error) => {
        if (mounted) setSideChatsError(`The chat could not be marked read: ${error.message}`);
      }).finally(() => { pending = false; });

    };
    acknowledge();
    document.addEventListener("visibilitychange", acknowledge);
    return () => { mounted = false; document.removeEventListener("visibilitychange", acknowledge); };
  }, [ready, reading, activeId, mainChatId, mainChatEntry, sideChats, chatServiceUrl, accountId]);

  const openChat = (id: string, { messages, provider, running, runId, runningSince, failure, readOnly }: ReplayedSession, loaded = true, at: string | null = null) => {
    navigationDestination.current = id;
    setActiveReadOnly(readOnly === true);
    setTurnKnown(loaded);
    setOpenAt(at);
    copiedAccount.current = undefined;
    setMainChatError(null);
    setStopError(null);
    setServerTurn(running === true ? { runId, runningSince } : null);
    setTurnFailure(failure ?? null);
    setActiveInitialMessages(messages);
    setActiveProvider(provider);
    setActiveChat({ id, accountId });
    setNewChatOwner(null);
    setTurnSubmitted(false);
    setHasMessages(false);
  };

  /** Opening the page shows the copy this browser kept of the account's Main Chat while it loads. */
  const showMainChatCopy = (show: boolean): MainChatCopy | null => {
    // Reading the copy forgets another account's, even when it is not shown.
    const copy = accountId === undefined ? null : mainChatCopy(accountId);
    const opened = openedCopy.current;
    openedCopy.current = null;
    if (copy === null || !show) return null;
    // The copy the page opened with is this account's, and stays on screen on its agent.
    if (opened?.id === copy.id && activeId === copy.id && copiedAccount.current === accountId) return opened;
    setMainChatId(copy.id);
    openChat(copy.id, copy, false);
    copiedAccount.current = accountId;
    return copy;
  };

  /**
   * The copy's agent takes the loaded history, so a draft started meanwhile stays; a Turn sent from the copy brings
   * the history with its own answer.
   */
  const loadIntoCopy = (copy: MainChatCopy, { messages, provider, running, runId, runningSince, failure }: ReplayedSession) => {
    const shown = agentRef.current;
    setTurnKnown(true);
    const copied = JSON.stringify(copy.messages);
    if (!shown.isRunning && JSON.stringify(shown.messages) === copied) {
      if (JSON.stringify(messages) !== copied) shown.setMessages(messages);
      setServerTurn(running === true ? { runId, runningSince } : null);
      setTurnFailure(failure ?? null);
    }
    setActiveProvider(provider);
  };

  /** Takes the previous account's chat off screen. */
  const closeChat = () => {
    copiedAccount.current = undefined;
    setActiveChat(null);
    setNewChatOwner(null);
    setActiveInitialMessages([]);
    setActiveProvider(undefined);
    setTurnSubmitted(false);
    setHasMessages(false);
  };

  // A visit to the bare URL lands in the Main Chat.
  const openMainChat = async ({ unlessRunning = false } = {}) => {
    const request = ++navigation.current;
    const runningBeforeLoad = agent.isRunning;
    const changed = changes();
    navigationDestination.current = mainChatId;
    setMainChatError(null);
    setLinkedChatError(null);
    let copy: MainChatCopy | null = null;
    let forgotten = false;
    try {
      // An account change keeps a chat running a Turn on screen until the load shows it may move.
      copy = showMainChatCopy(!unlessRunning);
      forgotten = true;
      const { id, ...session } = await fetchMainChat({ chatServiceUrl });
      if (request !== navigation.current) return;
      // A resumed Turn may finish or fail before this load answers; preserve its question and reply as well.
      if (unlessRunning && (runningBeforeLoad || changed())) {
        navigationDestination.current = activeId;
        // The chat kept on screen runs its own Turn, which its stream reports.
        setTurnKnown(true);
        return;
      }
      if (accountId !== undefined) withStorage(() => keepMainChatCopy(accountId, { id, ...session }));
      setMainChatId(id);
      if (copy?.id === id) loadIntoCopy(copy, session);
      else openChat(id, session);
    } catch (error) {
      console.error(error);
      if (request !== navigation.current) return;
      if (!forgotten && unlessRunning && !runningBeforeLoad && !agent.isRunning) closeChat();
      else if (!(await recoverFailedNavigation(copy?.id ?? activeId))) return;
      setMainChatError("Your Main Chat could not be opened.");
    }
  };

  const selectMainChat = () => {
    if (activeId !== null && activeId === mainChatId && mainChatError === null && linkedChatError === null) {
      ++navigation.current;
      navigationDestination.current = mainChatId;
      return;
    }
    void openMainChat();
  };

  // A reload or a link reopens the Side Chat the URL names; one it cannot open says why, never showing the Main Chat instead.
  const openLinkedChat = async (id: string) => {
    const request = ++navigation.current;
    navigationDestination.current = id;
    try {
      const session = await openConversation({ id, chatServiceUrl });
      if (request === navigation.current) openChat(id, session);
    } catch (error) {
      console.error(error);
      if (request !== navigation.current) return;
      setLinkedChatError(
        error instanceof ChatServiceError && error.status === 404
          ? "This chat was not found."
          : `This chat could not be opened: ${(error as Error).message}`,
      );
    }
  };

  // The copy shows before the first paint, without waiting on the account session.
  const openedCopy = useRef<MainChatCopy | null>(null);
  useLayoutEffect(() => {
    if (opening === null) return;
    setMainChatId(opening.copy.id);
    openChat(opening.copy.id, opening.copy, false);
    copiedAccount.current = opening.accountId;
    openedCopy.current = opening.copy;
  }, []);

  const opened = useRef({ ready: false, accountId });
  useEffect(() => {
    const previous = opened.current;
    opened.current = { ready, accountId };
    if (!ready) return;
    if (!previous.ready) {
      // The copy the page opened with is another account's: it leaves before this account's Main Chat loads.
      if (copiedAccount.current !== undefined && copiedAccount.current !== accountId) closeChat();
      const linked = new URLSearchParams(window.location.search).get(CHAT_PARAMETER);
      void (linked === null ? openMainChat() : openLinkedChat(linked));
      return;
    }
    // A sign-in that moves the page to another account lands in that account's Main Chat, unless a
    // Turn runs in the open chat by then, such as the request the sign-in resumes: that chat stays open as a Side Chat.
    if (accountId === previous.accountId) return;
    setMainChatId(null);
    const discardCopy = copiedAccount.current !== undefined && copiedAccount.current !== accountId;
    if (discardCopy) closeChat();
    void openMainChat({ unlessRunning: !discardCopy });
  }, [ready, accountId]);

  // Bumped when the user or the connection comes back to the page, and every 30 s while it is visible, so the Side Chats
  // a scheduled run made are listed.
  const [sideChatsRevision, setSideChatsRevision] = useState(0);
  useEffect(
    () => {
      if (ready) void refreshSideChats();
      return () => { ++sideChatsRequest.current; };
    },
    // Stryker disable next-line ArrayDeclaration: refreshSideChats reads only these
    [ready, accountId, sideChatsRevision],
  );

  const [hasMessages, setHasMessages] = useState(false);
  const showWelcome = activeInitialMessages.length === 0 && !turnSubmitted && !hasMessages && activeProvider === undefined;

  useEffect(() => {
    if (activeId === null) return;
    const url = new URL(window.location.href);
    if (activeId === mainChatId || showWelcome) url.searchParams.delete(CHAT_PARAMETER);
    else url.searchParams.set(CHAT_PARAMETER, activeId);
    window.history.replaceState(window.history.state, "", url);
  }, [activeId, mainChatId, showWelcome]);

  const handleNewConversation = async () => {
    const request = ++navigation.current;
    try {
      const { id } = await createSideChat({ chatServiceUrl });
      if (request !== navigation.current) return false;
      openChat(id, { messages: [] });
      setNewChatOwner({ accountId });
      return true;
    } catch (error) {
      if (request !== navigation.current) return false;
      setMainChatRefreshError(`The Side Chat could not be created: ${(error as Error).message}`);
      return false;
    }
  };

  const recoverFailedNavigation = async (destination: string | null) => {
    if (activeId !== null && deletedChats.current.has(activeId)) return handleNewConversation();
    navigationDestination.current = destination;
    return true;
  };

  useEffect(() => {
    const subscription = agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        if (messages.length > 0) setHasMessages(true);
        if (messages.at(-1)?.role === "assistant") setMainChatRefreshError(null);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, accountId]);

  // A scheduled run makes a Side Chat and posts to the Main Chat on the server: reload the Side Chats and the open
  // Main Chat's history when the user or the connection comes back to the page, and every 30 s while it is visible,
  // unless a Turn is streaming. The open agent takes the history, so the chat and its composer draft stay mounted.
  const [mainChatRefreshError, setMainChatRefreshError] = useState<string | null>(null);
  useEffect(() => {
    if (!ready) return undefined;
    let mounted = true;
    // Focus and visibility can overlap; only the latest load may replace history or report a failure.
    let refreshSequence = 0;
    const refresh = () => {
      if (document.visibilityState !== "visible" || agent.isRunning) return;
      // Stryker disable next-line ArithmeticOperator: any change of revision reloads the list, whichever way it counts
      setSideChatsRevision((revision) => revision + 1);
      if (activeId === null || activeId !== mainChatId || turnRunsOnServerNow.current || reloadsOut.current > 0) return;
      const sequence = ++refreshSequence;
      const changed = changes();
      counted(refreshesOut, fetchMainChat({ chatServiceUrl })).then(
        (mainChat) => {
          const { messages } = mainChat;
          if (!mounted || sequence !== refreshSequence || changed()) return;
          // A history with nothing new leaves the chat as it is, so a periodic refresh does not re-render it.
          if (JSON.stringify(messages) !== JSON.stringify(agent.messages)) agent.setMessages(messages);
          if (accountId !== undefined) withStorage(() => keepMainChatCopy(accountId, mainChat));
          setMainChatRefreshError(null);
        },
        (error: Error) => {
          if (mounted && sequence === refreshSequence) setMainChatRefreshError(`The Main Chat could not refresh: ${error.message}`);
        },
      );
    };
    window.addEventListener("focus", refresh);
    // A load that failed offline is retried once the connection is back.
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    // A user who stays on the page sees what lands meanwhile, such as a scheduled run's post.
    const refreshTimer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      mounted = false;
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
      setMainChatRefreshError(null);
    };
  }, [agent, activeId, mainChatId, ready, accountId]);

  // A Turn whose stream here fails short of a Stop may run on: the open chat reloads until the server says
  // it has ended.
  useEffect(() => {
    let completedRun: string | undefined;
    const subscription = agent.subscribe({
      onRunStartedEvent: ({ event }) => { completedRun = undefined; setServerTurn({ runId: event.runId }); },
      onRunFinishedEvent: ({ input }) => { completedRun = input.runId; setServerTurn(null); },
      // A run error ends the Turn on the server too.
      onRunErrorEvent: ({ input }) => { completedRun = input.runId; setServerTurn(null); },
      onRunFailed: ({ error, input }) => {
        if (error.name === "AbortError") return;
        setServerTurn({ runId: input.runId, unasked: true });
      },
      // A Stop that failed is moot once its Turn's stream here ends.
      onRunFinalized: ({ input }) => {
        setStopError(null);
        if (completedRun !== input.runId) return;
        completedRun = undefined;
        if (!readingNow.current || document.visibilityState !== "visible" || agentRef.current !== agent) return;
        void markChatRead(chatServiceUrl, input.threadId, { runId: input.runId }).then(() => {
          if (agentRef.current === agent) void refreshSideChats();
        }, (error: Error) => setSideChatsError(`The chat could not be marked read: ${error.message}`));
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  // A Turn on the server with no stream here lands within seconds: the chat reloads until it ends, 3 s after each load
  // answers so loads never overlap, at once after a failed stream.
  useEffect(() => {
    if (!ready || !turnRunsOnServer || activeId === null) return undefined;
    let mounted = true;
    let poll: number;
    const next = () => {
      if (mounted) poll = window.setTimeout(reload, RUNNING_POLL_MS);
    };
    const reload = () => {
      if (document.visibilityState !== "visible" || agent.isRunning || refreshesOut.current + reloadsOut.current > 0) {
        next();
        return;
      }
      const changed = changes();
      const stale = () => !mounted || changed();
      const load = activeId === mainChatId ? fetchMainChat({ chatServiceUrl }) : openConversation({ id: activeId, chatServiceUrl });
      counted(reloadsOut, load).finally(next).then(
        ({ messages, running, runId, runningSince, failure }) => {
          if (stale()) return;
          if (!(running && messages.length < agent.messages.length) && JSON.stringify(messages) !== JSON.stringify(agent.messages)) agent.setMessages(messages);
          setMainChatRefreshError(null);
          setServerTurn(running ? { runId, runningSince } : null);
          // Only the awaited run's failure: a send that never reached the Chat Service leaves an earlier one on record.
          const awaited = awaitedRunId.current;
          setTurnFailure(failure !== undefined && (awaited === undefined || failure.runId === awaited) ? failure : null);
        },
        (error: Error) => {
          if (stale()) return;
          setMainChatRefreshError(`The chat could not refresh: ${error.message}`);
        },
      );
    };
    (serverTurn.unasked ? reload : next)();
    return () => {
      mounted = false;
      window.clearTimeout(poll);
    };
  }, [agent, activeId, mainChatId, turnRunsOnServer, serverTurn?.unasked, ready]);

  // A Turn that runs on the server with no stream here stops from the page too. Its Stop goes while one is
  // asked, until the reload says the Turn ended; a failed Stop comes back for another try.
  const serverRunId = serverTurn?.runId;
  const stopServerTurn =
    serverRunId !== undefined && activeId !== null
      ? () => {
          setStopError(null);
          setServerTurn({ runId: undefined });
          stopTurn({ id: activeId, runId: serverRunId, chatServiceUrl }).catch((error: Error) => {
            if (agentRef.current !== agent) return;
            setStopError(stopFailure(error));
            setServerTurn((turn) => (turn === null ? null : { runId: turn.runId ?? serverRunId }));
          });
        }
      : null;

  const handleSelectConversation = async (conversation: Pick<ConversationEntry, "id" | "title">, at: string | null = null) => {
    const request = ++navigation.current;
    navigationDestination.current = conversation.id;
    try {
      const session = await openConversation({ id: conversation.id, chatServiceUrl });
      if (request !== navigation.current) return;
      openChat(conversation.id, session, true, at);
      setSideChatsError(null);
    } catch (error) {
      console.error(error);
      if (request === navigation.current) {
        if (!(await recoverFailedNavigation(activeId))) return;
        setSideChatsError(`${conversation.title} could not be opened: ${(error as Error).message}`);
      }
    }
  };

  const handleDeleteConversation = (conversation: ConversationEntry) =>
    sideChatAction(`${conversation.title} could not be deleted`, async () => {
      await deleteConversation({ id: conversation.id, chatServiceUrl });
      deletedChats.current.add(conversation.id);
      setSideChats((prev) => prev.filter((entry) => entry.id !== conversation.id));
      if (conversation.id === navigationDestination.current) void handleNewConversation();
    });

  const handleRenameSideChat = (conversation: ConversationEntry, title: string) =>
    sideChatAction(`${conversation.title} could not be renamed`, async () => {
      const renamed = await renameSideChat({ id: conversation.id, title, chatServiceUrl });
      setSideChats((prev) => prev.map((entry) => entry.id === conversation.id ? { ...entry, title: renamed.title } : entry));
    });

  return {
    current: { id: activeId, accountId: activeChat?.accountId, openAt, newChat: newChatOwner !== null && newChatOwner.accountId === accountId, provider: activeProvider, readOnly: activeReadOnly, agent, selfManagedAgents, showWelcome, stopServerTurn, turnFailure, runningSince: serverTurn?.runningSince,
      // A chat shown from this browser's copy may run a Turn until its load says otherwise.
      turnRunning: turnRunsOnServer || !turnKnown,
      turnRunsOnServer,
      // Another tab can know of a Turn this one does not: the open chat reloads until the server says none runs.
      turnMayRun: () => setServerTurn((turn) => turn ?? { runId: undefined }) },
    mainChatId,
    mainChatUnread: mainChatEntry !== undefined && isUnread(mainChatEntry),
    sideChats: { entries: sideChats, error: sideChatsError, listed: sideChatsListedFor !== null && sideChatsListedFor.accountId === accountId },
    failures: { mainChat: mainChatError, linkedChat: linkedChatError, refresh: mainChatRefreshError, stop: stopError },
    openMainChat,
    selectMainChat,
    newSideChat: handleNewConversation,
    selectSideChat: handleSelectConversation,
    renameSideChat: handleRenameSideChat,
    deleteSideChat: handleDeleteConversation,
    turnStarting(provider: string | undefined) {
      setTurnSubmitted(true);
      setActiveProvider(provider);
    },
    messageSubmitted() {
      setTurnSubmitted(true);
      void refreshSideChats();
    },
  };
}
