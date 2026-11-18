// A declaration file: the CDK packages' rootDir admits declaration files from outside it, but no source.

export type HarnessAuth = { kind: 'sigv4' } | { kind: 'jwt-bearer'; audience: string };

export interface ModelsDeployment {
  readonly environment: Readonly<Record<string, string>>;
  readonly apiKeySecretArn: string;
}

export interface ModelsEnv {
  readonly baseUrl: 'BOTCUBE_MODELS_BASE_URL';
  readonly apiKeySecretArn: 'BOTCUBE_MODELS_API_KEY_SECRET_ARN';
  readonly turnSummaryModel: 'BOTCUBE_TURN_SUMMARY_MODEL';
}

export interface TokenAudiences {
  readonly turnIdentity: 'sts.amazonaws.com';
  readonly user: 'botcube-user';
}
