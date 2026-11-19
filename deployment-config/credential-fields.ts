import type { CredentialSource } from 'botcube-deployment-config/blocks';
import type { HarnessAuth } from './seams.js';

export type CredentialField = [path: (string | number)[], source: CredentialSource];

/** Whether the Harness trusts an outside issuer, whose bearer Chat reads from `token`. */
export const outsideIssuer = <Token>(auth: HarnessAuth<Token>): auth is Extract<HarnessAuth<Token>, { token: Token }> =>
  auth.kind === 'jwt-bearer' && auth.issuer !== 'botcube';

export const withClientSecret = ([path, source]: CredentialField): CredentialField[] =>
  source.kind === 'oauth-client-credentials' ? [[path, source], [[...path, 'clientSecret'], source.clientSecret]] : [[path, source]];

/** The Secrets Manager secrets these Credential Sources are read from, which their readers are granted. */
export const secretArns = (...sources: CredentialSource[]): string[] =>
  sources.flatMap((source) => withClientSecret([[], source])).flatMap(([, source]) => (source.kind === 'secret' ? [source.secretArn] : []));
