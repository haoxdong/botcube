import { afterEach, expect, it, vi } from "vitest";
import { startRum } from "./rum";

const sdk = vi.hoisted(() => ({ constructed: [] as unknown[][], sessionAttributes: [] as unknown[], fail: false }));
vi.mock("aws-rum-web", () => ({
  AwsRum: class {
    constructor(...args: unknown[]) {
      if (sdk.fail) throw new Error("SDK initialization failed");
      sdk.constructed.push(args);
    }
    recordEvent() {}
    addSessionAttributes(attributes: unknown) {
      sdk.sessionAttributes.push(attributes);
    }
  },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sdk.constructed = []; sdk.sessionAttributes = []; sdk.fail = false; });

function startWhenIdle() {
  let idle: (() => void) | undefined;
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => { idle = callback; });
  const started = startRum({ appMonitorId: "test", identityPoolId: "test-pool", region: "us-east-1", release: "0123abcd" });
  window.dispatchEvent(new Event("load"));
  expect(idle).toBeDefined();
  return { started, idle: () => idle?.() };
}

it("defers startup until idle and propagates its classified failure", async () => {
  sdk.fail = true;
  const { started, idle } = startWhenIdle();
  const failed = expect(started).rejects.toMatchObject({ name: "LatencyReportingError", message: "Latency reporting could not start: SDK initialization failed" });
  idle();
  await failed;
});

it("collects uncaught errors and failed requests under the build's release", async () => {
  const { started, idle } = startWhenIdle();
  idle();
  await started;
  expect(sdk.constructed).toEqual([["test", "0123abcd", "us-east-1", expect.objectContaining({ telemetries: ["errors", "http"] })]]);
});

it.each([false, true])("marks the session automated when an automation drives the browser (%s), so the error grouper counts its errors as test traffic", async (webdriver) => {
  vi.spyOn(navigator, "webdriver", "get").mockReturnValue(webdriver);
  const { started, idle } = startWhenIdle();
  idle();
  await started;
  expect(sdk.sessionAttributes).toEqual([{ automated: webdriver }]);
});
