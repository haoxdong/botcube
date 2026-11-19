// A declaration file: the CDK packages' rootDir admits declaration files from outside it, but no source.

/**
 * How Chat authenticates to the Harness. `Token` is the Credential Source Chat reads an outside issuer's bearer from,
 * which the CDK passes through unread.
 */
export type HarnessAuth<Token = unknown> =
  | { kind: 'sigv4' }
  | { kind: 'jwt-bearer'; issuer: 'botcube'; clients: [HarnessClient, ...HarnessClient[]] }
  | { kind: 'jwt-bearer'; issuer: DiscoveryUrl; clients: [HarnessClient, ...HarnessClient[]]; token: Token };
/** An OIDC issuer's discovery URL, as AgentCore's JWT authorizer takes it. */
export type DiscoveryUrl = `https://${string}/.well-known/openid-configuration`;
/** A client the Runtime's JWT authorizer allows: a Harness bearer's `aud` under `botcube`, its `client_id` under an outside issuer. */
export interface HarnessClient {
  clientId: string;
}

export interface ModelsDeployment {
  readonly environment: Readonly<Record<string, string>>;
  /** The Secrets Manager secrets its credential is read from, which each process reading it is granted. */
  readonly secretArns: readonly string[];
}

export interface RuntimeTelemetry {
  readonly kind: 'xray' | 'otlp' | 'none';
  /** The Secrets Manager secrets its credential is read from, which the Runtime is granted. */
  readonly secretArns: readonly string[];
}

export interface ModelsEnv {
  readonly endpoint: 'BOTCUBE_MODELS_ENDPOINT';
  readonly turnSummaryModel: 'BOTCUBE_TURN_SUMMARY_MODEL';
}

export interface TokenAudiences {
  readonly turnIdentity: 'sts.amazonaws.com';
  readonly user: 'botcube-user';
}
