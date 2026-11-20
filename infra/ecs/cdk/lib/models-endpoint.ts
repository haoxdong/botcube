import type { ContainerDefinition, TaskDefinition } from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { ModelsDeployment } from '../../../../deployment-config/seams.js' with { 'resolution-mode': 'import' };

export function addModelsEndpoint(
  service: { container: ContainerDefinition; task: TaskDefinition }, models: ModelsDeployment | undefined, reader: 'chatService' | 'credentialService',
): boolean {
  if (!models) return false;
  for (const [name, value] of Object.entries(models[reader])) service.container.addEnvironment(name, value);
  if (models.secretArns.length) service.task.addToTaskRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [...models.secretArns] }));
  return true;
}
