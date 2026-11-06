import { randomUUID } from 'node:crypto';
import { SessionConcurrencyError, SessionBusyError, SessionClaimError, SessionDeletedError, SessionUnissuedError } from './session-metadata.js';
import { assertContinuable, oneIdSession, SessionReadOnlyError } from './session-identity.js';
import type { AgentDocuments } from './agent-documents.js';
import { HttpError } from './cartridge.js';
import type { ScheduledTasks } from './scheduled-tasks.js';
import { SessionNotFoundError, type SessionApi } from './session-api.js';
import type { SessionMetadata, SessionPurge, SessionSummary } from './session-metadata.js';

const threadSummary = ({ session_id, title, created_at, updated_at, scheduled_task_id, read_at, turn_completed_at }: SessionSummary) => ({
  id: session_id,
  title: title ?? 'Untitled conversation',
  created_at,
  updated_at,
  ...(read_at === undefined ? {} : { read_at }),
  ...(turn_completed_at === undefined ? {} : { turn_completed_at }),
  ...(scheduled_task_id === undefined ? {} : { scheduled: true }),
});

export const MAX_RUNNING_TURN_AGE_MS = 3_600_000;

const runningTurn = ({ turn_running_since, turn_run_id, turn_preparing }: SessionSummary) =>
  turn_running_since !== undefined && Date.now() - Date.parse(turn_running_since) < MAX_RUNNING_TURN_AGE_MS
    ? { running: true, runningSince: turn_running_since, ...(turn_preparing === true ? {} : { runId: turn_run_id }) }
    : { running: false };

const historyRead = (sessionId: string, metadata: SessionSummary) => ({
  operation: 'get' as const,
  sessionId,
  userId: metadata.filing_user_id,
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
  const refuseMainChat = async (owner: string, sessionId: string, action: 'renamed' | 'deleted') => {
    if (sessionId === (await sessionMetadata.mainChat(owner, filingUserId(owner)))) {
      throw new HttpError(409, `The Main Chat cannot be ${action}`);
    }
  };
  const replayState = async (owner: string, sessionId: string, metadata: SessionSummary) => {
    let absence: SessionNotFoundError;
    try {
      const { messages } = await invokeSessionApi(historyRead(sessionId, metadata));
      return { messages, failure: metadata.turn_failure?.code === 'SESSION_OPENING_ALREADY_STARTED' ? undefined : metadata.turn_failure };
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
      absence = error;
    }
    const running = runningTurn(metadata).running;
    if (metadata.turn_latest_run_id === undefined) throw absence;
    if (metadata.turn_failure?.runId === metadata.turn_latest_run_id && metadata.turn_running_since === undefined) {
      return { messages: [], failure: metadata.turn_failure };
    }
    if (metadata.title !== undefined && !running) throw absence;
    if (metadata.turn_running_since === undefined || metadata.turn_run_id !== metadata.turn_latest_run_id) throw absence;
    if (running) return { messages: [], failure: metadata.turn_failure };
    if (!(Date.now() - Date.parse(metadata.turn_running_since) >= MAX_RUNNING_TURN_AGE_MS)) throw absence;
    const failure = { code: 'TURN_INTERRUPTED', message: 'The Turn ended without a saved conversation. Send a message to continue.' };
    await sessionMetadata.turnEnded(owner, sessionId, { startedAt: metadata.turn_running_since, runId: metadata.turn_latest_run_id }, failure);
    const settled = await sessionMetadata.get(owner, sessionId);
    if (settled === null) throw new HttpError(404, 'Session not found');
    if (settled.turn_latest_run_id !== metadata.turn_latest_run_id || settled.turn_running_since !== undefined ||
        settled.turn_failure?.runId !== metadata.turn_latest_run_id) {
      throw new HttpError(409, 'The Session changed while its interrupted Turn was being settled. Reload the conversation.');
    }
    return { messages: [], failure: settled.turn_failure };
  };
  return {
    async createSideChat(owner: string) {
      const id = randomUUID();
      await sessionMetadata.recordTurn(owner, id, { filingUserId: filingUserId(owner), title: '', warmup: true, allocation: true });
      return { id };
    },
    async chatList(owner: string) {
      const [sessions, mainChat] = await Promise.all([sessionMetadata.list(owner), sessionMetadata.mainChat(owner, filingUserId(owner))]);
      const sideChats = sessions.filter((session) => session.session_id !== mainChat);
      const main = sessions.find((session) => session.session_id === mainChat);
      return { threads: sideChats.map(threadSummary),
        ...(main?.turn_completed_at === undefined ? {} : { mainChat: threadSummary(main) }),
      };
    },
    async mainChat(owner: string) {
      const id = await sessionMetadata.mainChat(owner, filingUserId(owner));
      const metadata = await sessionMetadata.get(owner, id);
      if (metadata === null || (metadata.title === undefined && metadata.turn_latest_run_id === undefined && metadata.latest_message_id === undefined)) return { id, messages: [], running: false };
      const state = await replayState(owner, id, metadata);
      return { id, provider: metadata.provider, ...state, ...runningTurn(metadata) };
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
      const state = await replayState(owner, sessionId, metadata);
      return { ...threadSummary(metadata), provider: metadata.provider, ...state, ...runningTurn(metadata), ...(oneIdSession(metadata) ? {} : { readOnly: true }) };
    },
    async renameSideChat(owner: string, sessionId: string, title: string) {
      await refuseMainChat(owner, sessionId, 'renamed');
      const renamed = await sessionMetadata.rename(owner, sessionId, title);
      if (renamed === null) throw new HttpError(404, 'Session not found');
      return threadSummary(renamed);
    },
    async removeSideChat(owner: string, sessionId: string): Promise<void> {
      await refuseMainChat(owner, sessionId, 'deleted');
      const metadata = await sessionMetadata.fence(owner, sessionId);
      if (metadata !== null) await purge([metadata]);
    },
    /** Account History deletion includes its documents and tasks, after fencing and enqueueing Sessions. */
    async removeOwner(accountId: string): Promise<void> {
      const sessions = await sessionMetadata.fenceOwner(accountId);
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

export function assertIdleContinuable(session: Parameters<typeof assertContinuable>[0] & { turn_running_since?: unknown }): void {
  if (session.turn_running_since !== undefined) return;
  try { assertContinuable(session); } catch (error) { throw sessionAccessError(error); }
}

export function sessionAccessError(error: unknown): unknown {
  if (error instanceof SessionConcurrencyError) return new HttpError(409, error.message, 'SESSION_CONCURRENCY_CONFLICT');
  if (error instanceof SessionBusyError) return new HttpError(409, 'The previous Turn is still going');
  if (error instanceof SessionClaimError) return new HttpError(409, 'Account Claim is in progress. Finish signing in and retry.');
  if (error instanceof SessionDeletedError) return new HttpError(410, 'The Session was deleted');
  if (error instanceof SessionUnissuedError) return new HttpError(404, 'Session not found');
  if (error instanceof SessionReadOnlyError) return new HttpError(409, 'This chat is read-only. Start a new chat to continue.', 'SESSION_READ_ONLY');
  return error;
}
