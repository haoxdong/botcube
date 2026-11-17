import type { TurnIdentity } from './turn-identity.js';

/**
 * How the Chat Service authenticates to the Harness: the Deployment Config's `harnessAuth` section (ADR 0091). SigV4
 * signs each Runtime call with the task role; a JWT bearer is a token the Chat Service signs with its Turn identity
 * keys, as the issuer at its public origin, which the Runtime's inbound JWT authorizer checks.
 */
export type HarnessAuth = { kind: 'sigv4' } | { kind: 'jwt-bearer'; audience: string };

/** Signs the bearer token for one call to the Harness. */
export type HarnessBearer = () => Promise<string>;

/** The bearer for each Harness call, or none under SigV4; a bearer with no Turn identity keys to sign it fails startup. */
export function harnessBearer(auth: HarnessAuth, identity: TurnIdentity | null): HarnessBearer | undefined {
  if (auth.kind === 'sigv4') return undefined;
  if (identity === null) {
    throw new Error('harnessAuth.kind: jwt-bearer signs with the Turn identity keys; set BOTCUBE_TURN_IDENTITY_KEYS and BOTCUBE_PUBLIC_ORIGIN');
  }
  return () => identity.signServiceToken(auth.audience);
}
