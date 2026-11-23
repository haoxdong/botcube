"use client";

import { useEffect, useState } from "react";
import type { AbstractAgent } from "@ag-ui/client";

/** Whether `agent` runs a Turn, from its run events; another agent, as when a Side Chat is chosen again, runs or not as it does. */
export function useAgentRunning(agent: AbstractAgent) {
  const [running, setRunning] = useState(agent.isRunning);
  useEffect(() => {
    setRunning(agent.isRunning);
    const subscription = agent.subscribe({
      onRunInitialized: () => setRunning(true),
      onRunFinalized: () => setRunning(false),
    });
    return () => subscription.unsubscribe();
  }, [agent]);
  return [running, setRunning] as const;
}

/**
 * Whether the run of `agent` has sent its end (RUN_FINISHED or RUN_ERROR). Its stream stays open a beat longer while the Chat
 * Service records the Turn, and `agent.isRunning` waits for that close; the answer is whole at the end event.
 */
export function useRunEnded(agent: AbstractAgent) {
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    setEnded(false);
    const subscription = agent.subscribe({
      onRunInitialized: () => setEnded(false),
      onRunFinishedEvent: () => setEnded(true),
      onRunErrorEvent: () => setEnded(true),
      onRunFinalized: () => setEnded(false),
    });
    return () => subscription.unsubscribe();
  }, [agent]);
  return ended;
}
