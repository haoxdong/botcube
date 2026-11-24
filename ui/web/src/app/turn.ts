"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AbstractAgent } from "@ag-ui/client";
import { runStarted } from "./conversations";

/** `opening`: before RUN_STARTED. `ended`: the run's end event arrived; its stream still closes. `onServer`: no stream here. */
type TurnPhase = "idle" | "opening" | "started" | "ended" | "onServer";

export interface Turn {
  phase: TurnPhase;
  /** Null with no Turn, or a server Turn whose run is unknown. */
  stop: (() => void) | null;
  /** Holds `opening` until `run` streams or settles. */
  ask: (run: () => Promise<unknown>) => Promise<void>;
}

export function useTurn({ agent, runsOnServer, stopOnServer, stopHere }: {
  agent: AbstractAgent;
  runsOnServer: boolean;
  stopOnServer: (() => void) | null;
  stopHere?: () => void;
}): Turn {
  // Run events, not `isRunning`: AG-UI also sets that while it connects to a thread, which runs no Turn.
  const [stream, setStream] = useState<"none" | "asked" | "open" | "ended">(agent.isRunning ? "open" : "none");
  useEffect(() => {
    setStream(agent.isRunning ? "open" : "none");
    const subscription = agent.subscribe({
      onRunInitialized: () => setStream("open"),
      onRunFinishedEvent: () => setStream("ended"),
      onRunErrorEvent: () => setStream("ended"),
      onRunFinalized: () => setStream((now) => now === "asked" ? now : "none"),
    });
    return () => subscription.unsubscribe();
  }, [agent]);
  const subscribeStart = useCallback((listener: () => void) => {
    const subscription = agent.subscribe({ onRunStartedEvent: listener, onRunFinalized: listener });
    return () => subscription.unsubscribe();
  }, [agent]);
  const started = useSyncExternalStore(subscribeStart, () => runStarted(agent), () => false);
  const ask = useCallback(async (run: () => Promise<unknown>) => {
    setStream((now) => now === "none" ? "asked" : now);
    try {
      await run();
    } finally {
      setStream((now) => now === "asked" ? "none" : now);
    }
  }, []);
  const phase: TurnPhase = stream === "ended" ? "ended" : stream !== "none" ? started ? "started" : "opening" : runsOnServer ? "onServer" : "idle";
  return { phase, stop: phase === "idle" ? null : phase === "onServer" ? stopOnServer : stopHere ?? null, ask };
}
