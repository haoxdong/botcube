import type { Context } from 'hono';

/** The account that sent a request, as the Chat Service resolved it from the request. */
export interface Requester {
  /** The Account tier the Chat Service resolved, never existing by the client. */
  readonly rateTier?: string;
  /** The account that owns the requester's Sessions: the one its Turns are filed under. */
  readonly owner: string;
  readonly anonymous?: boolean;
}

/** Resolves the account a request acts for. */
export interface RequesterSource<R extends Requester = Requester> {
  /**
   * Resolve the request's account; throws an HttpError when the request has none
   * the Chat Service may act for. Only the Chat Service resolves identity (ADR 0068 §4).
   */
  requester(c: Context): Promise<R>;
}
