import * as fs from 'node:fs';
import * as path from 'node:path';

const copy = (cdkPackage: string) => fs.readFileSync(path.resolve(__dirname, `../../../${cdkPackage}/cdk/lib/lambda-inline-grants.ts`), 'utf8');

test("matches the AgentCore package's copy byte for byte, since neither package's build can import the other's source", () => {
  expect(copy('ecs')).toBe(copy('agentcore'));
});
