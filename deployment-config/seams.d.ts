// A declaration file: the CDK packages' rootDir admits declaration files from outside it, but no source.

export type HarnessAuth = { kind: 'sigv4' } | { kind: 'jwt-bearer'; issuer: 'botcube'; clients: [HarnessClient, ...HarnessClient[]] };
/** A Harness bearer's audience, which the Runtime's JWT authorizer allows. */
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
