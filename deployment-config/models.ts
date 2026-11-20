import { secretArns } from './credential-fields.js';
import type { DeploymentConfig } from './schema.js';
import type { ModelsDeployment } from './seams.js';

/** How this `models` section is deployed; undefined on Bedrock, the default. */
export function modelsDeployment(models: DeploymentConfig['models']): ModelsDeployment | undefined {
  if (models.kind === 'bedrock') return undefined;
  return { secretArns: secretArns(models.credential) };
}
