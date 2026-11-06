export type SessionIdentity = {
  session_id: string;
  filing_user_id: string;
  /** Set on every chat from before the one Session ID cutover, by the cutover's one-off mark_read_only.py script. */
  read_only?: true;
};

export type SessionPurge = SessionIdentity & {
  /**
   * The account that owned the Session when it was fenced. After Account Claim its Turns file
   * events under its own actor, not the filing ID (ADR 0067 §8), so the purge covers both.
   * Jobs registered before owners were recorded take it from the fenced Session row.
   */
  owner?: string;
};

export class SessionReadOnlyError extends Error {}

type StoredSession = Partial<Record<'session_id' | 'read_only', unknown>>;
/** Every chat from before the one Session ID cutover carries `read_only: true` (the cutover's one-off mark_read_only.py script). */
export const oneIdSession = (session: StoredSession) => session.read_only !== true;

export const readOnlyError = (sessionId: unknown) =>
  new SessionReadOnlyError(`Session ${String(sessionId)} is read-only: it is from before the one Session ID cutover. Start a new chat.`);

export function assertContinuable(session: StoredSession): void {
  if (!oneIdSession(session)) throw readOnlyError(session.session_id);
}
