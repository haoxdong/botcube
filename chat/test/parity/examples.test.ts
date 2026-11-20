import { createPrivateKey, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import type { ModelsWire } from '../../../deployment-config/blocks.js';
import { loadDeployment } from '../../../deployment-config/load.js';
import { required } from '../required.js';
import { frameData, sseFrames } from './browser.js';
import { MTLS_MODELS_HOST, PUBLIC_ORIGIN, startLocalStack, type LocalStack } from './local-stack.js';

const stacks: LocalStack[] = [];
afterAll(() => Promise.all(stacks.map((stack) => stack.stop())));

const deploymentConfig = (example: string) => fileURLToPath(new URL(`../../../examples/${example}/deployment-config.json`, import.meta.url));

const scratch: string[] = [];
afterAll(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))));

/** The enterprise example with its models Endpoint on the Responses wire, as a Responses-only gateway needs. */
async function enterpriseOnTheResponsesWire(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'responses-wire-'));
  scratch.push(dir);
  const example = deploymentConfig('enterprise');
  const file = JSON.parse(await readFile(example, 'utf8')) as { bot: string; models: object };
  const path = join(dir, 'deployment-config.json');
  await writeFile(path, JSON.stringify({ ...file, bot: resolve(dirname(example), file.bot), models: { ...file.models, wire: 'responses' } }));
  return path;
}

/** The tool the agent's model calls on an OpenAI-compatible Endpoint before it answers, and its arguments. */
const AGENT_TOOL_CALL = { name: 'ls', arguments: { path: '/' } };

/**
 * The example deployed offline, its External Services on their stand-ins, after one Turn and its summary. On an
 * OpenAI-compatible Endpoint the agent's model calls a tool first, and answers once the tool's result is back.
 */
async function conversation(path: string) {
  const stack = await startLocalStack({ deploymentConfig: path });
  stacks.push(stack);
  if (stack.openAICompatible) stack.openAICompatible.agentToolCall = AGENT_TOOL_CALL;
  const browser = stack.browser();
  await browser.openAccountSession();
  const thread = await browser.newSideChat();
  const turn = await browser.sendTurn(thread, { text: 'Hello, who are you?' });
  const frames = sseFrames(await turn.text()).map(frameData);
  // The Turn's summary is made after its stream closes.
  const summaries = stack.openAICompatible ?? stack.bedrock;
  await summaries.waitForRequests(() => summaries.summarizedTurns().length > 0);
  return {
    stack,
    identity: await (await browser.get('/agent/identity')).json(),
    reply: frames.filter(({ type }) => type === 'TEXT_MESSAGE_CONTENT').map(({ delta }) => delta).join(''),
    toolCalls: frames.filter(({ type }) => type === 'TOOL_CALL_START').map(({ toolCallName }) => toolCallName),
    toolResults: frames.filter(({ type }) => type === 'TOOL_CALL_RESULT').length,
  };
}

describe('the public and the enterprise example, on each wire of its OpenAI-compatible endpoint', () => {
  let pub: Awaited<ReturnType<typeof conversation>>;
  /** The enterprise example's conversation on each wire. */
  let enterprise: Record<ModelsWire, Awaited<ReturnType<typeof conversation>>>;
  beforeAll(async () => {
    const [onPublic, onChatCompletions, onResponses] = await Promise.all([
      conversation(deploymentConfig('public')),
      conversation(deploymentConfig('enterprise')),
      enterpriseOnTheResponsesWire().then(conversation),
    ]);
    pub = onPublic;
    enterprise = { 'chat-completions': onChatCompletions, responses: onResponses };
  }, 120_000);

  it('hold the same conversation with the example bot', () => {
    expect({ identity: pub.identity, reply: pub.reply }).toEqual({
      identity: { name: 'BotCube', character: 'A template agent', vibe: 'Direct, precise, and calm', avatar: '🧊' },
      reply: 'Echo: Hello, who are you?',
    });
    for (const { identity, reply } of Object.values(enterprise)) expect({ identity, reply }).toEqual({ identity: pub.identity, reply: pub.reply });
  });

  it.each(['chat-completions', 'responses'] as const)("stream the agent's tool call and its result over %s", (wire) => {
    const turn = enterprise[wire];
    const endpoint = required(turn.stack.openAICompatible, 'the models endpoint stand-in');

    expect({ toolCalls: turn.toolCalls, toolResults: turn.toolResults }).toEqual({ toolCalls: [AGENT_TOOL_CALL.name], toolResults: 1 });
    // The model's first answer called the tool; its second request carried the tool's result back, and it answered.
    expect(endpoint.toolResults()).toHaveLength(1);
    expect(endpoint.wires()).toEqual([wire, wire, wire]);
  });

  it.each(['chat-completions', 'responses'] as const)('reach their models over %s, turn summaries included, on Bedrock and on the OpenAI-compatible endpoint', (wire) => {
    const summarized = [{ request: 'Hello, who are you?', answer: 'Echo: Hello, who are you?' }];
    expect(pub.stack.bedrock.summarizedTurns()).toEqual(summarized);
    expect(pub.stack.openAICompatible).toBeUndefined();

    const turn = enterprise[wire];
    const endpoint = required(turn.stack.openAICompatible, 'the models endpoint stand-in');
    expect(turn.stack.bedrock.requests).toEqual([]);
    // The agent's model by its key in the bot settings, before and after its tool call, then the summary model the Deployment Config names.
    expect(endpoint.models()).toEqual(['echo', 'echo', 'example-summary']);
    expect(endpoint.summarizedTurns()).toEqual(summarized);
    // The Deployment Config's header reaches the endpoint on the Turn and on its summary.
    expect(endpoint.requests.map(({ headers }) => headers['x-tenant'])).toEqual(['botcube-example', 'botcube-example', 'botcube-example']);
  });
});

