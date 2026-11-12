"use client";

import { takeOpeningResponse } from "./opening-requests";

export type AccountSessionStatus = "loading" | "ready" | "parked" | "error";

export async function initializeAccountSession({
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ status: "ready"; accountId: string; account: Record<string, unknown>; temporary: boolean } | { status: "parked" }> {
  const response = await (takeOpeningResponse(`${chatServiceUrl}/account/session`) ?? fetchImpl(`${chatServiceUrl}/account/session`, {
    credentials: "include",
    cache: "no-store",
  }));
  if (response.ok) {
    const account = (await response.json()) as Record<string, unknown>;
    const { accountId } = account;
    if (typeof accountId !== "string") throw new Error("Account session response is invalid");
    return { status: "ready", accountId, account, temporary: account.authenticated !== true };
  }
  if (response.status === 503) {
    const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
    // Parked production's Cloudflare Worker (docs/runbooks/production-parking.md).
    if (body?.status === "parked") return { status: "parked" };
  }
  throw new Error(`Account session failed: ${response.status}`);
}
