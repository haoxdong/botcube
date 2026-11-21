import type { TaskDefinition } from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { ModelsDeployment } from '../../../../config/seams.js' with { 'resolution-mode': 'import' };

/** Grant the secrets the models Endpoint's credential is read from; the service reads the Endpoint from its BotCube Config. */
export function grantModelsEndpoint(service: { task: TaskDefinition }, models: ModelsDeployment | undefined): boolean {
  if (!models) return false;
  if (models.secretArns.length) service.task.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [...models.secretArns] }));
  return true;
}
