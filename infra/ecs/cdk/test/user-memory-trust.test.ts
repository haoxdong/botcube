// The `assume-role` Turn credentials adapter across both CDK apps: only the Chat Service may assume the Memory role.
import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { synthesizeExample } from './example-fixture.js';

test("the enterprise example's Memory role trusts only its Chat Service's task role", async () => {
  const app = await synthesizeExample('enterprise');
  const template = (id: string) => Template.fromStack(app.node.findChild(id) as Stack);
  const roleNamed = (stack: Template, name: string) => {
    const roles = Object.values(stack.findResources('AWS::IAM::Role', { Properties: { RoleName: name } }));
    expect(roles).toHaveLength(1);
    return roles[0]?.Properties;
  };

  roleNamed(template('PreviewOrigin'), 'bot-cube-chat-service');
  expect(roleNamed(template('AgentCore-bot-cube-template'), 'bot-cube-user-memory').AssumeRolePolicyDocument.Statement).toEqual([
    {
      Effect: 'Allow',
      Principal: { AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::000000000000:root']] } },
      Action: 'sts:AssumeRole',
      Condition: {
        ArnEquals: {
          'aws:PrincipalArn': { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::000000000000:role/bot-cube-chat-service']] },
        },
      },
    },
  ]);
}, 180_000);
