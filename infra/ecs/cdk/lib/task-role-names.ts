import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';

export function nameTaskRoles(task: ecs.FargateTaskDefinition, taskRoleName: string | undefined, executionRoleName: string | undefined, importedExecutionRole: iam.IRole | undefined): void {
  if (importedExecutionRole && executionRoleName !== undefined) throw new Error('An imported executionRole owns its name; omit executionRoleName');
  if (taskRoleName !== undefined) (task.taskRole.node.defaultChild as iam.CfnRole).roleName = taskRoleName;
  if (executionRoleName !== undefined) (task.obtainExecutionRole().node.defaultChild as iam.CfnRole).roleName = executionRoleName;
}
