import { createContext, createElement, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { useAnimationControls } from "motion/react";
import { motionTokens } from "./motion-tokens";

type Entrance = "history" | "arrival";

export class MessageEntrances {
  private readonly presentedRows = new Set<string>();
  private readonly presentedMessages = new Set<string>();
  private readonly savedMessages = new Set<string>();
  private readonly artifacts = new Map<string, symbol>();

  constructor(messages: readonly { id: string }[]) {
    this.history(messages);
  }

  history(messages: readonly { id: string }[]) {
    for (const { id } of messages) {
      this.savedMessages.add(id);
    }
  }

  entrance(id: string): Entrance {
    return (this.savedMessages.has(id) || this.presentedRows.has(id)) ? "history" : "arrival";
  }

  fromHistory(id: string) {
    return this.savedMessages.has(id);
  }

  presentedRow(id: string) {
    this.presentedRows.add(id);
  }

  messageEntrance(id: string): Entrance {
    return this.savedMessages.has(id) || this.presentedMessages.has(id) ? "history" : "arrival";
  }

  presentedMessage(id: string) {
    this.presentedMessages.add(id);
  }

  presentedArtifacts(artifacts: readonly string[], root: symbol) {
    for (const key of artifacts) this.artifacts.set(key, root);
  }

  replaces(artifacts: readonly string[], root: symbol) {
    return artifacts.some((key) => this.artifacts.has(key) && this.artifacts.get(key) !== root);
  }
}

export const MessageEntranceHistory = createContext<MessageEntrances | null>(null);
const MessageEntrance = createContext<Entrance>("arrival");
const AT_REST = { opacity: 1, transform: "none" };
const ARRIVING = { opacity: 0, transform: "translateY(6px)" };

export function useMessageEntrance(id: string, { artifacts = [], answer = false, hasContent = true }: { artifacts?: readonly string[]; answer?: boolean; hasContent?: boolean } = {}) {
  const history = useContext(MessageEntranceHistory);
  const entrance = useContext(MessageEntrance);
  const [root] = useState(() => Symbol());
  const replacement = answer && history?.replaces(artifacts, root) === true;
  const [arrives] = useState(() => entrance === "arrival" && history?.messageEntrance(id) !== "history" && !replacement && motionTokens().move.duration > 0);
  const controls = useAnimationControls();
  useLayoutEffect(() => {
    if (arrives) void controls.start({ ...AT_REST, transitionEnd: AT_REST }, motionTokens().move);
    else controls.set(AT_REST);
  }, [arrives, controls]);
  useLayoutEffect(() => {
    if (replacement) {
      controls.stop();
      controls.set(AT_REST);
    }
    if (hasContent) history?.presentedMessage(id);
    history?.presentedArtifacts(artifacts, root);
  });
  const initial: false | typeof ARRIVING = arrives ? ARRIVING : false;
  return { initial, animate: controls };
}

export function MessageEntranceRow({ id, children }: { id: string; children: ReactNode }) {
  const history = useContext(MessageEntranceHistory);
  const [entrance] = useState(() => history?.entrance(id) ?? "arrival");
  useLayoutEffect(() => { history?.presentedRow(id); }, [history, id]);
  return createElement(MessageEntrance.Provider, { value: history?.fromHistory(id) ? "history" : entrance }, children);
}
