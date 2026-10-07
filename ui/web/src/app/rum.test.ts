import { afterEach, expect, it, vi } from "vitest";
import { startRum } from "./rum";

vi.mock("aws-rum-web", () => ({ AwsRum: class { constructor() { throw new Error("SDK initialization failed"); } } }));
afterEach(() => { vi.unstubAllGlobals(); });

it("defers startup until idle and propagates its classified failure", async () => {
  let idle: (() => void) | undefined;
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => { idle = callback; });
  const started = startRum({ appMonitorId: "test", identityPoolId: "test", region: "us-east-1" });
  window.dispatchEvent(new Event("load"));
  expect(idle).toBeDefined();
  const failed = expect(started).rejects.toMatchObject({ name: "LatencyReportingError", message: "Latency reporting could not start: SDK initialization failed" });
  idle?.();
  await failed;
});
