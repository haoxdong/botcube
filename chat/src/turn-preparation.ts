import { setTimeout as delay } from 'node:timers/promises';
import { SessionBusyError, type PreparedTurn, type TurnFailure } from './session-metadata.js';
import { sessionAccessError } from './sessions.js';
import { persistedTurnError, turnErrorDetails } from './turn-stream.js';
import type { AgentDocumentSet } from './agent-documents.js';
import { HttpError } from './http-error.js';
import type { RunAgentInput } from '@ag-ui/client';
import type { AgentModel, ModelSource } from './models.js';
import type { Requester, RequesterSource } from './requester.js';

/** What a Turn, chat or scheduled, needs from the bot: its documents, models, Memory gate and upstream payload. */
export interface TurnSource<R extends Requester = Requester> extends ModelSource<R> {
  /** The Agent Identity and Soul templates every account's agent starts from. */
  readonly agentDocuments: AgentDocumentSet;
  /**
   * The bot settings' Memory gate (`memory`): false keeps no Memory for anyone. Its routes refuse,
   * and each Turn tells the Harness (`forwardedProps.botMemory`). On unless false.
   */
  readonly memory?: boolean;
  /** The user ID an account's Sessions are filed under in the Session record. */
  filingUserId(owner: string): string;
  /**
   * The upstream payload for one Turn. It must forward the requester's account ID
   * and any credential binding; the Chat Service adds `forwardedProps.sessionUserId`.
   */
  invocationPayload(input: RunAgentInput, requester: R, model: AgentModel): Promise<InvocationPayload>;
  /** A chat's Turn passed its Session's checks and starts now; whatever this begins must not hold the Turn. */
  turnStarting?(requester: R, threadId: string): void;
  /**
   * The forwarded props in which `invocationPayload` hands the Harness a credential,
   * which the Chat Service never relays to the client.
   */
  readonly credentialProps: readonly string[];
}

/** What the chat Turn routes need from the bot beyond a Turn's own: the requester and its browser. */
export interface TurnRouteSource<R extends Requester = Requester> extends TurnSource<R>, RequesterSource<R> {
  browserLiveView?(requester: R, threadId: string): Promise<{ open: true; sessionId: string } | null>;
  /**
   * The forwarded props in which `invocationPayload` tells the Harness who the requester is.
   * The Chat Service strips any a client sent, with the credential props and BotCube's own.
   */
  readonly identityProps?: readonly string[];
  /** Whether the requester may run a Turn on a candidate `agentSystemPrompt` or `botSystemPrompt`; none may without it. */
  tunesPrompts?(requester: R): boolean;
  /** Ready the bot's own side of a chat the requester opened, alongside its agent's warmup, such as its browser. */
  warmSession(requester: R, sessionId: string): Promise<void>;
}

/** The JSON body an upstream Harness receives for one Turn. */
export type InvocationPayload = Record<string, unknown> & {
  forwardedProps: Record<string, unknown>;
};

/** Tells a Turn's Harness the bot settings' Memory gate; only the Chat Service sets it, never a client. */
export function botMemory(forwardedProps: Record<string, unknown>, settings: { memory?: boolean | undefined }): void {
  if (settings.memory === false) forwardedProps.botMemory = false;
  else delete forwardedProps.botMemory;
}

export async function turnAccessError(error: unknown, documents: Promise<PromiseSettledResult<AgentDocumentSet>[]>, templates: AgentDocumentSet): Promise<unknown> {
  if (!(error instanceof SessionBusyError)) return error;
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
