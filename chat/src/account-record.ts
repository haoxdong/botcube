import { createHash, randomBytes } from 'node:crypto';
import type { AgentModel } from './cartridge.js';

/** How a Cartridge names its accounts: `key` names its cookies and session records, `product` its messages. */
export interface AccountNaming {
  readonly key: string;
  readonly product: string;
}

/** An Account record; its shape is live production data. */
export interface Account {
  version: number;
  accountId: string;
  status: 'anonymous' | 'registered' | 'test';
  rateTier: string;
  deletionOperationId?: string;
  /** The profile: seeded from the first login-capable Sign-in, then the user's; its photo is an item of its own. */
  displayName?: string;
  lastActiveAt?: number;
  /** A scheduled run needed the user to sign in again; cleared when they do. */
  signInNeeded?: boolean;
  /** The OpenAI Sign-in's ChatGPT identity (its ID token's `sub`): the Account has Plan Usage (ADR 0078). */
  openaiIdentity?: string;
  /** The plan's models from its catalog's last fetch, which each model listing refreshes; cleared with each OpenAI Sign-in. */
  planModels?: AgentModel[];
  /** The OpenID Connect user the account signs in as, under the `oidc` identity adapter. */
  oidc?: OidcSubject;
  createdAt: number;
  updatedAt: number;
}

/** An ID token's issuer and subject: together, one user of one OpenID Connect provider. */
export interface OidcSubject {
  issuer: string;
  subject: string;
}

/** Freshly authorized deletion that survives removal of the account and its bearer tokens. */
export interface AccountDeletionIntent {
  accountId: string;
  operationId: string;
  authorizedAt: number;
  sessionBinding: string;
  status: 'authorized' | 'completed';
}

/** A token item's `record`: a session of kind `naming.key`, or a Cartridge's own kind of token. */
export type TokenRecord = { accountId: string; createdAt: number; expiresAt: number; kind: string } & Record<string, unknown>;

export type { Operation, PutOperation } from './guest-expiry.js';
export type Item = Record<string, unknown>;

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const token = (bytes: number) => randomBytes(bytes).toString('base64url');
export const itemKey = (pk: string, sk = 'META') => ({ pk, sk });
/** The key of the item linking an OIDC provider's subject to its account. */
export const oidcLinkKey = ({ issuer, subject }: OidcSubject) => `OIDC#${createHash('sha256').update(`${issuer}\n${subject}`, 'utf8').digest('hex')}`;

export const isAccountId = (value: string | null | undefined): value is string => {
  const id = (value ?? '').trim();
  return id.startsWith('acct_') && id.length >= 10 && id.length <= 128;
};

/** A token's binding to the session that started it. */
export const sessionBinding = (sessionToken: string) =>
  createHash('sha256').update(sessionToken, 'utf8').digest('hex');

/** Seed the profile's name from a Sign-in unless the account has one; answers whether it did. */
export function seedName(account: Account, displayName: string | undefined): boolean {
  if (account.displayName !== undefined || !displayName) return false;
  account.displayName = displayName;
  return true;
}
