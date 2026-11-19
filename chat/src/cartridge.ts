import type { Context, Hono } from 'hono';
import type { AccountHistory } from './account-history.js';
import type { CredentialSource } from './credential-source.js';
import type { Requester } from './requester.js';
import type { TaskStopSleep } from './task-stop.js';
import type { TurnRouteSource } from './turn-preparation.js';
import type { ScheduledRunSource } from './scheduled-runs.js';

/**
 * The Chat Service half of a Cartridge: the product's extension points into the
 * Chat Service (ADR 0068 §3), bound at build time by the product's entry point.
 */
export interface ChatServiceCartridge<R extends Requester = Requester> extends TurnRouteSource<R>, ScheduledRunSource<R> {
  /** The origins allowed when BOTCUBE_CORS_ORIGINS is unset; the local UI's (LOCAL_UI_ORIGINS) unless given. */
  readonly corsOrigins?: readonly string[];
  /** The Cartridge's own routes (auth and account), mounted at the root. */
  readonly routes: Hono;
  /**
   * Throw an HttpError unless the request may watch or take over this browser Session;
   * answers the AgentCore browser it runs in when that is not AGENTCORE_BROWSER_ID.
   */
  authorizeBrowserLiveView(sessionId: string, c: Context): Promise<string | void>;
  /** Discover durable authorized account deletions and enqueue their recovery without waiting for Session settlement. */
  recoverAccountDeletions?(): Promise<void>;
  /** The task is stopping: put every awake Agent Computer to sleep before it exits. */
  sleepAgentComputers?(): TaskStopSleep;
  /** The Cartridge's Credential Sources, such as sign-in's client secret: each is read as the Chat Service starts, which an unreadable one stops. */
  readonly startupCredentials?: readonly CredentialSource[];
}

/** Builds a Cartridge once the Chat Service can offer it the account-history hooks. */
export type CartridgeFactory<R extends Requester = Requester> = (history: AccountHistory) => ChatServiceCartridge<R>;
