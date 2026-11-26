"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import type { SavedMessagesHttpAgent, StreamPhase } from "./conversations";

/** `opening`: before RUN_STARTED. `ended`: the run's end event arrived; its stream still closes. `onServer`: no stream here. */
type TurnPhase = StreamPhase | "onServer";

export interface Turn {
  phase: TurnPhase;
  /** Null with no Turn, or a server Turn whose run is unknown. */
  stop: "local" | (() => void) | null;
  /** Holds `opening` until `run` streams or settles. */
  ask: (run: () => Promise<unknown>) => Promise<void>;
}

export function useTurn({ agent, runsOnServer, stopOnServer }: {
  agent: SavedMessagesHttpAgent;
  runsOnServer: boolean;
  stopOnServer: (() => void) | null;
}): Turn {
  const stream = useSyncExternalStore<StreamPhase>(agent.subscribeTurn, agent.getTurnPhase, () => "idle");
  const [asked, setAsked] = useState<SavedMessagesHttpAgent | null>(null);
  const ask = useCallback(async (run: () => Promise<unknown>) => {
    setAsked(agent);
    try {
      await run();
    } finally {
      setAsked((pending) => pending === agent ? null : pending);
    }
  }, [agent]);
  const phase: TurnPhase = stream !== "idle" ? stream : asked === agent ? "opening" : runsOnServer ? "onServer" : "idle";
  return { phase, stop: phase === "idle" ? null : phase === "onServer" ? stopOnServer : "local", ask };
}
