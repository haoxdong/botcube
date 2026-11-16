import { AccessPointAlreadyExists, AccessPointNotFound, CreateAccessPointCommand, DeleteAccessPointCommand, DescribeAccessPointsCommand, EFSClient, paginateDescribeAccessPoints } from '@aws-sdk/client-efs';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client, paginateListObjectsV2 } from '@aws-sdk/client-s3';
import { setTimeout as delay } from 'node:timers/promises';
import { poolHandlers } from './pool.mjs';
import { backgroundPool } from './jobs.mjs';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

const efs = new EFSClient({ maxAttempts: 4, retryMode: 'adaptive' });
const s3 = new S3Client({ maxAttempts: 8, retryMode: 'standard' });
const describe = async id => {
  await delay(200);
  const response = await efs.send(new DescribeAccessPointsCommand({ AccessPointId: id }));
  const point = response.AccessPoints?.[0];
  if (!point?.AccessPointArn) throw new Error('EFS returned no access point');
  return point;
};
const ports = {
  points: {
    async create(fileSystemId, directory, token) {
      await delay(200);
      try {
        const point = await efs.send(new CreateAccessPointCommand({
          FileSystemId: fileSystemId, ClientToken: token, PosixUser: { Uid: 1000, Gid: 1000 },
          RootDirectory: { Path: directory, CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '750' } },
        }));
        console.info(JSON.stringify({ event: 'files_pool_create', attempts: point.$metadata.attempts ?? 1, retryDelayMs: point.$metadata.totalRetryDelay ?? 0 }));
        if (!point.AccessPointArn) throw new Error('EFS returned no access point ARN');
        return point.AccessPointArn;
      } catch (error) {
        if (!(error instanceof AccessPointAlreadyExists) || !error.AccessPointId) throw error;
        return (await describe(error.AccessPointId)).AccessPointArn;
      }
    },
    async states(fileSystemId, arns) {
      if (arns.length === 0) return [];
      const statuses = new Map();
      for await (const page of paginateDescribeAccessPoints({ client: efs }, { FileSystemId: fileSystemId, MaxResults: 1000 })) {
        for (const point of page.AccessPoints ?? []) statuses.set(point.AccessPointArn, point.LifeCycleState);
      }
      return arns.map(arn => statuses.get(arn) ?? 'missing');
    },
    async owned(fileSystemId, poolId) {
      const slots = [];
      for await (const page of paginateDescribeAccessPoints({ client: efs }, { FileSystemId: fileSystemId })) {
        for (const point of page.AccessPoints ?? []) {
          if (point.ClientToken?.startsWith(`${poolId}-`) && point.AccessPointArn) slots.push({ arn: point.AccessPointArn });
        }
      }
      return slots;
    },
    async remove(arn) {
      await delay(200);
      try { await efs.send(new DeleteAccessPointCommand({ AccessPointId: arn.split('/').pop() })); }
      catch (error) { if (!(error instanceof AccessPointNotFound)) throw error; }
    },
  },
  manifests: {
    async read(bucket, key) {
      try {
        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!response.Body) throw new Error('Files pool manifest body is missing');
        return JSON.parse(await response.Body.transformToString());
      } catch (error) { if (error instanceof NoSuchKey) return null; throw error; }
    },
    async write(bucket, key, value) { await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(value), ContentType: 'application/json' })); },
    async remove(bucket, key) { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
    async clear(bucket) {
      for await (const page of paginateListObjectsV2({ client: s3 }, { Bucket: bucket })) {
        const objects = (page.Contents ?? []).flatMap(item => item.Key ? [{ Key: item.Key }] : []);
        if (objects.length > 0) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
      }
    },
  },
};
const queue = new SQSClient({ maxAttempts: 4 });
const background = backgroundPool({ handlers: poolHandlers(ports), manifests: ports.manifests, send: job => queue.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: JSON.stringify(job), MessageGroupId: job.event.PhysicalResourceId, MessageDeduplicationId: randomUUID() })) });
export const onEvent = background.onEvent;
export const isComplete = background.isComplete;
export async function worker(event) {
  for (const record of event.Records) {
    // eslint-disable-next-line no-await-in-loop -- FIFO keeps deployment and background transitions in one order
    await background.work(JSON.parse(record.body));
  }
}
