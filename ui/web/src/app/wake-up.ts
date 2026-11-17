"use client";

/** The measured unpark, from the Wake up press to the API serving again (docs/runbooks/production-parking.md). */
const WAKE_MINUTES = 12;
export const WAKE_POLL_MS = 15_000;

export type WakeState =
  | { state: "parked" }
  | { state: "waking"; since: string }
  | { state: "limit"; limit: number }
  | { state: "live" };

export async function wake(chatServiceUrl: string, method: "GET" | "POST", fetchImpl: typeof fetch = fetch): Promise<WakeState> {
  const response = await fetchImpl(`${chatServiceUrl}/production/wake`, { method, cache: "no-store" });
  if (!response.ok) throw new Error(`Wake up failed: ${response.status}`);
  const body = (await response.json()) as Partial<{ state: string; since: string; limit: number }>;
  if (body.state === "parked" || body.state === "live") return { state: body.state };
  if (body.state === "waking" && typeof body.since === "string") return { state: "waking", since: body.since };
  if (body.state === "limit" && typeof body.limit === "number") return { state: "limit", limit: body.limit };
  throw new Error("Wake up answered an unknown state");
}

export function minutesLeft(since: string, now: number): number {
  return Math.min(WAKE_MINUTES, Math.max(1, Math.ceil(WAKE_MINUTES - (now - Date.parse(since)) / 60_000)));
}

type Poll = { fetchImpl?: typeof fetch; pause?: (ms: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal; onPoll?: () => Promise<void> };

/** Polls the API until it serves again, calling onPoll after each pause; aborting `signal` ends the loop and its pending pause. */
export async function untilLive(chatServiceUrl: string, { fetchImpl = fetch, pause = pauseFor, signal, onPoll }: Poll = {}): Promise<void> {
  for (;;) {
    signal?.throwIfAborted();
    // eslint-disable-next-line no-await-in-loop -- each check waits for the last
    const answer = await fetchImpl(`${chatServiceUrl}/account/session`, { credentials: "include", cache: "no-store", signal: signal ?? null })
      .catch((error: unknown) => { if (error instanceof TypeError) return null; throw error; });
    if (answer?.ok) return;
    if (answer && answer.status < 500) throw new Error(`Account session failed: ${answer.status}`);
    // eslint-disable-next-line no-await-in-loop -- polls until unpark finishes
    await pause(WAKE_POLL_MS, signal);
    // eslint-disable-next-line no-await-in-loop -- the caller's check runs between polls
    await onPoll?.();
  }
}

function pauseFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export async function wakeLapsed(chatServiceUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const answer = await fetchImpl(`${chatServiceUrl}/production/wake`, { cache: "no-store" })
    .catch((error: unknown) => { if (error instanceof TypeError) return null; throw error; });
  if (!answer?.ok) return false;
  return ((await answer.json()) as { state?: unknown }).state === "parked";
}
