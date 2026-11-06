"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AbstractAgent, CustomEvent } from "@ag-ui/client";
import type { ComputerViewProps, WebUiPlugin } from "../cartridge/index.js";

type CurrentComputer = { conversation: ComputerViewProps["conversation"]; agent: AbstractAgent };
type Entry = { conversation: CurrentComputer["conversation"]; instance: object; connected: boolean };
const inactiveActivity: ComputerViewProps["activity"] = {
  messages: [], running: false, stop: null, subscribeToCustomEvents: () => () => {},
};
const snapshot = (agent: AbstractAgent | null) => agent === null ? null : ({ agent, messages: agent.messages, running: agent.isRunning });

function ChatComputer({ entry, agent, View, agentId, agentName, shown, stop, connectionChanged }: {
  entry: Entry;
  agent: AbstractAgent | null;
  View: NonNullable<WebUiPlugin["ComputerView"]>;
  agentId: string;
  agentName: string;
  shown: boolean;
  stop: (() => void) | null;
  connectionChanged: (instance: object, connected: boolean) => void;
}) {
  const [activity, setActivity] = useState(() => snapshot(agent));
  const current = activity?.agent === agent ? activity : snapshot(agent);
  useLayoutEffect(() => {
    setActivity(snapshot(agent));
    if (agent === null) return;
    const subscription = agent.subscribe({
      onMessagesChanged: () => setActivity(snapshot(agent)),
      onRunInitialized: () => setActivity(snapshot(agent)),
      onRunFinalized: () => setActivity(snapshot(agent)),
    });
    return () => subscription.unsubscribe();
  }, [agent]);
  const subscribeToCustomEvents = useCallback((listener: (event: CustomEvent) => void) => {
    if (agent === null) return () => {};
    const subscription = agent.subscribe({ onCustomEvent: ({ event }) => listener(event) });
    return () => subscription.unsubscribe();
  }, [agent]);
  const { instance } = entry;
  const onConnectionChange = useCallback((connected: boolean) => connectionChanged(instance, connected), [connectionChanged, instance]);
  return <View agentId={agentId} agentName={agentName} conversation={entry.conversation} shown={shown}
    onConnectionChange={onConnectionChange}
    activity={current === null ? inactiveActivity : { messages: current.messages, running: current.running, stop, subscribeToCustomEvents }} />;
}

/** Connected computers survive chat navigation within this account until their streams release. */
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
  const selected = useRef(selectedId);
  selected.current = selectedId;
  const connectionChanged = useCallback((instance: object, connected: boolean) => {
    setEntries((entries) => entries.flatMap((entry) => {
      if (entry.instance !== instance) return [entry];
      if (!connected && entry.conversation.id !== selected.current) return [];
      return [entry.connected === connected ? entry : { ...entry, connected }];
    }));
  }, []);
  const next = entries.filter((entry) => entry.connected || entry.conversation.id === selectedId);
  if (current && shown && !next.some((entry) => entry.conversation.id === selectedId)) {
    next.push({ conversation: current.conversation, instance: {}, connected: false });
  }
  if (next.length !== entries.length || next.some((entry, index) => entry !== entries[index])) setEntries(next);

  return next.map((entry) => {
    const shown = entry.conversation.id === selectedId;
    return <div key={entry.conversation.id} hidden={!shown} inert={!shown} style={{ height: "100%" }}>
      <ChatComputer entry={entry} agent={shown && current ? current.agent : null} View={View} agentId={agentId} agentName={agentName}
        shown={shown} stop={shown ? stop : null} connectionChanged={connectionChanged} />
    </div>;
  });
}