const wallClock = (instant: Date, timeZone: string) => new Intl.DateTimeFormat('sv-SE', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(instant).replace(' ', 'T');

it.each(['UTC', 'Asia/Kolkata'])('fires a scheduled task on time in %s in the enterprise example, from the table poller into the run queue', { timeout: 120_000 }, async (timezone) => {
  const stack = await startLocalStack({ deploymentConfig: deploymentConfig('enterprise'), scheduling: true });
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
    title: 'Morning brief', prompt: 'Brief me', schedule: `at(${wallClock(due, timezone)})`, timezone, proposalId: `enterprise-schedule-${timezone}`,
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
  const stack = await startLocalStack({ deploymentConfig: deploymentConfig('enterprise'), chatEnv: { BOTCUBE_TURN_IDENTITY_KEYS: JSON.stringify([key]) } });
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

it("stops the enterprise example on sign-in's old client secret field, naming it", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'old-identity-'));
  try {
    const path = join(dir, 'deployment-config.json');
    const { identity } = JSON.parse(await readFile(deploymentConfig('enterprise'), 'utf8')) as { identity: { issuer: string } };
    const secretArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:botcube/oidc-client-secret';
    await writeFile(path, JSON.stringify({ bot: './bot.json', identity: { kind: 'oidc', issuer: identity.issuer, clientId: 'botcube', clientSecret: { secretArn } } }));
    await expect(startLocalStack({ chatEnv: { BOTCUBE_DEPLOYMENT_CONFIG: path } })).rejects.toThrow(`Deployment Config ${path}: identity.clientSecret: Unrecognized key`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("sends the enterprise example's traces to its authenticated collector through its authenticating proxy", { timeout: 120_000 }, async () => {
  const path = deploymentConfig('enterprise');
  const { telemetry } = loadDeployment(path).config;
  if (telemetry.kind !== 'otlp') throw new Error('The enterprise example exports to its own collector');
  const collectorHost = new URL(telemetry.url).host;
  const stack = await startLocalStack({ deploymentConfig: path, chatEnv: { OTEL_BSP_SCHEDULE_DELAY: '100' } });
  stacks.push(stack);
  const { proxy, collector } = required(stack.egress, "the enterprise example's proxy");
  const browser = stack.browser();
  await browser.openAccountSession();
  const turn = await browser.sendTurn(await browser.newSideChat(), { text: 'Hello, who are you?' });
  expect(sseFrames(await turn.text()).map(frameData).some(({ type }) => type === 'RUN_FINISHED')).toBe(true);

  const traces = required(collector, "the enterprise example's collector");
  await traces.waitForRequests(() => traces.received('Chat Turn'));
  expect(traces.received('botcube-chat')).toBe(true);
  expect(new Set(proxy.hosts())).toEqual(new Set([collectorHost]));
  // Each request carried the proxy Endpoint's credential, through each process's relay, and its header.
  expect(new Set(proxy.requests.map(({ headers }) => [headers['proxy-authorization'], headers['x-egress-route']].join(' ')))).toEqual(
    new Set(['Bearer stand-in-proxy-token botcube-example']),
  );
});

it("presents the enterprise example's client certificates to its mTLS proxy, for a Turn's model call and its tool's request", async () => {
  const stack = await startLocalStack({ deploymentConfig: deploymentConfig('enterprise'), endpointTls: true });
  stacks.push(stack);
  const { proxy, front } = required(stack.mtls, "the enterprise example's mTLS stand-ins");
  const toolHost = 'tool.example.test:443';
  required(stack.openAICompatible, 'the models endpoint stand-in').toolCalls.push({
    name: 'execute', arguments: { command: `python3 -c "import urllib.request; urllib.request.urlopen('https://${toolHost}/', timeout=5)" || true` },
  });
  const browser = stack.browser();
  await browser.openAccountSession();
  const turn = await browser.sendTurn(await browser.newSideChat(), { text: 'Reach the tool host' });
  expect(sseFrames(await turn.text()).map(frameData).some(({ type }) => type === 'RUN_FINISHED')).toBe(true);

  expect(proxy.hosts()).toEqual(expect.arrayContaining([`${MTLS_MODELS_HOST}:443`, toolHost]));
  expect(new Set(proxy.clients())).toEqual(new Set(['client-b']));
  expect(new Set(front.clients)).toEqual(new Set(['client-a']));
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
