import { z } from 'zod';
import { secretArns } from './credential-fields.js';
import type { DeploymentConfig } from './schema.js';
import { endpoint, jsonFromEnv, type Endpoint } from './blocks.js';
import type { ModelsDeployment, ModelsEnv } from './seams.js';

/**
 * The environment the services read the `models` section from: the deploy sets it from the Deployment Config, and no
 * process reads the file. Unset, they all run on Bedrock.
 */
export const MODELS_ENV = {
  /** Set: every model but Plan Usage's runs on this OpenAI-compatible Endpoint, as JSON: its url, credential, headers and TLS. */
  endpoint: 'BOTCUBE_MODELS_ENDPOINT',
  /** The model each finished Turn is summarized on. */
  turnSummaryModel: 'BOTCUBE_TURN_SUMMARY_MODEL',
  /** The Harness's only part of the section: where its models run. The Credential Service relays their calls. */
  kind: 'BOTCUBE_MODELS_KIND',
  /** Set to `claude`: the Harness marks Claude cache breakpoints on its Endpoint requests. */
  cacheMarkers: 'BOTCUBE_MODELS_CACHE_MARKERS',
} as const satisfies ModelsEnv;

/** How this `models` section is deployed; undefined on Bedrock, the default. */
export function modelsDeployment(models: DeploymentConfig['models']): ModelsDeployment | undefined {
  if (models.kind === 'bedrock') return undefined;
  const { url, credential, headers, tls, cacheMarkers: markers } = models;
  const endpoint = { [MODELS_ENV.endpoint]: JSON.stringify({ url, credential, ...(headers ? { headers } : {}), ...(tls ? { tls } : {}) }) };
  return {
    chatService: { ...endpoint, [MODELS_ENV.turnSummaryModel]: models.turnSummaryModel },
    credentialService: endpoint,
    harness: { [MODELS_ENV.kind]: models.kind, ...(markers ? { [MODELS_ENV.cacheMarkers]: markers } : {}) },
    secretArns: secretArns(credential),
  };
}

/** The deployed Endpoint takes a stand-in on this machine over http, but not with TLS; the Deployment Config itself takes only https. */
const deployedEndpoint = endpoint.extend({ url: z.url({ protocol: /^https?$/ }) })
  .refine(({ url, tls }) => tls === undefined || new URL(url).protocol === 'https:', { path: ['url'], message: 'an Endpoint with tls is an https URL' });

/** The models Endpoint the deploy set, or undefined on Bedrock; throws naming the variable and the bad field. */
export function modelsEndpointFromEnv(env: NodeJS.ProcessEnv): Endpoint | undefined {
  return jsonFromEnv(env, MODELS_ENV.endpoint, deployedEndpoint);
}
