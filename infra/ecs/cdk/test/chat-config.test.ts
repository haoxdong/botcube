import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { loadConfig } from '../../../../config/load.js';
import { resolveConfig, resolvedJson } from '../../../../config/resolved.js';
import { botcubeConfigPath, synthesizeExample } from './example-fixture.js';

interface Container { Name: string; Environment?: { Name: string; Value: unknown }[] }

test.each(['public', 'enterprise'])('the %s deploy publishes its resolved bytes before either task revision', async example => {
  const app = await synthesizeExample(example);
  const origin = app.node.findChild('PreviewOrigin') as Stack;
  const template = Template.fromStack(origin);
  const [[publishId, publish]] = Object.entries(template.findResources('Custom::CDKBucketDeployment'));
  const bucket = Object.values(template.findResources('AWS::S3::Bucket')).find(
    resource => resource.Properties.BucketName?.startsWith('botcube-config-'),
  );
  if (!bucket) throw new Error('The origin has no config bucket');
  expect(publish.Properties).toMatchObject({ Prune: false, RetainOnDelete: true, DestinationBucketKeyPrefix: 'resolved' });
  expect(bucket.DeletionPolicy).toBe('Retain');

  const json = resolvedJson(resolveConfig(loadConfig(botcubeConfigPath(example))));
  const key = createHash('sha256').update(json).digest('hex') + '.json';
  const locator = `s3://${bucket.Properties.BucketName}/resolved/${key}`;
  const tasks = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  for (const name of ['chat-service', 'credential-service']) {
    const task = tasks.find(({ Properties }) => Properties.ContainerDefinitions.some((container: Container) => container.Name === name));
    expect(task?.DependsOn).toContain(publishId);
    const container = task?.Properties.ContainerDefinitions.find((candidate: Container) => candidate.Name === name);
    expect(container.Environment).toContainEqual({ Name: 'BOTCUBE_CONFIG', Value: locator });
  }
  const staged = readdirSync(app.outdir, { recursive: true, encoding: 'utf8' }).find(file => path.basename(file) === key);
  expect(staged && readFileSync(path.join(app.outdir, staged), 'utf8')).toBe(json);
}, 180_000);
