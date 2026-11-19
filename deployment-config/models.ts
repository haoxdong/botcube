import { z } from 'zod';
import { secretArns } from './credential-fields.js';
import type { DeploymentConfig } from './schema.js';
import { cacheMarkers, endpoint, jsonFromEnv } from './blocks.js';
import type { ModelsDeployment, ModelsEnv } from './seams.js';

/**
 * The environment the Chat Service and the Harness read the `models` section from: the deploy sets it from the
 * Deployment Config, and neither process reads the file. Unset, both run on Bedrock.
 */
export const MODELS_ENV = {
  /** Set: every model but Plan Usage's runs on this OpenAI-compatible Endpoint, as JSON: its url, credential, headers and cache markers. */
  endpoint: 'BOTCUBE_MODELS_ENDPOINT',
  /** The model each finished Turn is summarized on. */
  turnSummaryModel: 'BOTCUBE_TURN_SUMMARY_MODEL',
} as const satisfies ModelsEnv;

/** How this `models` section is deployed; undefined on Bedrock, the default. */
export function modelsDeployment(models: DeploymentConfig['models']): ModelsDeployment | undefined {
  if (models.kind === 'bedrock') return undefined;
  const { url, credential, headers, cacheMarkers: markers } = models;
  return {
    environment: {
      [MODELS_ENV.endpoint]: JSON.stringify({ url, credential, ...(headers ? { headers } : {}), ...(markers ? { cacheMarkers: markers } : {}) }),
      [MODELS_ENV.turnSummaryModel]: models.turnSummaryModel,
    },
    secretArns: secretArns(credential),
  };
}

/** The deployed Endpoint takes a stand-in on this machine over http; the Deployment Config itself takes only https. */
const deployedEndpoint = endpoint.extend({ url: z.url({ protocol: /^https?$/ }), cacheMarkers: cacheMarkers.optional() });

/** The models Endpoint the deploy set, or undefined on Bedrock; throws naming the variable and the bad field. */
export function modelsEndpointFromEnv(env: NodeJS.ProcessEnv) {
  return jsonFromEnv(env, MODELS_ENV.endpoint, deployedEndpoint);
}
