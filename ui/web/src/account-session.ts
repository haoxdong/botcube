"use client";

export type AccountSessionStatus = "loading" | "ready" | "parked" | "error";

export async function initializeAccountSession({
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ status: "ready"; accountId: string } | { status: "parked" }> {
  const response = await fetchImpl(`${chatServiceUrl}/account/session`, {
    credentials: "include",
    cache: "no-store",
  });
  if (response.ok) {
    const { accountId } = (await response.json()) as { accountId?: unknown };
    if (typeof accountId !== "string") throw new Error("Account session response is invalid");
    return { status: "ready", accountId };
  }
  if (response.status === 503) {
    const body = await responseJson(response);
    // Parked production's Cloudflare Worker (docs/runbooks/production-parking.md).
    if (body?.status === "parked") return { status: "parked" };
  }
  throw new Error(`Account session failed: ${response.status}`);
}

async function responseJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
