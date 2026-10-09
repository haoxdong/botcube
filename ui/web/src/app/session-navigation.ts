"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@ag-ui/client";
import {
  buildDirectAgent,
  ChatServiceError,
  deleteConversation,
  fetchMainChat,
  fetchSideChats,
  openConversation,
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
  opening = null,
}: {
  ready: boolean;
  accountId: string | undefined;
  chatServiceUrl: string;
  agentId: string;
  /** The copy shown from the first render, before the account session answers whose it is. */
  opening?: StoredMainChatCopy | null;
}) {
  const [sideChats, setSideChats] = useState<ConversationEntry[]>([]);
  const [sideChatsError, setSideChatsError] = useState<string | null>(null);
  const [mainChatId, setMainChatId] = useState<string | null>(null);
  const [mainChatError, setMainChatError] = useState<string | null>(null);
  /** Why the Side Chat the URL names could not open; the user goes on to the Main Chat from it. */
  const [linkedChatError, setLinkedChatError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newChatOwner, setNewChatOwner] = useState<{ accountId: typeof accountId } | null>(null);
  // Only the latest navigation may open a chat or report a load failure.
  const navigation = useRef(0);
  const navigationDestination = useRef<string | null>(null);
  const deletedChats = useRef(new Set<string>());
  // A browser copy belongs to the account that mounted it, including while its history loads.
  const copiedAccount = useRef<string | undefined>(undefined);
  const [userSentMessage, setUserSentMessage] = useState(false);
  const [activeInitialMessages, setActiveInitialMessages] = useState<Message[]>([]);
  // The open Session's model provider, as the Chat Service recorded it.
  const [activeProvider, setActiveProvider] = useState<string | undefined>(undefined);
  const [stopError, setStopError] = useState<string | null>(null);
  /** The open Session's latest Turn runs on the server, as its last load said, with its run ID for a Stop. */
  const [serverTurn, setServerTurn] = useState<{ runId: string | undefined } | null>(null);
  const turnRunsOnServer = serverTurn !== null;
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
  // The agent showing now, for a load that answers after the render that started it.
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const currentAgent = useRef(agent);
  currentAgent.current = agent;

  /** Run a Side Chat action, showing its failure in the sidebar until the next one succeeds. */
  const sideChatAction = async (failure: string, action: () => Promise<void>) => {
    try {
      await action();
      setSideChatsError(null);
    } catch (error) {
      setSideChatsError(`${failure}: ${(error as Error).message}`);
    }
  };

  const sideChatsRequest = useRef(0);
  const refreshSideChats = async () => {
    const request = ++sideChatsRequest.current;
    try {
      const chats = await fetchSideChats({ chatServiceUrl });
      if (request !== sideChatsRequest.current) return;
      setSideChats(chats.filter(({ id }) => !deletedChats.current.has(id)));
      setSideChatsError(null);
    } catch (error) {
      console.error(error);
      if (request !== sideChatsRequest.current) return;
      setSideChatsError(`Side Chats could not load: ${(error as Error).message}`);
    }
  };

  const openChat = (id: string, { messages, provider, running, runId, failure }: ReplayedSession) => {
    navigationDestination.current = id;
    copiedAccount.current = undefined;
    setMainChatError(null);
    setStopError(null);
    setServerTurn(running === true ? { runId } : null);
    setTurnFailure(failure ?? null);
    setActiveInitialMessages(messages);
    setActiveProvider(provider);
    setActiveId(id);
    setNewChatOwner(null);
    setUserSentMessage(false);
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
    openChat(copy.id, copy);
    copiedAccount.current = accountId;
    return copy;
  };

  /**
   * The copy's agent takes the loaded history, so a draft started meanwhile stays; a Turn sent from the copy brings
   * the history with its own answer.
   */
  const loadIntoCopy = (copy: MainChatCopy, { messages, provider, running, runId, failure }: ReplayedSession) => {
    const shown = agentRef.current;
    const copied = JSON.stringify(copy.messages);
    if (!shown.isRunning && JSON.stringify(shown.messages) === copied) {
      if (JSON.stringify(messages) !== copied) shown.setMessages(messages);
      setServerTurn(running === true ? { runId } : null);
      setTurnFailure(failure ?? null);
    }
    setActiveProvider(provider);
  };

  /** Takes the previous account's chat off screen. */
  const closeChat = () => {
    copiedAccount.current = undefined;
    setActiveId(null);
    setNewChatOwner(null);
    setActiveInitialMessages([]);
    setActiveProvider(undefined);
    setUserSentMessage(false);
    setHasMessages(false);
  };

  // A visit to the bare URL lands in the Main Chat.
  const openMainChat = async ({ unlessRunning = false } = {}) => {
    const request = ++navigation.current;
    const runningBeforeLoad = agent.isRunning;
    const messagesBeforeLoad = agent.messages;
    const messageCountBeforeLoad = messagesBeforeLoad.length;
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
      if (unlessRunning && (runningBeforeLoad || agent.isRunning || agent.messages !== messagesBeforeLoad || agent.messages.length !== messageCountBeforeLoad)) {
        navigationDestination.current = activeId;
        return;
      }
      if (accountId !== undefined) withStorage(() => keepMainChatCopy(accountId, { id, ...session }));
      setMainChatId(id);
      if (copy?.id === id) loadIntoCopy(copy, session);
      else openChat(id, session);
    } catch (error) {
      console.error(error);
      if (request !== navigation.current) return;
      // Another account's copy left behind, the previous account's chat leaves too, unless it runs the Turn the sign-in resumed.
      if (!forgotten && unlessRunning && !runningBeforeLoad && !agent.isRunning) closeChat();
      else if (activeId !== null && deletedChats.current.has(activeId)) handleNewConversation();
      else navigationDestination.current = copy?.id ?? activeId;
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
    openChat(opening.copy.id, opening.copy);
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
  const showWelcome = activeInitialMessages.length === 0 && !userSentMessage && !hasMessages;

  // The URL names an open Side Chat once it has a message, so a reload or a link reopens it; the Main Chat is the bare URL.
  useEffect(() => {
    if (activeId === null) return;
    const url = new URL(window.location.href);
    if (activeId === mainChatId || showWelcome) url.searchParams.delete(CHAT_PARAMETER);
    else url.searchParams.set(CHAT_PARAMETER, activeId);
    window.history.replaceState(window.history.state, "", url);
  }, [activeId, mainChatId, showWelcome]);

  // A new chat is a Side Chat; the Chat Service lists it once it has a Turn.
  const handleNewConversation = () => {
    ++navigation.current;
    openChat(crypto.randomUUID(), { messages: [] });
    setNewChatOwner({ accountId });
  };

  useEffect(() => {
    const subscription = agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        if (messages.length > 0) setHasMessages(true);
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
      const messagesBeforeRefresh = agent.messages;
      const messageCountBeforeRefresh = messagesBeforeRefresh.length;
      counted(refreshesOut, fetchMainChat({ chatServiceUrl })).then(
        (mainChat) => {
          const { messages } = mainChat;
          if (!mounted || sequence !== refreshSequence || agent.isRunning || agent.messages !== messagesBeforeRefresh || agent.messages.length !== messageCountBeforeRefresh) return;
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
    const subscription = agent.subscribe({
      onRunStartedEvent: ({ event }) => setServerTurn({ runId: event.runId }),
      onRunFinishedEvent: () => setServerTurn(null),
      // A run error ends the Turn on the server too.
      onRunErrorEvent: () => setServerTurn(null),
      onRunFailed: ({ error, input }) => {
        if (error.name === "AbortError") return;
        setServerTurn({ runId: input.runId });
      },
      // A Stop that failed is moot once its Turn's stream here ends.
      onRunFinalized: () => setStopError(null),
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  // A Turn that runs on the server with no stream here, as after a reload mid-Turn, lands within seconds rather than at
  // the next refresh: the open chat reloads until it ends.
  // Each reload starts 3 s after the previous one answers, so a slow load never overlaps the next.
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
      const messagesBeforeLoad = agent.messages;
      const messageCountBeforeLoad = messagesBeforeLoad.length;
      const load = activeId === mainChatId ? fetchMainChat({ chatServiceUrl }) : openConversation({ id: activeId, chatServiceUrl });
      counted(reloadsOut, load).then(
        ({ messages, running, runId, failure }) => {
          next();
          if (!mounted || agent.isRunning || agent.messages !== messagesBeforeLoad || agent.messages.length !== messageCountBeforeLoad) return;
          if (JSON.stringify(messages) !== JSON.stringify(agent.messages)) agent.setMessages(messages);
          setMainChatRefreshError(null);
          setServerTurn(running === true ? { runId } : null);
          // Only the awaited run's failure: a send that never reached the Chat Service leaves an earlier one on record.
          const awaited = awaitedRunId.current;
          setTurnFailure(failure !== undefined && (awaited === undefined || failure.runId === awaited) ? failure : null);
        },
        (error: Error) => {
          next();
          if (mounted) setMainChatRefreshError(`The chat could not refresh: ${error.message}`);
        },
      );
    };
    next();
    return () => {
      mounted = false;
      window.clearTimeout(poll);
    };
  }, [agent, activeId, mainChatId, turnRunsOnServer, ready]);

  // A Turn that runs on the server with no stream here stops from the page too. Its Stop goes while one is
  // asked, until the reload says the Turn ended; a failed Stop comes back for another try.
  const serverRunId = serverTurn?.runId;
  const stopServerTurn =
    serverRunId !== undefined && activeId !== null
      ? () => {
          setStopError(null);
          setServerTurn({ runId: undefined });
          stopTurn({ id: activeId, runId: serverRunId, chatServiceUrl }).catch((error: Error) => {
            if (currentAgent.current !== agent) return;
            setStopError(stopFailure(error));
            setServerTurn((turn) => (turn === null ? null : { runId: turn.runId ?? serverRunId }));
          });
        }
      : null;

  const handleSelectConversation = async (conversation: ConversationEntry) => {
    const request = ++navigation.current;
    navigationDestination.current = conversation.id;
    try {
      const session = await openConversation({ id: conversation.id, chatServiceUrl });
      if (request !== navigation.current) return;
      openChat(conversation.id, session);
      setSideChatsError(null);
    } catch (error) {
      console.error(error);
      if (request === navigation.current) {
        if (activeId !== null && deletedChats.current.has(activeId)) handleNewConversation();
        else navigationDestination.current = activeId;
        setSideChatsError(`${conversation.title} could not be opened: ${(error as Error).message}`);
      }
    }
  };

  const handleDeleteConversation = (conversation: ConversationEntry) =>
    sideChatAction(`${conversation.title} could not be deleted`, async () => {
      await deleteConversation({ id: conversation.id, chatServiceUrl });
      deletedChats.current.add(conversation.id);
      setSideChats((prev) => prev.filter((entry) => entry.id !== conversation.id));
      if (conversation.id === navigationDestination.current) handleNewConversation();
    });

  return {
    current: { id: activeId, newChat: newChatOwner !== null && newChatOwner.accountId === accountId, provider: activeProvider, agent, selfManagedAgents, showWelcome, stopServerTurn, turnFailure },
    mainChatId,
    sideChats: { entries: sideChats, error: sideChatsError },
    failures: { mainChat: mainChatError, linkedChat: linkedChatError, refresh: mainChatRefreshError, stop: stopError },
    openMainChat,
    selectMainChat,
    newSideChat: handleNewConversation,
    selectSideChat: handleSelectConversation,
    deleteSideChat: handleDeleteConversation,
    messageSubmitted() {
      setUserSentMessage(true);
      void refreshSideChats();
    },
  };
}
