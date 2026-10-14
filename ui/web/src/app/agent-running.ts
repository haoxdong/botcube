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
