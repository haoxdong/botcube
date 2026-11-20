import { z } from 'zod';
import { secretArns } from './credential-fields.js';
import type { DeploymentConfig } from './schema.js';
import { endpoint, jsonFromEnv, modelsWire, type Endpoint, type ModelsWire } from './blocks.js';
import type { ModelsDeployment, ModelsEnv } from './seams.js';

/**
 * The environment the Chat Service and the Credential Service read the models Endpoint from: the deploy sets it from the
 * Deployment Config. Unset, they run on Bedrock.
 */
export const MODELS_ENV = {
  /** Set: every model but Plan Usage's runs on this OpenAI-compatible Endpoint, as JSON: its url, credential, headers and TLS, and `wire` when it is `responses`. */
  endpoint: 'BOTCUBE_MODELS_ENDPOINT',
  /** The model each finished Turn is summarized on. */
  turnSummaryModel: 'BOTCUBE_TURN_SUMMARY_MODEL',
} as const satisfies ModelsEnv;

/** How this `models` section is deployed; undefined on Bedrock, the default. */
export function modelsDeployment(models: DeploymentConfig['models']): ModelsDeployment | undefined {
  if (models.kind === 'bedrock') return undefined;
  const { url, credential, headers, tls, wire } = models;
  const responses = wire === 'responses' ? { wire } : {};
  const endpoint = { [MODELS_ENV.endpoint]: JSON.stringify({ url, credential, ...(headers ? { headers } : {}), ...(tls ? { tls } : {}), ...responses }) };
  return {
    chatService: { ...endpoint, [MODELS_ENV.turnSummaryModel]: models.turnSummaryModel },
    credentialService: endpoint,
    secretArns: secretArns(credential),
  };
}

/** The deployed Endpoint takes a stand-in over http, but not with TLS. */
const deployedEndpoint = endpoint.extend({ url: z.url({ protocol: /^https?$/ }), wire: modelsWire.default('chat-completions') })
  .refine(({ url, tls }) => tls === undefined || new URL(url).protocol === 'https:', { path: ['url'], message: 'an Endpoint with tls is an https URL' });

/** The models Endpoint and its wire, as the deploy set them. */
export type ModelsEndpoint = Endpoint & { readonly wire: ModelsWire };

/** The models Endpoint the deploy set, or undefined on Bedrock; throws naming the variable and the bad field. */
export function modelsEndpointFromEnv(env: NodeJS.ProcessEnv): ModelsEndpoint | undefined {
  return jsonFromEnv(env, MODELS_ENV.endpoint, deployedEndpoint);
}
