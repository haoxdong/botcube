/** Why the Chat Service refused a request: its `detail`, a coded detail's `message`, or the fallback with the status when it gives none. */
export async function failureDetail(response: Response, fallback: string): Promise<string> {
  try {
    const { detail } = (await response.json()) as { detail?: unknown };
    if (typeof detail === 'string' && detail) return detail;
    const message = detail && typeof detail === 'object' && 'message' in detail ? detail.message : undefined;
    if (typeof message === 'string' && message) return message;
  } catch {
    // A body that is not JSON carries no reason; the status below does.
  }
  return `${fallback}: ${response.status}`;
}
