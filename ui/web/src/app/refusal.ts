/** Throws an error naming the Chat Service's `detail` (or else its status) when it refused the request. */
export async function throwIfRefused(response: Response, failure: string): Promise<void> {
  if (response.ok) return;
  const body = (await response.json().catch(() => undefined)) as { detail?: unknown } | undefined;
  throw new Error(`${failure}: ${typeof body?.detail === "string" ? body.detail : response.status}`);
}
