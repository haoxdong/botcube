"use client";

import { useEffect, useState } from "react";
import { Button } from "../components/pill-button";
import { LoadFailed } from "./load-state";
import { minutesLeft, untilLive, wake, wakeLapsed, type WakeState } from "./wake-up";

type Shown = WakeState | { state: "checking" } | { state: "failed"; error: string };

const asked = (chatServiceUrl: string, method: "GET" | "POST", signal?: AbortSignal): Promise<Shown> =>
  wake(chatServiceUrl, method, fetch, signal).catch((error: unknown) => ({ state: "failed", error: error instanceof Error ? error.message : String(error) }));

export function WakeUpButton({ title, chatServiceUrl }: { title: string; chatServiceUrl: string }) {
  const [shown, setShown] = useState<Shown>({ state: "checking" });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const stop = new AbortController();
    const cancel = (event: PageTransitionEvent) => { if (!event.persisted) stop.abort(); };
    window.addEventListener("pagehide", cancel);
    void asked(chatServiceUrl, "GET", stop.signal).then((next) => { if (!stop.signal.aborted) setShown(next); });
    return () => { window.removeEventListener("pagehide", cancel); stop.abort(); };
  }, [chatServiceUrl]);

  const waking = shown.state === "waking" || shown.state === "live";
  useEffect(() => {
    if (!waking) return undefined;
    const stop = new AbortController();
    const cancel = (event: PageTransitionEvent) => { if (!event.persisted) stop.abort(); };
    window.addEventListener("pagehide", cancel);
    const fail = (error: unknown) => { if (!stop.signal.aborted) setShown({ state: "failed", error: error instanceof Error ? error.message : String(error) }); };
    const onPoll = async () => {
      setNow(Date.now());
      if (await wakeLapsed(chatServiceUrl, fetch, stop.signal)) throw new Error("the wake did not start");
    };
    void untilLive(chatServiceUrl, { signal: stop.signal, onPoll }).then(() => { if (!stop.signal.aborted) window.location.reload(); }, fail);
    return () => { window.removeEventListener("pagehide", cancel); stop.abort(); };
  }, [waking, chatServiceUrl]);

  if (shown.state === "checking") return null;
  const press = () => { void asked(chatServiceUrl, "POST").then(setShown); };
  if (shown.state === "waking" || shown.state === "live") {
    const minutes = shown.state === "live" ? 1 : minutesLeft(shown.since, now);
    return <p className="welcome-desc" role="status">Waking up, about {minutes} {minutes === 1 ? "minute" : "minutes"}</p>;
  }
  if (shown.state === "limit") return <p className="welcome-error">{title} has been woken {shown.limit} times today. Try again tomorrow.</p>;
  if (shown.state === "failed") return <LoadFailed error={`Couldn't wake ${title}: ${shown.error}`} onRetry={press} action="Wake up" />;
  return <Button type="button" onClick={press}>Wake up</Button>;
}
