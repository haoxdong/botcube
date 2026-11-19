import type { HarnessAuth } from 'botcube-deployment-config/seams';
import { credentialSource } from './credential-source.js';
import type { TurnIdentity } from './turn-identity.js';

/** Signs the bearer token for one call to the Harness. */
export type HarnessBearer = () => Promise<string>;

/**
 * The bearer for each Harness call, or none under SigV4: a `botcube` Credential Source for the Trust's first client;
 * a bearer with no Turn identity keys to sign it fails startup.
 */
export function harnessBearer(auth: HarnessAuth, identity: TurnIdentity | null): HarnessBearer | undefined {
  if (auth.kind === 'sigv4') return undefined;
  if (identity === null) {
    throw new Error('harnessAuth.kind: jwt-bearer signs with the Turn identity keys; set BOTCUBE_TURN_IDENTITY_KEYS and BOTCUBE_PUBLIC_ORIGIN');
  }
  const source = credentialSource('harnessAuth', { kind: 'botcube', audience: auth.clients[0].clientId }, { botcube: identity });
  return async () => (await source.get()).value;
}
