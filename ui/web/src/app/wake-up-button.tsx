"use client";

import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { LoadFailed } from "./load-state";
import { minutesLeft, untilLive, wake, WAKE_POLL_MS, wakeLapsed, type WakeState } from "./wake-up";

type Shown = WakeState | { state: "checking" } | { state: "failed"; error: string };

const asked = (chatServiceUrl: string, method: "GET" | "POST"): Promise<Shown> =>
  wake(chatServiceUrl, method).catch((error: unknown) => ({ state: "failed", error: error instanceof Error ? error.message : String(error) }));

export function WakeUpButton({ title, chatServiceUrl }: { title: string; chatServiceUrl: string }) {
  const [shown, setShown] = useState<Shown>({ state: "checking" });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let current = true;
    void asked(chatServiceUrl, "GET").then((next) => { if (current) setShown(next); });
    return () => { current = false; };
  }, [chatServiceUrl]);

  const waking = shown.state === "waking" || shown.state === "live";
  useEffect(() => {
    if (!waking) return undefined;
    let current = true;
    const fail = (error: unknown) => { if (current) setShown({ state: "failed", error: error instanceof Error ? error.message : String(error) }); };
    void untilLive(chatServiceUrl).then(() => { if (current) window.location.reload(); }, fail);
    const tick = setInterval(() => {
      setNow(Date.now());
      void wakeLapsed(chatServiceUrl).then((lapsed) => { if (lapsed) fail(new Error("the wake did not start")); }, fail);
    }, WAKE_POLL_MS);
    return () => { current = false; clearInterval(tick); };
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
