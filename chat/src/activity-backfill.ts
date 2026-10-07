import type { SessionApi } from './session-api.js';
import type { DynamoDBSessionMetadata, StoredTurnSummary } from './session-metadata.js';

/** One answered Turn, as the session API's `activity` operation reports it. */
interface ActivityTask {
  sessionId: string;
  messageId?: string;
  /** The first line of the Turn's request. */
  summary: string;
  completedAt: string;
}

export interface ActivityBackfillReport {
  /** Listed Sessions the backfill read. */
  sessions: number;
  /** Their answered Turns, as the session API reports them. */
  turns: number;
  /** Turns whose row lacked its Activity entry: written, or to write on a dry run. */
  writes: number;
  /** Sessions the session API could not read, with why. */
  failed: string[];
  /** Rows of listed Sessions still without an Activity entry, which GET /activity fails on. */
  unfilled: string[];
}

const turnId = (sessionId: string, messageId: string) => `${sessionId} Turn ${messageId}`;
const hasEntry = (row: StoredTurnSummary | undefined) => row?.request !== undefined && row.completed_at !== undefined;

/**
 * The one-time Activity backfill: every answered Turn of every listed Session gets its
 * request's first line and completion time in Session Metadata, read through the session API.
 * Idempotent, as each write keeps the values a row holds. A dry run (`apply` false) writes nothing.
 * The report names every Session it could not read and every row left without an Activity entry.
 */
export async function backfillActivity(
  metadata: DynamoDBSessionMetadata,
  invokeSessionApi: SessionApi,
  { apply }: { apply: boolean },
): Promise<ActivityBackfillReport> {
  const sessions = await metadata.allSessions();
  const filingUserIds = [...new Set(sessions.map(({ session }) => session.filing_user_id))];
  const rowsOf = async () =>
    new Map(
      (await Promise.all(filingUserIds.map((id) => metadata.turnSummaries(id))))
        .flat()
        .map((row) => [turnId(row.session_id, row.message_id), row]),
    );
  const rows = await rowsOf();
  const failed: string[] = [];
  // One Session per call, so a Session the session API cannot read fails alone; the session API
  // client runs at most SESSION_API_CALLS_AT_ONCE of them at a time.
  const read = await Promise.all(
    sessions.map(async ({ owner, session }) => {
      try {
        const { tasks } = await invokeSessionApi({
          operation: 'activity',
          sessions: [{ sessionId: session.session_id, userId: session.filing_user_id }],
        });
        return { owner, session, tasks: tasks as ActivityTask[] };
      } catch (error) {
        failed.push(`${session.session_id}: ${error instanceof Error ? error.message : String(error)}`);
        return { owner, session, tasks: [] };
      }
    }),
  );
  const writes = read.flatMap(({ owner, session, tasks }) =>
    tasks.flatMap(({ messageId, summary, completedAt }) => {
      if (messageId === undefined) {
        failed.push(`${session.session_id}: a Turn finished at ${completedAt} has no request message ID`);
        return [];
      }
      if (hasEntry(rows.get(turnId(session.session_id, messageId)))) return [];
      const turn = { sessionId: session.session_id, filingUserId: session.filing_user_id, messageId };
      return [{ owner, turn, entry: { request: summary, completedAt } }];
    }),
  );
  if (apply) {
    for (const { owner, turn, entry } of writes) {
      // eslint-disable-next-line no-await-in-loop -- a few hundred writes, stopping at the first failure
      await metadata.backfillTurn(owner, turn, entry);
    }
  }
  const written = new Set(writes.map(({ turn }) => turnId(turn.sessionId, turn.messageId)));
  const listed = new Set(sessions.map(({ session }) => session.session_id));
  const unfilled = [...(apply ? await rowsOf() : rows).entries()]
    .filter(([id, row]) => listed.has(row.session_id) && !hasEntry(row) && (apply || !written.has(id)))
    .map(([id]) => id);
  return {
    sessions: sessions.length,
    turns: read.reduce((count, { tasks }) => count + tasks.length, 0),
    writes: writes.length,
    failed,
    unfilled,
  };
}
