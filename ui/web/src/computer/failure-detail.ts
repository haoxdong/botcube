/** Why the Chat Service refused a request: its `detail`, or the fallback with the status when it gives none. */
export async function failureDetail(response: Response, fallback: string): Promise<string> {
  try {
    const { detail } = (await response.json()) as { detail?: unknown };
    if (typeof detail === 'string' && detail) return detail;
  } catch {
    // A body that is not JSON carries no reason; the status below does.
  }
  return `${fallback}: ${response.status}`;
}
