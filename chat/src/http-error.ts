/** A client-facing failure, answered as `{"detail": ...}`, the shape the UI reads. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly code?: string,
  ) {
    super(detail);
  }
}
