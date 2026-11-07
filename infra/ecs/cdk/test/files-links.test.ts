import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { ChatStorageStack } from '../lib/chat-storage-stack.js';
import { addFilesLinks } from '../lib/files-links.js';
import { PreviewChatService } from '../lib/preview-chat-service.js';
import { PreviewOriginStack } from '../lib/preview-origin-stack.js';
import { repositoryRoot, caPath } from './origin-fixture.js';

function synth(parked: boolean) {
  const app = new App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const subnets = [{ id: 'subnet-fixture33333333', availabilityZone: 'us-east-1a' }, { id: 'subnet-fixture44444444', availabilityZone: 'us-east-1b' }];
  const storage = new ChatStorageStack(app, 'Storage', { env, corsOrigins: [] });
  const origin = new PreviewOriginStack(app, 'Origin', {
    env, hostname: 'preview.example.com', production: { hostname: 'api.example.com' }, repositoryRoot, originProviderPath: path.resolve(__dirname, '../../origin-provider'),
    vpcId: 'vpc-fixture12345678', publicSubnets: [{ id: 'subnet-fixture11111111', availabilityZone: 'us-east-1a' }, { id: 'subnet-fixture22222222', availabilityZone: 'us-east-1b' }],
    cloudflareCidrs: ['192.0.2.0/24'], clientVersion: 'fixture', tokenSecretName: '/test/token', clientSecretName: '/test/client',
    caPath, corsOrigins: [], parked, parkedDnsTarget: 'parked.invalid', wakeUrl: 'https://wake.example.com/',
  });
  const chat = new PreviewChatService(origin, 'ChatService', {
    vpcId: 'vpc-fixture12345678', privateSubnets: subnets,
    clusterName: 'test', alertsTopicName: 'existing-alerts', hostnames: ['preview.example.com'], corsOrigins: [],
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test-runtime',
    sessionApiFunctionName: 'test-session-api', sessionApiAlias: 'live', reaperCommand: ['node', 'reap.js'], authBrowserId: 'test-browser',
    chatTable: storage.chatTable as ITable, image: ContainerImage.fromRegistry('test-image'), parked,
  });
  addFilesLinks(origin, chat, storage, { subnets }, path.resolve(__dirname, '../../../..'), ['https://web.example.com']);
  return Template.fromStack(origin);
}

test.each([false, true])('Chat mounts the accounts access point with IAM and TLS while EFS selection stays off, parked=%s', parked => {
  const template = synth(parked);
  const [accounts] = Object.keys(template.findResources('AWS::EFS::AccessPoint'));
  const accessPointArn = { 'Fn::GetAtt': [accounts, 'Arn'] };
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Volumes: [{ Name: 'files-efs', EFSVolumeConfiguration: {
      FilesystemId: Match.anyValue(), TransitEncryption: 'ENABLED',
      AuthorizationConfig: { AccessPointId: { Ref: accounts }, IAM: 'ENABLED' },
    } }],
    ContainerDefinitions: Match.arrayWith([Match.objectLike({
      MountPoints: [{ SourceVolume: 'files-efs', ContainerPath: '/mnt/files-efs', ReadOnly: false }],
      Environment: Match.arrayWith([
        { Name: 'BOTCUBE_FILES_EFS_ARN', Value: Match.anyValue() },
        { Name: 'BOTCUBE_FILES_EFS_ROOT', Value: '/mnt/files-efs' },
        { Name: 'BOTCUBE_FILES_LINKS_URL', Value: Match.anyValue() },
        { Name: 'BOTCUBE_FILES_MOUNT_ROLE_ARN', Value: Match.anyValue() },
      ]),
      Secrets: Match.arrayWith([{ Name: 'BOTCUBE_FILES_SIGNING_KEY', ValueFrom: Match.anyValue() }]),
    })]),
  });
  const tasks = template.findResources('AWS::ECS::TaskDefinition');
  expect(JSON.stringify(tasks)).not.toContain('BOTCUBE_FILES_STORE');
  const targets = Object.keys(template.findResources('AWS::EFS::MountTarget'));
  template.hasResource('AWS::ECS::Service', { DependsOn: Match.arrayWith([accounts, ...targets]) });
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: 'tcp', FromPort: 2049, ToPort: 2049,
    SourceSecurityGroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ChatServiceIngress'), 'GroupId'] },
    GroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^FilesEfsMountTargets'), 'GroupId'] },
  });
  template.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([{
    Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'], Effect: 'Allow', Resource: Match.anyValue(),
    Condition: { StringEquals: { 'elasticfilesystem:AccessPointArn': accessPointArn } },
  }]) } });
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  expect(policies).not.toContain('elasticfilesystem:ClientRootAccess');
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
      Action: 'sts:AssumeRole', Principal: { AWS: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ChatServiceTaskTaskRole'), 'Arn'] } },
    })]) },
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    Roles: [{ Ref: Match.stringLikeRegexp('^FilesMountRole') }],
    PolicyDocument: { Statement: [{
      Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'], Effect: 'Allow',
      Resource: Match.anyValue(), Condition: { ArnLike: { 'elasticfilesystem:AccessPointArn': Match.anyValue() } },
    }] },
  });
});
