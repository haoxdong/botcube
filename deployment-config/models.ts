import type { DeploymentConfig } from './schema.js';

/**
 * The environment the Chat Service and the Harness read the `models` section from: the deploy sets it from the
 * Deployment Config, and neither process reads the file. Unset, both run on Bedrock.
 */
export const MODELS_ENV = {
  /** Set: every model but Plan Usage's runs on this OpenAI-compatible endpoint. */
  baseUrl: 'BOTCUBE_MODELS_BASE_URL',
  /** The Secrets Manager secret holding the endpoint's API key, which each process reads at startup. */
  apiKeySecretArn: 'BOTCUBE_MODELS_API_KEY_SECRET_ARN',
  /** The model each finished Turn is summarized on. */
  turnSummaryModel: 'BOTCUBE_TURN_SUMMARY_MODEL',
} as const;

/** What the deploy gives the Chat Service and the Harness for a `models` section off Bedrock: the CDK's `models` option. */
export interface ModelsDeployment {
  readonly environment: Readonly<Record<string, string>>;
  /** The secret both processes are granted to read. */
  readonly apiKeySecretArn: string;
}

/** How this `models` section is deployed; undefined on Bedrock, the default. */
export function modelsDeployment(models: DeploymentConfig['models']): ModelsDeployment | undefined {
  if (models.kind === 'bedrock') return undefined;
  return {
    environment: {
      [MODELS_ENV.baseUrl]: models.baseUrl,
      [MODELS_ENV.apiKeySecretArn]: models.apiKey.secretArn,
      [MODELS_ENV.turnSummaryModel]: models.turnSummaryModel,
    },
    apiKeySecretArn: models.apiKey.secretArn,
  };
}
