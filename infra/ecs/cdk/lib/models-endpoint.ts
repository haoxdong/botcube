import type { TaskDefinition } from 'aws-cdk-lib/aws-ecs';
import type { ModelsDeployment } from '../../../../config/seams.js' with { 'resolution-mode': 'import' };
import { grantSecretReads } from './secret-reads.js';

/** Grant the secrets the models Endpoint's credential is read from; the service reads the Endpoint from its BotCube Config. */
export function grantModelsEndpoint(service: { task: TaskDefinition }, models: ModelsDeployment | undefined): boolean {
  if (!models) return false;
  grantSecretReads(service.task, service.task, models.secretIds);
  return true;
}
