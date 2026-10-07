import type { RunAgentInput } from '@ag-ui/client';
import type { Context, Hono } from 'hono';

/** The name, character, vibe, and avatar (an emoji, or empty for the name's initial) a user gives their agent. */
export interface AgentIdentity {
  name: string;
  character: string;
  vibe: string;
  avatar: string;
}

/** An account's Agent Identity and Soul; a Cartridge's are the templates every account starts from. */
export interface AgentDocumentSet {
  agentIdentity: AgentIdentity;
  soul: string;
}

/** A model an account may run its Turns on; a Turn names it by `key` in `forwardedProps.model`. */
export interface AgentModel {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** Whose model it is: a Session's Turns all run on its first Turn's provider, so its history never mixes two. */
  readonly provider: string;
}

/** The account that sent a request, as the Cartridge resolved it from the request. */
export interface Requester {
  /** The account that owns the requester's Sessions: the one its Turns are filed under. */
  readonly owner: string;
}

/** The JSON body an upstream Harness receives for one Turn. */
export type InvocationPayload = Record<string, unknown> & {
  forwardedProps: Record<string, unknown>;
};

/**
 * What the Chat Service does to an account's Sessions when the Cartridge's
 * account flows change the account; handed to the Cartridge when it is built.
 */
export interface AccountHistory {
  /** Account deletion: fence every Session the account answers for, then purge them in the background. */
  delete(accountId: string): Promise<void>;
  /** Account Claim: the destination account owns the source account's Sessions from now on. */
  transfer(sourceAccountId: string, destinationAccountId: string): Promise<void>;
  /** Whether the account owns this Session: one it has started and that is not being purged. */
  owns(accountId: string, sessionId: string): Promise<boolean>;
  /** Whether this is the account's assigned Main Chat, even before its first Turn; allocation-free and false when the Session or account is fenced. */
  ownsMainChat(accountId: string, sessionId: string): Promise<boolean>;
}

/**
 * The Chat Service half of a Cartridge: the product's extension points into the
 * Chat Service (ADR 0068 §3), bound at build time by the product's entry point.
 */
export interface ChatServiceCartridge<R extends Requester = Requester> {
  /** The origins allowed by default; BOTCUBE_CORS_ORIGINS overrides them. */
  readonly corsOrigins: readonly string[];
  /** The Agent Identity and Soul templates every account's agent starts from. */
  readonly agentDocuments: AgentDocumentSet;
  /**
   * The Cartridge's own models, which every account may run its Turns on; the first is the default
   * the UI starts from and the Harness runs a Turn naming none on.
   */
  readonly models: readonly [AgentModel, ...AgentModel[]];
  /**
   * The models this account may also run beyond the Cartridge's own, such as its plan's. Only
   * listing the models or a Turn naming a model not among `models` asks for them, so a Turn on a
   * Cartridge model never depends on them. A Turn naming a model in neither is refused.
   */
  accountModels(requester: R): Promise<readonly AgentModel[]>;
  /** The CUSTOM event name that carries browser live-view open/close events. */
  readonly browserEventName: string;
  /** The Cartridge's own routes (auth and account), mounted at the root. */
  readonly routes: Hono;
  /**
   * Resolve the request's account; throws an HttpError when the request has none
   * the Chat Service may act for. Only the Chat Service resolves identity (ADR 0068 §4).
   */
  requester(c: Context): Promise<R>;
  /** The user ID an account's Sessions are filed under in the Session record. */
  filingUserId(owner: string): string;
  /**
   * The upstream payload for one Turn. It must forward the requester's account ID
   * and any credential binding; the Chat Service adds `forwardedProps.sessionUserId`.
   */
  invocationPayload(input: RunAgentInput, requester: R, model: AgentModel): Promise<InvocationPayload>;
  /** A chat's Turn passed its Session's checks and starts now; whatever this begins must not hold the Turn. */
  turnStarting?(requester: R, threadId: string): void;
  browserLiveView?(requester: R, threadId: string): Promise<{ open: true; sessionId: string } | null>;
  /**
   * The forwarded props in which `invocationPayload` hands the Harness a credential,
   * which the Chat Service never relays to the client.
   */
  readonly credentialProps: readonly string[];
  /** The requester a scheduled run of the owner's acts as, with no request to resolve it from. */
  scheduledRequester(owner: string): Promise<R>;
  /**
   * The sign-in a scheduled run's outputs (its tool results and answers) say
   * the agent needed, recorded on the owner's account so the user is asked for
   * it; null when the run needed none.
   */
  signInNeeded(owner: string, outputs: string[]): Promise<string | null>;
  /**
   * Throw an HttpError unless the request may watch or take over this browser Session;
   * answers the AgentCore browser it runs in when that is not AGENTCORE_BROWSER_ID.
   */
  authorizeBrowserLiveView(sessionId: string, c: Context): Promise<string | void>;
  /** Ready the Cartridge's own side of a chat the requester opened, alongside its agent's warmup, such as its browser. */
  warmSession(requester: R, sessionId: string): Promise<void>;
}

/** Builds a Cartridge once the Chat Service can offer it the account-history hooks. */
export type CartridgeFactory<R extends Requester = Requester> = (history: AccountHistory) => ChatServiceCartridge<R>;

/** A client-facing failure, answered as `{"detail": ...}`, the shape the UI reads. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
  }
}
