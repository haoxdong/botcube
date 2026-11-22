import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { WebLatencyStack } from '../lib/web-latency-stack';

test('adopters name the latency guest pool and guest and reader roles', () => {
  const template = Template.fromStack(new WebLatencyStack(new App(), 'Latency', {
    appMonitorName: 'adopter-monitor', domains: ['web.example.com'], readerSubject: 'repo:adopter/app:ref:refs/heads/main', moments: ['response'], turnLogGroups: ['/adopter/chat-service-preview'],
    identityPoolName: 'adopter_guests', guestRoleName: 'adopter-guests', readerRoleName: 'adopter-reader',
  }));
  template.hasResourceProperties('AWS::Cognito::IdentityPool', { IdentityPoolName: 'adopter_guests' });
  template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'adopter-guests' });
  template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'adopter-reader' });
});

test('the metrics reader role exists only for a reader the release tooling names', () => {
  const props = { appMonitorName: 'adopter-monitor', domains: ['web.example.com'], moments: ['response'], turnLogGroups: ['/adopter/chat-service-preview'] };
  const without = Template.fromStack(new WebLatencyStack(new App(), 'Latency', props));
  expect(Object.keys(without.findResources('AWS::IAM::Role'))).toEqual([expect.stringMatching(/^Guest/)]);
  expect(without.findOutputs('ReaderRoleArn')).toEqual({});
  const named = Template.fromStack(new WebLatencyStack(new App(), 'Latency', { ...props, readerSubject: 'repo:adopter/app:ref:refs/heads/main' }));
  expect(Object.keys(named.findOutputs('ReaderRoleArn'))).toEqual(['ReaderRoleArn']);
});
