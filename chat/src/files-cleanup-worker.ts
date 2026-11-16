import { randomUUID } from 'node:crypto';
import { DescribeTasksCommand, ECSClient, type DescribeTasksCommandOutput } from '@aws-sdk/client-ecs';
import { z } from 'zod';

export const filesCleanupClaim = z.object({ token: z.string(), cluster: z.string(), taskArn: z.string(), createdAt: z.number() });
export type FilesCleanupClaim = z.infer<typeof filesCleanupClaim>;
export interface CleanupWorker {
  identity(): Promise<{ cluster: string; taskArn: string }>;
  stopped(claim: FilesCleanupClaim): Promise<boolean>;
}
const localId = randomUUID();
export const localCleanupWorker: CleanupWorker = { identity: async () => ({ cluster: 'local', taskArn: localId }), stopped: async () => false };

export function ecsCleanupWorker(metadataUri: string | undefined, describe: (cluster: string, taskArn: string) => Promise<Pick<DescribeTasksCommandOutput, 'tasks' | 'failures'>> = (cluster, taskArn) => new ECSClient({}).send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }), { abortSignal: AbortSignal.timeout(5000) })): CleanupWorker {
  let identity: Promise<{ cluster: string; taskArn: string }> | undefined;
  return {
    identity() {
      return identity ??= (async () => {
        if (!metadataUri) throw new Error('Pool cleanup requires ECS task metadata');
        const response = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`ECS task metadata returned ${response.status}`);
        const data = z.object({ Cluster: z.string(), TaskARN: z.string() }).parse(await response.json());
        return { cluster: data.Cluster, taskArn: data.TaskARN };
      })().catch((error: unknown) => { identity = undefined; throw error; });
    },
    async stopped(claim) {
      const result = await describe(claim.cluster, claim.taskArn);
      if (result.tasks?.some(task => task.taskArn === claim.taskArn && task.lastStatus === 'STOPPED')) return true;
      return Date.now() - claim.createdAt > 2 * 60 * 60 * 1000 && (result.failures?.some(failure => failure.arn === claim.taskArn && failure.reason === 'MISSING') ?? false);
    },
  };
}
