"use client";

/** The moments the page times, each named as in the product's latency budgets. */
export type Moment = "history-returning" | "history-first-visit" | "computer-return" | "computer-cold" | "send-acknowledged" | "activity";

const PREFIX = "latency:";

/** Where a moment's measures go: CloudWatch RUM in production. */
export type LatencyRecorder = { recordEvent: (type: string, data: { moment: string; durationMs: number }) => void };

/** The action that starts a moment happened now. */
export function startMoment(moment: Moment) {
  performance.mark(PREFIX + moment);
}

/** What ends a moment is on screen now: it is measured from its start, once; nothing is measured if it did not start. */
export function endMoment(moment: Moment) {
  const name = PREFIX + moment;
  if (performance.getEntriesByName(name, "mark").length === 0) return;
  performance.measure(name, name);
  performance.clearMarks(name);
}

/** What ends a moment its caller timed from `start` is on screen now. */
export function measureMoment(moment: Moment, start: number) {
  performance.measure(PREFIX + moment, { start });
}

/** What ends a moment that starts as the page opens is on screen now: it is measured once per opening. */
export function endOpeningMoment(moment: Moment) {
  const name = PREFIX + moment;
  if (performance.getEntriesByName(name, "measure").length > 0) return;
  performance.measure(name, { start: 0 });
}

/** Sends each moment measured, the ones before this call included, to `recorder`. */
export function reportMoments(recorder: LatencyRecorder) {
  const observer = new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) {
      if (!entry.name.startsWith(PREFIX)) continue;
      recorder.recordEvent("latency", { moment: entry.name.slice(PREFIX.length), durationMs: Math.round(entry.duration) });
    }
  });
  observer.observe({ type: "measure", buffered: true });
}
