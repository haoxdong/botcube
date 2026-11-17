import { createPrivateKey, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { proxyEnvironment } from '../../../deployment-config/environment.js';
import { loadDeployment } from '../../../deployment-config/load.js';
import { FakeForwardProxy, FakeOtlpCollector } from '../fakes/egress.js';
import { required } from '../required.js';
import { frameData, sseFrames } from './browser.js';
import { PUBLIC_ORIGIN, startLocalStack, type LocalStack } from './local-stack.js';

const stacks: LocalStack[] = [];
afterAll(() => Promise.all(stacks.map((stack) => stack.stop())));

const deploymentConfig = (example: string) => fileURLToPath(new URL(`../../../examples/${example}/deployment-config.json`, import.meta.url));

// The deploy fills it from the enterprise example's identity.clientSecret; the public example has none to read.
const BOTCUBE_OIDC_CLIENT_SECRET = 'enterprise-client-secret';

/** The example deployed offline, its External Services on their stand-ins, after one Turn and its summary. */
async function conversation(example: string) {
  const stack = await startLocalStack({ deploymentConfig: deploymentConfig(example), chatEnv: { BOTCUBE_OIDC_CLIENT_SECRET } });
  stacks.push(stack);
  const browser = stack.browser();
  await browser.openAccountSession();
  const thread = await browser.newSideChat();
  const turn = await browser.sendTurn(thread, { text: 'Hello, who are you?' });
  const deltas = sseFrames(await turn.text()).map(frameData).filter(({ type }) => type === 'TEXT_MESSAGE_CONTENT').map(({ delta }) => delta);
  // The Turn's summary is made after its stream closes.
  const summaries = stack.openAICompatible ?? stack.bedrock;
  await summaries.waitForRequests(() => summaries.summarizedTurns().length > 0);
  return {
    stack,
    identity: await (await browser.get('/agent/identity')).json(),
    reply: deltas.join(''),
  };
}

describe('the public and the enterprise example', () => {
  let pub: Awaited<ReturnType<typeof conversation>>;
  let enterprise: Awaited<ReturnType<typeof conversation>>;
  beforeAll(async () => {
    [pub, enterprise] = await Promise.all([conversation('public'), conversation('enterprise')]);
  }, 120_000);

  it('hold the same conversation with the example bot', () => {
    expect({ identity: pub.identity, reply: pub.reply }).toEqual({
      identity: { name: 'BotCube', character: 'A template agent', vibe: 'Direct, precise, and calm', avatar: '🧊' },
      reply: 'Echo: Hello, who are you?',
    });
    expect({ identity: enterprise.identity, reply: enterprise.reply }).toEqual({ identity: pub.identity, reply: pub.reply });
  });

  it('reach their models, turn summaries included, on Bedrock and on the OpenAI-compatible endpoint', () => {
    const summarized = [{ request: 'Hello, who are you?', answer: 'Echo: Hello, who are you?' }];
    expect(pub.stack.bedrock.summarizedTurns()).toEqual(summarized);
    expect(pub.stack.openAICompatible).toBeUndefined();

    const endpoint = required(enterprise.stack.openAICompatible, 'the models endpoint stand-in');
    expect(enterprise.stack.bedrock.requests).toEqual([]);
    // The agent's model by its key in the bot settings, then the summary model the Deployment Config names.
    expect(endpoint.models()).toEqual(['echo', 'example-summary']);
    expect(endpoint.summarizedTurns()).toEqual(summarized);
  });
});

it('fires a scheduled task on time in the enterprise example, from the table poller into the run queue', { timeout: 120_000 }, async () => {
  const stack = await startLocalStack({ deploymentConfig: deploymentConfig('enterprise'), chatEnv: { BOTCUBE_OIDC_CLIENT_SECRET }, scheduling: true });
  stacks.push(stack);
  const browser = stack.browser();
  await browser.openAccountSession();
  const { id: mainChat } = await (await browser.get('/main-chat')).json();
  const mainChatReplay = async () => {
    const { messages = [] } = (await (await browser.get(`/threads/${mainChat}`)).json()) as { messages?: { content: string }[] };
    return messages.map(({ content }) => content).join('\n');
  };
  // The poller reads due schedules every 10 s, so a run starts at most that late.
  const due = new Date(Math.ceil((Date.now() + 15_000) / 1000) * 1000);
  const task = await browser.post('/scheduled-tasks', {
    title: 'Morning brief', prompt: 'Brief me', schedule: `at(${due.toISOString().slice(0, 19)})`, timezone: 'UTC', proposalId: 'enterprise-schedule',
  });
  expect(task.status).toBe(201);
  expect(await mainChatReplay()).not.toContain('Scheduled task "Morning brief"');

  await expect.poll(mainChatReplay, { timeout: 60_000, interval: 250 }).toContain('Scheduled task "Morning brief"');
  expect(Date.now()).toBeGreaterThanOrEqual(due.getTime());
  expect(Date.now()).toBeLessThan(due.getTime() + 30_000);
  const { threads } = await (await browser.get('/threads')).json();
  const run = required(threads.find((thread: { title: string }) => thread.title === 'Morning brief'), "the scheduled run's side chat");
  expect((await (await browser.get(`/threads/${run.id}`)).json()).messages.at(-1)).toMatchObject({ role: 'assistant', content: expect.stringContaining('Echo:') });
});

it("refuses an enterprise Harness invocation without the Chat Service's bearer token", { timeout: 120_000 }, async () => {
  const key = { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'test-key' };
  const stack = await startLocalStack({ deploymentConfig: deploymentConfig('enterprise'), chatEnv: { BOTCUBE_OIDC_CLIENT_SECRET, BOTCUBE_TURN_IDENTITY_KEYS: JSON.stringify([key]) } });
  stacks.push(stack);
  const signed = (audience: string, signingKey: JsonWebKey = key) => new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setIssuer(PUBLIC_ORIGIN).setAudience(audience).setIssuedAt().setExpirationTime('5m')
    .sign(createPrivateKey({ key: signingKey, format: 'jwk' }));
  const invoke = (authorization?: string) => fetch(`${required(stack.harnessUrl, 'Harness authorizer')}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: '{}',
  });
  const otherKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });

  // The Harness takes a Turn's bearer token through the authorizer: the conversation above proves it.
  expect((await invoke()).status).toBe(401);
  expect((await invoke('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261116/us-east-1/bedrock-agentcore/aws4_request')).status).toBe(401);
  expect((await invoke(`Bearer ${await signed('botcube-harness', otherKey)}`)).status).toBe(401);
  // A Turn identity, signed by the same keys for STS, does not invoke the Harness.
  expect((await invoke(`Bearer ${await signed('sts.amazonaws.com')}`)).status).toBe(401);
});

it('stops the enterprise example without its OIDC client secret, naming the field', { timeout: 60_000 }, async () => {
  await expect(startLocalStack({ deploymentConfig: deploymentConfig('enterprise') }))
    .rejects.toThrow('identity.clientSecret: BOTCUBE_OIDC_CLIENT_SECRET is not set');
});

it("sends the enterprise example's traces to its collector through its proxy", { timeout: 120_000 }, async () => {
  const path = deploymentConfig('enterprise');
  const { telemetry, proxy } = loadDeployment(path).config;
  const collectorHost = new URL(required(telemetry, 'enterprise telemetry').otlpEndpoint).host;
  const collector = await new FakeOtlpCollector().listen();
  // The corporate proxy, offline: it carries requests for the collector's host to the stand-in collector.
  const corporateProxy = await new FakeForwardProxy({ [collectorHost]: collector.url }).listen();
  try {
    // What the deploy gives the processes (the ECS Chat Service exports through its collector sidecar; here, directly).
    const plain = proxyEnvironment({ proxy: { ...required(proxy, 'enterprise proxy'), url: corporateProxy.url } });
    const stack = await startLocalStack({
      deploymentConfig: path,
      harnessEnv: plain,
      chatEnv: {
        BOTCUBE_OIDC_CLIENT_SECRET,
        ...plain,
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: required(telemetry, 'enterprise telemetry').otlpEndpoint,
        OTEL_BSP_SCHEDULE_DELAY: '100',
      },
    });
    stacks.push(stack);
    const browser = stack.browser();
    await browser.openAccountSession();
    const turn = await browser.sendTurn(await browser.newSideChat(), { text: 'Hello, who are you?' });
    expect(sseFrames(await turn.text()).map(frameData).some(({ type }) => type === 'RUN_FINISHED')).toBe(true);

    await collector.waitForRequests(() => collector.received('Chat Turn'));
    expect(collector.received('botcube-chat')).toBe(true);
    expect(new Set(corporateProxy.hosts())).toEqual(new Set([collectorHost]));
  } finally {
    await Promise.all([collector.close(), corporateProxy.close()]);
  }
});

it('stops startup on a Deployment Config with an unknown adapter, naming the field', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bad-deployment-'));
  try {
    const path = join(dir, 'deployment-config.json');
    await writeFile(path, JSON.stringify({ bot: './bot.json', models: { kind: 'vertex' } }));
    await expect(startLocalStack({ chatEnv: { BOTCUBE_DEPLOYMENT_CONFIG: path } })).rejects.toThrow(
      `Deployment Config ${path}: models.kind: Invalid discriminator value. Expected 'bedrock' | 'openai-compatible'`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
