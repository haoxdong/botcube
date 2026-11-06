import { useRef, useState } from "react";
import type { AuthUiState } from "../cartridge/index.js";
import { chatServiceUrl } from "../cartridge/chat-service-url";
import { ChatServiceError } from "./conversations";
import type { useSessionNavigation } from "./session-navigation";
import type { ModelList } from "./model-selection";
const CHAT_SERVICE_URL = chatServiceUrl();
type Current = ReturnType<typeof useSessionNavigation>["current"];
/**
 * Warms a chat's Sandbox on the first compose action in its composer (typing, paste, a file) before each send, so the
 * ~3 s machine start hides behind composing. Later compose actions before the next send warm nothing, and opening,
 * focusing or clicking through a chat warms nothing: a user only browsing chats starts no Session.
 */
export function useAgentWarmup({ auth, ready, accountId, activeId, activeAccountId, mainChatId, newChat, models, offeredModel, effort, turnRunning, agent }: {
  auth: AuthUiState;
  ready: boolean;
  accountId: AuthUiState["accountId"];
  activeId: Current["id"];
  activeAccountId: Current["accountId"];
  mainChatId: string | null;
  newChat: Current["newChat"];
  models: ModelList;
  offeredModel: string | undefined;
  effort: string;
  turnRunning: boolean;
  agent: Current["agent"];
}) {
  const [warmupError, setWarmupError] = useState<{ accountId: typeof accountId; threadId: string; message: string } | null>(null);
  const warmupRequest = useRef(0);
  const pendingWarmups = useRef(new Map<string, Promise<void>>());
  // The chats warmed since their last send.
  const warmed = useRef(new Set<string>());

  // A chat keeps its key once it is no longer new, so reopening it does not warm it again before its next send.
  const keyFor = (target: { threadId: string; newChat?: true }) =>
    JSON.stringify({ accountId, ...(target.threadId === mainChatId ? { mainChat: true } : { threadId: target.threadId }) });
  const warmup = (target: { threadId: string; newChat?: true }) => {
    const key = keyFor(target);
    if (pendingWarmups.current.has(key) || warmed.current.has(key)) return;
    warmed.current.add(key);
    const request = ++warmupRequest.current;
    const pending = auth.isAccountCurrent?.(accountId) === false ? Promise.resolve() : fetch(`${CHAT_SERVICE_URL}/warmup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ...target, model: offeredModel, effort }),
    }).then((response) => {
      if (!response.ok) throw new ChatServiceError("prepare the agent", response.status);
      if (request === warmupRequest.current) setWarmupError(null);
    }).catch((error: unknown) => {
      if (request === warmupRequest.current) {
        setWarmupError({ accountId, threadId: target.threadId, message: `Your agent could not be prepared: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
    pendingWarmups.current.set(key, pending);
    void pending.then(() => {
      if (pendingWarmups.current.get(key) === pending) pendingWarmups.current.delete(key);
    });
  };
  // The user put something into the open chat's composer. A running Turn already holds the Sandbox.
  const composing = () => {
    if (!ready || activeId === null || activeAccountId !== accountId || !models.loaded || models.accountId !== accountId) return;
    if (turnRunning || agent.isRunning || document.visibilityState !== "visible") return;
    warmup({ threadId: activeId, ...(newChat && { newChat: true }) });
  };

  // A send starts the chat's next compose period: its first compose action warms again.
  const turnStarting = () => {
    if (activeId !== null) warmed.current.delete(keyFor({ threadId: activeId }));
  };
  return { error: warmupError?.threadId === activeId ? warmupError : null, turnStarting, composing };
}
