import { setTimeout as delay } from 'node:timers/promises';
import { SessionBusyError, type PreparedTurn, type TurnFailure } from './session-metadata.js';
import { sessionAccessError } from './sessions.js';
import { persistedTurnError, turnErrorDetails } from './turn-stream.js';
import { HttpError, type AgentDocumentSet } from './cartridge.js';

export async function turnAccessError(error: unknown, documents: Promise<PromiseSettledResult<AgentDocumentSet>[]>, templates: AgentDocumentSet): Promise<unknown> {
  if (!(error instanceof SessionBusyError)) return sessionAccessError(error);
  const [loaded] = await documents;
  return sessionAccessError(error, loaded?.status === 'fulfilled' ? loaded.value.agentIdentity.name : templates.agentIdentity.name);
}

export function preparationFailure(error: unknown, credentials: readonly string[]): TurnFailure {
  const mapped = sessionAccessError(error);
  const message = mapped instanceof Error ? mapped.message : String(mapped);
  return { code: mapped instanceof HttpError && mapped.code === 'SESSION_BUSY' ? mapped.code : 'TURN_PREPARATION_FAILED', message: persistedTurnError(turnErrorDetails(message, credentials)) };
}

interface WriterWait {
  sessionId: string;
  runId: string;
  signal: AbortSignal;
  deadline: number;
}

async function pauseForWriter(error: SessionBusyError, wait: WriterWait): Promise<void> {
  if (wait.signal.aborted) throw error;
  if (Date.now() >= wait.deadline) {
    console.error('Scheduled task post blocked a Turn past its deadline', {
      session_id: wait.sessionId, run_id: wait.runId, holder_token: error.holder?.token, created_at: error.holder?.createdAt,
    });
    throw error;
  }
  try {
    await delay(Math.min(1000, wait.deadline - Date.now()), undefined, { signal: wait.signal });
  } catch {
    throw error;
  }
}

export async function dispatchAfterWriter(prepared: PreparedTurn, sessionId: string, runId: string, signal: AbortSignal) {
  const wait = { sessionId, runId, signal, deadline: Date.now() + 60_000 };
  let waiting = false;
  for (;;) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each attempt must recheck the durable writer and deletion fences
      return await prepared.dispatch();
    } catch (error) {
      if (!(error instanceof SessionBusyError)) throw error;
      if (!waiting) {
        console.warn(`Turn is waiting for Session persistence writer session_id=${sessionId} run_id=${runId}`, error);
        waiting = true;
      }
      // eslint-disable-next-line no-await-in-loop -- wait before attempting the same prepared Turn again
      await pauseForWriter(error, wait);
    }
  }
}
