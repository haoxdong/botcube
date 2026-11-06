"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildDirectAgent, ChatServiceError, stopFailure } from "./conversations";
import { useSessionNavigation } from "./session-navigation";
import type { TemporaryChat } from "../temporary-chat";

/**
 * A signed-out visitor's chat: a temporary chat the Chat Service never stores, held only by its agent here, so a
 * reload or a sign-in starts over. It navigates as `useSessionNavigation` does, with no Side Chats to go to.
 */
export function useTemporarySession({ enabled, chatServiceUrl, agentId }: {
  enabled: boolean;
  chatServiceUrl: string;
  agentId: string;
}): ReturnType<typeof useSessionNavigation> {
  const [chat, setChat] = useState<TemporaryChat | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | undefined>(undefined);
  const [submitted, setSubmitted] = useState(false);
  const [hasMessages, setHasMessages] = useState(false);
  const request = useRef(0);

  const startChat = async () => {
    const started = ++request.current;
    setStartError(null);
    try {
      const next = await startTemporaryChat(chatServiceUrl);
      if (started !== request.current) return false;
      setChat(next);
      setStopError(null);
      setProvider(undefined);
      setSubmitted(false);
      setHasMessages(false);
      return true;
    } catch (error) {
      console.error(error);
      if (started === request.current) setStartError(`Your chat could not be started: ${(error as Error).message}`);
      return false;
    }
  };

  useEffect(() => {
    if (!enabled) return undefined;
    void startChat();
    return () => {
      ++request.current;
      setChat(null);
    };
  }, [enabled]);

  const { agent, selfManagedAgents } = useMemo(() => {
    const direct = () => buildDirectAgent({
      chatServiceUrl,
      threadId: chat?.sessionId ?? "",
      messages: [],
      onStopFailed: (error: Error) => setStopError(stopFailure(error)),
      ...(chat === null ? {} : { temporaryChat: chat }),
    });
    const threadAgent = direct();
    return { agent: threadAgent, selfManagedAgents: { default: direct(), [agentId]: threadAgent } };
  }, [chat]);

  useEffect(() => {
    const subscription = agent.subscribe({
      onMessagesChanged: ({ messages }) => {
        if (messages.length > 0) setHasMessages(true);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  const id = chat?.sessionId ?? null;
  return {
    current: {
      id, accountId: undefined, openAt: null, newChat: false, provider, readOnly: false, agent, selfManagedAgents,
      showWelcome: !submitted && !hasMessages && provider === undefined,
      stopServerTurn: null, turnFailure: null, runningSince: undefined,
      turnRunning: false, turnRunsOnServer: false, turnMayRun: () => undefined,
    },
    mainChatId: id,
    mainChatUnread: false,
    sideChats: { entries: [], error: null, listed: true },
    failures: { mainChat: startError, linkedChat: null, refresh: null, stop: stopError },
    openMainChat: async () => { await startChat(); },
    selectMainChat: () => undefined,
    newSideChat: startChat,
    selectSideChat: async () => undefined,
    renameSideChat: async () => undefined,
    deleteSideChat: async () => undefined,
    turnStarting(started: string | undefined) {
      setSubmitted(true);
      setProvider(started);
    },
    messageSubmitted() {
      setSubmitted(true);
    },
  };
}

/**
 * The chat a page opens: a temporary chat for a visitor who is not signed in, else the account's stored chats; and
 * whether the account's own surfaces (profile, warmup, Files) load, which a temporary chat never has.
 */
export function useChatSession({ temporary, ...options }: Parameters<typeof useSessionNavigation>[0] & { temporary: boolean }) {
  const stored = useSessionNavigation({ ...options, ready: options.ready && !temporary });
  const visitor = useTemporarySession({ enabled: options.ready && temporary, chatServiceUrl: options.chatServiceUrl, agentId: options.agentId });
  return { ...(temporary ? visitor : stored), accountReady: options.ready && !temporary };
}

async function startTemporaryChat(chatServiceUrl: string): Promise<TemporaryChat> {
  const response = await fetch(`${chatServiceUrl}/temporary-chats`, { method: "POST", credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new ChatServiceError("start a temporary chat", response.status);
  return (await response.json()) as TemporaryChat;
}
