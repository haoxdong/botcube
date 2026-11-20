// The public example is the default path: nothing supplied. Its resources, by stack, logical ID and type, are pinned, so
// a change that drops, renames or adds a production resource on that path shows up here as a reviewed snapshot diff
// instead of a silent CloudFormation replacement. Asset hashes and property values stay out.
import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { IConstruct } from 'constructs';
import { synthesizeExample } from './example-fixture.js';

const stacksOf = (root: IConstruct): Stack[] => root.node.findAll().filter(Stack.isStack);
// A Lambda version's logical ID ends in its code's hash, which every code change moves; the version is meant to be replaced.
const resourceId = (id: string, type: string) => (type === 'AWS::Lambda::Version' ? id.replace(/[0-9a-f]{32}$/, '') : id);

test('the public example creates the same resources, by stack, logical ID and type', async () => {
  const app = await synthesizeExample('public');
  const inventory = Object.fromEntries(stacksOf(app).map(stack => {
    const resources = Template.fromStack(stack).toJSON().Resources as Record<string, { Type: string }>;
    return [stack.node.path, Object.entries(resources).map(([id, { Type }]) => `${resourceId(id, Type)} ${Type}`).sort()];
  }).sort(([a], [b]) => String(a).localeCompare(String(b))));
  expect(inventory).toMatchSnapshot();
});
