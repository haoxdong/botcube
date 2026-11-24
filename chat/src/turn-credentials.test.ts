import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } from '../test/fakes/credentials.js';
import { motoEndpoint } from '../test/fakes/moto.js';
import { startInProcess, type InProcessStack } from '../test/in-process.js';
import { assumeRoleAwsAccess, memorySessionPolicy, SESSION_POLICY_LIMIT } from './turn-credentials.js';
import { filed } from '../test/stock-bot.js';

const MEMORY_KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/33333333-cccc-4ccc-8ccc-333333333333';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/bot-cube-user-memory';

let stack: InProcessStack;
beforeAll(async () => {
  // STS is moto's: the SDK reads these as it would an ECS task's.
  vi.stubEnv('AWS_ENDPOINT_URL_STS', motoEndpoint());
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('AWS_ACCESS_KEY_ID', AWS_ACCESS_KEY_ID);
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', AWS_SECRET_ACCESS_KEY);
  stack = await startInProcess({ config: { awsAccess: { kind: 'assume-role', roleArn: ROLE_ARN } } });
});
afterAll(async () => {
  await stack.stop();
  vi.unstubAllEnvs();
});

const asOwner = (owner: string, body: unknown) => stack.app.request('/', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-test-owner': owner }, body: JSON.stringify(body),
});

async function turn(owner: string, sessionId: string) {
  const response = await asOwner(owner, {
    threadId: sessionId, runId: randomUUID(), state: {}, tools: [], context: [],
    messages: [{ id: randomUUID(), role: 'user', content: 'hello' }], forwardedProps: { turnIdentity: 'client-sent' },
  });
  return { response, props: stack.agentcore.invocationFor(sessionId).payload.forwardedProps };
}

describe('assume-role Turn credentials', () => {
  it("hands each Turn its own User's credentials, never the client's", async () => {
    const [first, second] = [`acct_owner-${randomUUID()}`, `acct_owner-${randomUUID()}`];
    const [firstSession, secondSession] = [randomUUID(), randomUUID()];
    await stack.sessionMetadata.recordTurn(first, firstSession, { filingUserId: filed(first), title: 'First', allocation: true });
    await stack.sessionMetadata.recordTurn(second, secondSession, { filingUserId: filed(second), title: 'Second', allocation: true });

    const [mine, theirs] = await Promise.all([turn(first, firstSession), turn(second, secondSession)]);

    expect(mine.props.turnIdentity).toEqual({
      actorId: filed(first), filingActorId: filed(first), sessionId: firstSession, writesPrefix: expect.stringMatching(/^lgw-[0-9a-f]{32}$/),
      turnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      accessKeyId: expect.any(String), secretAccessKey: expect.any(String), sessionToken: expect.any(String), expiration: expect.any(String),
    });
    expect(theirs.props.turnIdentity).toMatchObject({ actorId: filed(second), filingActorId: filed(second), sessionId: secondSession });
    const [mineKeys, theirKeys] = [mine, theirs].map(({ props }) => (props.turnIdentity as { sessionToken: string }).sessionToken);
    expect(mineKeys).not.toBe(theirKeys);
    expect(mine.props.sessionSnapshotEpoch).toEqual({ epoch: expect.any(String), turnId: (mine.props.turnIdentity as { turnId: string }).turnId });
    await Promise.all([mine.response.text(), theirs.response.text()]);
  });

  it('withholds a stream that carries the credentials', async () => {
    const owner = `acct_owner-${randomUUID()}`;
    const sessionId = randomUUID();
    await stack.sessionMetadata.recordTurn(owner, sessionId, { filingUserId: filed(owner), title: 'Leak', allocation: true });
    stack.agentcore.script(sessionId, { kind: 'stream', frames: (props) => [
      'data: {"type":"RUN_STARTED"}',
      `data: ${JSON.stringify({ type: 'RUN_ERROR', message: `signed with ${(props.turnIdentity as { sessionToken: string }).sessionToken}` })}`,
    ] });

    const { response, props } = await turn(owner, sessionId);

    const body = await response.text();
    expect(body).toContain('TURN_CREDENTIALS_IN_STREAM');
    expect(body).not.toContain((props.turnIdentity as { sessionToken: string }).sessionToken);
  });
});

describe('the assume-role STS client', () => {
  afterEach(() => {
    vi.stubEnv('AWS_REGION', 'us-east-1');
  });

  it('takes its region from the SDK, failing with none rather than assuming us-east-1', async () => {
    vi.stubEnv('AWS_REGION', undefined);
    vi.stubEnv('AWS_DEFAULT_REGION', undefined);
    vi.stubEnv('AWS_PROFILE', undefined);
    vi.stubEnv('AWS_CONFIG_FILE', '/nonexistent/aws-config');
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', '/nonexistent/aws-credentials');
    const turn = { actorId: filed('a'), filingActorId: filed('a'), sessionId: randomUUID(), startedAt: new Date().toISOString() };

    await expect(assumeRoleAwsAccess({ roleArn: ROLE_ARN }).grant(turn)).rejects.toThrow('Region is missing');
  });
});

describe('the Memory session policy', () => {
  const scope = { actorId: filed('a'), filingActorId: filed('anon-7'), sessionId: 'session-1', writesPrefix: 'lgw-3d005e2ccf2461767eb01d780463736c' };
  it("is the Memory role's statements with the Turn's own values in place of its tags, so another User's actor or record matches none", () => {
    expect(JSON.parse(memorySessionPolicy(scope))).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow', Action: 'bedrock-agentcore:*Event*', Resource: '*',
          Condition: {
            StringEquals: { 'bedrock-agentcore:actorId': filed('anon-7') },
            StringLike: { 'bedrock-agentcore:sessionId': ['session-1', 'lgw-3d005e2ccf2461767eb01d780463736c-*'] },
          },
        },
        { Effect: 'Allow', Action: 'bedrock-agentcore:*Event*', Resource: '*', Condition: { StringEquals: { 'bedrock-agentcore:actorId': filed('a') } } },
        { Effect: 'Allow', Action: 'bedrock-agentcore:*MemoryRecord*', Resource: '*', Condition: { StringLike: { 'bedrock-agentcore:namespace': `/actors/${filed('a')}/*` } } },
        { Effect: 'Allow', Action: 'bedrock-agentcore:*MemoryRecords', Resource: '*', Condition: { StringLike: { 'bedrock-agentcore:namespacePath': `/actors/${filed('a')}/*` } } },
      ],
    });
  });

  it('permits only the supplied Memory key in the Turn session', () => {
    expect(JSON.parse(memorySessionPolicy(scope, MEMORY_KEY_ARN)).Statement).toContainEqual({
      Effect: 'Allow', Resource: MEMORY_KEY_ARN,
      Action: ['kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*'],
    });
  });

  it('stays under the STS limit for the longest filing IDs and Session IDs a Turn can carry', () => {
    // A filing ID is at most 255 characters (filing-user-id.ts); an AgentCore Session ID at most 100.
    const longest = { actorId: 'a'.repeat(255), filingActorId: 'f'.repeat(255), sessionId: 's'.repeat(100), writesPrefix: scope.writesPrefix };

    expect(memorySessionPolicy(longest, MEMORY_KEY_ARN).length).toBeLessThanOrEqual(SESSION_POLICY_LIMIT);
  });

  it('refuses a policy STS would refuse, naming its length', () => {
    expect(() => memorySessionPolicy({ ...scope, actorId: 'a'.repeat(600) })).toThrow(/^The Turn's Memory session policy is \d+ characters; STS takes at most 2048$/);
  });
});
