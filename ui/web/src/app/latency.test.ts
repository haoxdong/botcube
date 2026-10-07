import { beforeEach, describe, expect, it, vi } from "vitest";
import { endMoment, endOpeningMoment, measureMoment, reportMoments, startMoment, type LatencyRecorder } from "./latency";

describe("latency moments", () => {
  const recorded = () => {
    const recordEvent = vi.fn<LatencyRecorder["recordEvent"]>();
    reportMoments({ recordEvent });
    return recordEvent;
  };

  // Suites that ran before in the same worker may have left measures in the shared timeline.
  beforeEach(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });

  it("measures a moment its caller timed from the start it gives", () => {
    measureMoment("computer-cold", 0);

    expect(performance.getEntriesByName("latency:computer-cold", "measure")[0]?.startTime).toBe(0);
  });

  it("reports each moment from its start to its end, those measured before reporting began included", async () => {
    startMoment("computer-return");
    endMoment("computer-return");
    const recordEvent = recorded();
    startMoment("activity");
    endMoment("activity");

    await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledTimes(2));
    expect(recordEvent.mock.calls.map(([type, { moment }]) => [type, moment])).toEqual([
      ["latency", "computer-return"],
      ["latency", "activity"],
    ]);
    expect(recordEvent.mock.calls.every(([, { durationMs }]) => Number.isInteger(durationMs) && durationMs >= 0)).toBe(true);
  });

  it("measures nothing for a moment that ends without starting, or ends again", async () => {
    endMoment("send-acknowledged");
    startMoment("send-acknowledged");
    endMoment("send-acknowledged");
    endMoment("send-acknowledged");
    const recordEvent = recorded();

    await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledOnce());
  });

  it("measures a moment that starts as the page opens from the opening, once per opening", async () => {
    endOpeningMoment("history-first-visit");
    endOpeningMoment("history-first-visit");
    const recordEvent = recorded();

    await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledOnce());
    const { moment, durationMs } = recordEvent.mock.calls[0]?.[1] ?? {};
    expect(moment).toBe("history-first-visit");
    expect(durationMs).toBeLessThanOrEqual(Math.round(performance.now()));
    expect(durationMs).toBeGreaterThan(0);
  });

  it("reports only its own moments", async () => {
    performance.measure("another-library");
    startMoment("send-acknowledged");
    endMoment("send-acknowledged");
    const recordEvent = recorded();

    await vi.waitFor(() => expect(recordEvent).toHaveBeenCalledOnce());
    expect(recordEvent.mock.calls[0]?.[1].moment).toBe("send-acknowledged");
  });
});
