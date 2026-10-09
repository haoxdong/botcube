import { positiveInteger } from './config.js';
import type { AgentDocuments } from './agent-documents.js';
import { HttpError } from './cartridge.js';
import type { ScheduledTasks } from './scheduled-tasks.js';
import type { SessionApi } from './session-api.js';
import { trackedRuntime, type SessionMetadata, type SessionPurge, type SessionSummary } from './session-metadata.js';

const threadSummary = ({ session_id, title, created_at, updated_at }: SessionSummary) => ({
  id: session_id,
  title,
  created_at,
  updated_at,
});

/**
 * How long a Turn can run: the AgentCore Runtime's maxLifetime (`botcube/infra/agentcore/cdk/lib/cdk-stack.ts`, ADR 0029)
 * ends any Turn by then, so an older running mark is one whose relay never ended, as when its task died.
 */
const TURN_BOUND_MS = positiveInteger(process.env, 'BOTCUBE_TURN_BOUND_MS', 3_600_000);

/**
 * Whether the Session's latest Turn still runs, for a page that opens it mid-Turn, and its run ID for
 * that page's Stop.
 */
const runningTurn = ({ turn_running_since, turn_run_id, turn_preparing }: SessionSummary) =>
  turn_running_since !== undefined && Date.now() - Date.parse(turn_running_since) < TURN_BOUND_MS
    ? { running: true, ...(turn_preparing === true ? {} : { runId: turn_run_id }) }
    : { running: false };

const historyRead = (sessionId: string, metadata: SessionSummary) => ({
  operation: 'get' as const,
  sessionId,
  userId: metadata.filing_user_id,
  ...(runningTurn(metadata).running || metadata.latest_message_id === undefined ? {} : { contains: metadata.latest_message_id }),
});

/**
 * The account's Sessions as the UI sees them: Metadata owns access and filing
 * identity; the session API owns their content. Both deletion paths share one
 * purge queue, after the Metadata fence makes the Sessions inaccessible.
 */
export function sessionOperations(
  sessionMetadata: SessionMetadata,
  invokeSessionApi: SessionApi,
  agentDocuments: AgentDocuments,
  scheduledTasks: ScheduledTasks | null,
  purge: (sessions: SessionPurge[], wait?: boolean) => Promise<void> | void,
  filingUserId: (owner: string) => string = (owner) => owner,
) {
  return {
    async sideChats(owner: string) {
      const [sessions, mainChat] = await Promise.all([sessionMetadata.list(owner), sessionMetadata.mainChat(owner, filingUserId(owner))]);
      const sideChats = sessions.filter((session) => session.session_id !== mainChat);
      return sideChats.map(threadSummary);
    },
    async mainChat(owner: string) {
      const id = await sessionMetadata.mainChat(owner, filingUserId(owner));
      const metadata = await sessionMetadata.get(owner, id);
      if (metadata === null || metadata.title === undefined) return { id, messages: [], running: false };
      const { messages } = await invokeSessionApi(historyRead(id, metadata));
      return { id, provider: metadata.provider, messages, ...runningTurn(metadata), failure: metadata.turn_failure };
    },
    /** The finished Turns of the account's Sessions, from Session Metadata alone, newest first. */
    async activity(owner: string) {
      const sessions = await sessionMetadata.list(owner);
      const listed = new Set(sessions.map(({ session_id }) => session_id));
      const filingUserIds = [...new Set(sessions.map(({ filing_user_id }) => filing_user_id))];
      const turns = (await Promise.all(filingUserIds.map((id) => sessionMetadata.turnSummaries(id)))).flat();
      const tasks = turns
        .filter(({ session_id }) => listed.has(session_id))
        .map(({ session_id, message_id, request, completed_at, title, summary, failed }) => {
          if (request === undefined || completed_at === undefined) {
            throw new Error(`Turn ${message_id} of Session ${session_id} has no Activity entry; run the Activity backfill`);
          }
          if (failed !== undefined) return { summary: request, failed, completedAt: completed_at };
          return title === undefined || summary === undefined
            ? { summary: request, completedAt: completed_at }
            : { title, summary, completedAt: completed_at };
        });
      return tasks.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
    },
    async replay(owner: string, sessionId: string) {
      const metadata = await sessionMetadata.get(owner, sessionId);
      if (metadata === null) throw new HttpError(404, 'Session not found');
      const { messages } = await invokeSessionApi(historyRead(sessionId, metadata));
      return { ...threadSummary(metadata), provider: metadata.provider, messages, ...runningTurn(metadata), failure: metadata.turn_failure };
    },
    async removeSideChat(owner: string, sessionId: string): Promise<void> {
      if (sessionId === (await sessionMetadata.mainChat(owner, filingUserId(owner)))) {
        throw new HttpError(409, 'The Main Chat cannot be deleted');
      }
      const metadata = await sessionMetadata.fence(owner, sessionId);
      if (metadata !== null) await purge([metadata]);
    },
    /** Account History deletion includes its documents and tasks, after fencing and enqueueing Sessions. */
    async removeOwner(accountId: string): Promise<void> {
      const sessions = await sessionMetadata.fenceOwner(accountId);
      if (sessions.some((session) => !trackedRuntime(session))) {
        await purge(sessions);
        throw new HttpError(503, 'Session legacy settlement is unproved; account history deletion remains pending');
      }
      try {
        await purge(sessions, true);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const pending = new HttpError(503, `Account history deletion remains pending: ${error instanceof Error ? error.message : String(error)}`);
        pending.cause = error;
        throw pending;
      }
      await agentDocuments.delete(accountId);
      await scheduledTasks?.deleteAll(accountId);
    },
  };
}
