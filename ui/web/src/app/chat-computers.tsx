"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import type { AbstractAgent, CustomEvent } from "@ag-ui/client";
import type { ComputerViewProps, WebUiPlugin } from "../cartridge/index.js";

const HIDDEN_LIFETIME_MS = 60_000;

type CurrentComputer = { conversation: ComputerViewProps["conversation"]; agent: AbstractAgent };
type Entry = CurrentComputer & { hiddenAt: number | null };

function ChatComputer({ entry, View, agentId, agentName, shown, stop }: {
  entry: Entry;
  View: NonNullable<WebUiPlugin["ComputerView"]>;
  agentId: string;
  agentName: string;
  shown: boolean;
  stop: (() => void) | null;
}) {
  const { agent } = entry;
  const snapshot = () => ({ agent, messages: agent.messages, running: agent.isRunning });
  const [activity, setActivity] = useState(snapshot);
  const current = activity.agent === agent ? activity : snapshot();
  useLayoutEffect(() => {
    setActivity(snapshot());
    const subscription = agent.subscribe({
      onMessagesChanged: () => setActivity(snapshot()),
      onRunInitialized: () => setActivity(snapshot()),
      onRunFinalized: () => setActivity(snapshot()),
    });
    return () => subscription.unsubscribe();
  }, [agent]);
  const subscribeToCustomEvents = useCallback((listener: (event: CustomEvent) => void) => {
    const subscription = agent.subscribe({ onCustomEvent: ({ event }) => listener(event) });
    return () => subscription.unsubscribe();
  }, [agent]);
  return <View agentId={agentId} agentName={agentName} conversation={entry.conversation} shown={shown}
    activity={{ messages: current.messages, running: current.running, stop, subscribeToCustomEvents }} />;
}

/** The two most recently opened computers survive a quick chat round trip within this account. */
export function ChatComputers({ current, View, agentId, agentName, shown, stop }: {
  current: CurrentComputer | null;
  View: NonNullable<WebUiPlugin["ComputerView"]>;
  agentId: string;
  agentName: string;
  shown: boolean;
  stop: (() => void) | null;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const selectedId = shown ? current?.conversation.id : undefined;
  const ordered = [...entries.filter((entry) => entry.conversation.id !== selectedId), ...entries.filter((entry) => entry.conversation.id === selectedId)];
  const next = ordered.map((entry) => {
    const selected = entry.conversation.id === selectedId;
    const agent = selected && current ? current.agent : entry.agent;
    const hiddenAt = selected ? null : entry.hiddenAt ?? Date.now();
    return agent === entry.agent && hiddenAt === entry.hiddenAt ? entry : { ...entry, agent, hiddenAt };
  });
  if (current && shown && !entries.some((entry) => entry.conversation.id === selectedId)) {
    next.push({ ...current, hiddenAt: null });
    if (next.length > 2) next.shift();
  }
  if (next.length !== entries.length || next.some((entry, index) => entry !== entries[index])) setEntries(next);

  useEffect(() => {
    const deadlines = entries.flatMap((entry) => entry.hiddenAt === null ? [] : [entry.hiddenAt + HIDDEN_LIFETIME_MS]);
    if (deadlines.length === 0) return;
    const timer = setTimeout(() => setEntries((current) => current.filter((entry) => entry.hiddenAt === null || entry.hiddenAt + HIDDEN_LIFETIME_MS > Date.now())), Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => clearTimeout(timer);
  }, [entries]);

  return entries.map((entry) => {
    const selected = entry.conversation.id === selectedId;
    return <div key={entry.conversation.id} hidden={!selected} inert={!selected} style={{ height: "100%" }}>
      <ChatComputer entry={entry} View={View} agentId={agentId} agentName={agentName} shown={selected} stop={selected ? stop : null} />
    </div>;
  });
}
