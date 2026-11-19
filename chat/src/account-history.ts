/**
 * What the Chat Service does to an account's Sessions when its account flows
 * change the account.
 */
export interface AccountHistory {
  /** Fence every owned Session and wait for proven Runtime settlement and purge before downstream account erasure. */
  delete(accountId: string): Promise<void>;
  /** Account Claim: the destination account owns the source account's Sessions from now on. */
  transfer(sourceAccountId: string, destinationAccountId: string): Promise<void>;
  /** Whether the account owns this Session: one it has started and that is not being purged. */
  owns(accountId: string, sessionId: string): Promise<boolean>;
  /** Whether this is the account's assigned Main Chat, even before its first Turn; allocation-free and false when the Session or account is fenced. */
  ownsMainChat(accountId: string, sessionId: string): Promise<boolean>;
}
