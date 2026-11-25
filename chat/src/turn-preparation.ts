import type { TurnFailure } from './session-metadata.js';
import { sessionAccessError } from './sessions.js';
import { persistedTurnError, turnErrorDetails } from './turn-stream.js';
import type { AgentDocumentSet } from './agent-documents.js';
import { HttpError } from './http-error.js';
import type { RunAgentInput } from '@ag-ui/client';
import type { AgentModel, ModelSource } from './models.js';
import type { Requester, RequesterSource } from './requester.js';

/** What a Turn, chat or scheduled, needs from the bot: its documents, models, Memory gates and upstream payload. */
export interface TurnSource<R extends Requester = Requester> extends ModelSource<R> {
  /** The Agent Identity and Soul templates every account's agent starts from. */
  readonly agentDocuments: AgentDocumentSet;
  /**
   * The bot settings' Extracted Memory gate (`extractedMemory.enabled`): false keeps no Extracted Memory for anyone.
   * Its routes refuse, and each Turn tells the Harness (`forwardedProps.botMemory`), which then gives no `memory` tool. On unless false.
   */
  readonly extractedMemory?: boolean;
  readonly writtenMemory?: boolean;
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

/** A Turn prepared for upstream transport. The invocation token is sent in a header. */
export type InvocationPayload = Record<string, unknown> & {
  credentialServiceInvocationToken?: string | undefined;
  forwardedProps: Record<string, unknown>;
};

/** Tells a Turn's Harness its Memory gates: the bot settings', and no Written Memory for a Guest. Only the Chat Service sets them, never a client. */
export function memoryGates(
  forwardedProps: Record<string, unknown>,
  settings: { extractedMemory?: boolean | undefined; writtenMemory?: boolean | undefined },
  requester: Requester,
): void {
  if (settings.extractedMemory === false) forwardedProps.botMemory = false;
  else delete forwardedProps.botMemory;
  if (settings.writtenMemory === false || requester.anonymous === true) forwardedProps.writtenMemory = false;
  else delete forwardedProps.writtenMemory;
}

export function preparationFailure(error: unknown, credentials: readonly string[]): TurnFailure {
  const mapped = sessionAccessError(error);
  const message = mapped instanceof Error ? mapped.message : String(mapped);
  return { code: mapped instanceof HttpError && mapped.code === 'SESSION_BUSY' ? mapped.code : 'TURN_PREPARATION_FAILED', message: persistedTurnError(turnErrorDetails(message, credentials)) };
}
