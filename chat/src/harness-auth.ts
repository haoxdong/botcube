import { outsideIssuer } from 'botcube-config/credential-fields';
import type { CredentialSource } from 'botcube-config/blocks';
import type { HarnessAuth } from 'botcube-config/seams';
import { credentialSource } from './credential-source.js';
import type { TurnIdentity } from './turn-identity.js';

export type ChatHarnessAuth = HarnessAuth<CredentialSource>;

/** Signs the bearer token for one call to the Harness. */
export type HarnessBearer = () => Promise<string>;

/**
 * The bearer for each Harness call, or none under SigV4: under `botcube`, a `botcube` Credential Source for the Trust's
 * first client, which fails startup with no Turn identity keys to sign it; under an outside issuer, its `token`.
 */
export function harnessBearer(auth: ChatHarnessAuth, identity: TurnIdentity | null): HarnessBearer | undefined {
  if (auth.kind === 'sigv4') return undefined;
  if (outsideIssuer(auth)) return bearerFrom(credentialSource('harnessAuth', auth.token));
  if (identity === null) {
    throw new Error('harnessAuth.kind: jwt-bearer signs with the Turn identity keys; set BOTCUBE_TURN_IDENTITY_KEYS and BOTCUBE_PUBLIC_ORIGIN');
  }
  return bearerFrom(credentialSource('harnessAuth', { kind: 'botcube', audience: auth.clients[0].clientId }, { botcube: identity }));
}

const bearerFrom = (source: ReturnType<typeof credentialSource>): HarnessBearer => async () => (await source.get()).value;
