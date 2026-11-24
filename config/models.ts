import { secretIds } from './credential-fields.js';
import type { BotCubeConfig } from './schema.js';
import type { ModelsDeployment } from './seams.js';

/** How this `models` section is deployed; undefined on Bedrock, the default. */
export function modelGatewayResources(models: BotCubeConfig['integrations']['modelGateway']): ModelsDeployment | undefined {
  if (models.kind === 'bedrock') return undefined;
  const credentials = [models.credential, ...Object.values(models.providers ?? {}).flatMap(({ credential }) => credential ? [credential] : [])];
  return { secretIds: secretIds(...credentials) };
}
