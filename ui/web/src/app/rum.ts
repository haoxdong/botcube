"use client";

import { reportWakeRequests } from "./wake-up";
import { reportMoments } from "./latency";

/** The CloudWatch RUM app monitor the page reports to, and the build's release; a build without a monitor reports nowhere. */
export type RumConfig = { appMonitorId: string; identityPoolId: string; region: string; release: string };

export function rumConfig(): RumConfig | null {
  const appMonitorId = process.env.NEXT_PUBLIC_RUM_APP_MONITOR_ID;
  const identityPoolId = process.env.NEXT_PUBLIC_RUM_IDENTITY_POOL_ID;
  const region = process.env.NEXT_PUBLIC_RUM_REGION;
  if (!appMonitorId || !identityPoolId || !region) return null;
  return { appMonitorId, identityPoolId, region, release: process.env.NEXT_PUBLIC_RELEASE ?? "unreleased" };
}

/** Start RUM after the first paint. Earlier moments wait in the performance timeline. */
export function startRum({ appMonitorId, identityPoolId, region, release }: RumConfig): Promise<void> {
  return new Promise<void>((resolve, reject) => {
  const start = () =>
    import("aws-rum-web")
      .then(({ AwsRum }) => {
        const rum = new AwsRum(appMonitorId, release, region, {
          identityPoolId,
          endpoint: `https://dataplane.rum.${region}.amazonaws.com`,
          sessionSampleRate: 1,
          telemetries: ["errors", ["http", {
            urlsToExclude: [
              /^https:\/\/(?:cognito-identity|sts)(?:\.[a-z0-9-]+)?\.amazonaws\.com(?:\/|$)/,
              /\/production\/wake(?:\?|$)/,
            ],
          }]],
        });
        // Every event's metadata carries it, so the error grouper counts an automated browser's errors as test traffic.
        rum.addSessionAttributes({ automated: navigator.webdriver === true });
        reportMoments(rum);
        reportWakeRequests(rum);
      })
      .then(resolve, (cause: unknown) => {
        const error = new Error(`Latency reporting could not start: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        error.name = "LatencyReportingError";
        reject(error);
      });
  const whenIdle = () => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => void start()) : setTimeout(() => void start()));
  if (document.readyState === "complete") whenIdle();
  else window.addEventListener("load", whenIdle, { once: true });
  });
}
