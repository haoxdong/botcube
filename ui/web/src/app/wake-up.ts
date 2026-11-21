"use client";

/** The measured unpark, from the Wake up press to the API serving again (docs/runbooks/production-parking.md). */
const WAKE_MINUTES = 12;
export const WAKE_POLL_MS = 15_000;

export type WakeState =
  | { state: "parked" }
  | { state: "waking"; since: string }
  | { state: "limit"; limit: number }
  | { state: "live" };

type WakeReporter = { recordEvent: (type: string, data: object) => void };
let reporter: WakeReporter | null = null;

export function reportWakeRequests(next: WakeReporter | null): void {
  reporter = next;
}

async function requestWake(chatServiceUrl: string, method: "GET" | "POST", fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Response> {
  const request = { method, url: `${chatServiceUrl}/production/wake` };
  try {
    const response = await fetchImpl(request.url, { method, cache: "no-store", signal: signal ?? null });
    if (!response.ok) reporter?.recordEvent("com.amazon.rum.http_event", { version: "1.0.0", request, response: { status: response.status, statusText: response.statusText } });
    return response;
  } catch (error) {
    if (signal?.aborted) reporter?.recordEvent("wake_status_cancel", { method });
    else reporter?.recordEvent("com.amazon.rum.http_event", { version: "1.0.0", request, error: { type: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

export async function wake(chatServiceUrl: string, method: "GET" | "POST", fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<WakeState> {
  const response = await requestWake(chatServiceUrl, method, fetchImpl, signal);
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

export async function wakeLapsed(chatServiceUrl: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<boolean> {
  const answer = await requestWake(chatServiceUrl, "GET", fetchImpl, signal)
    .catch((error: unknown) => { if (!signal?.aborted && error instanceof TypeError) return null; throw error; });
  if (!answer?.ok) return false;
  return ((await answer.json()) as { state?: unknown }).state === "parked";
}
