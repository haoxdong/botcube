import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FakeAgentCore } from '../fakes/fake-agentcore.js';
import { FakeSessionApi } from '../fakes/fake-backends.js';
import { HttpFake, sendJson } from '../fakes/http-fake.js';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable, RUNTIME_ARN } from '../fakes/stack.js';
import { motoAws, motoEndpoint } from '../fakes/moto.js';
import { BIND_ADDRESS, startOnFreePort } from '../fakes/process.js';
import { Browser } from './browser.js';
import { FakeEfs } from './fake-efs.js';
import { TestAccounts, testBotCubeConfig } from '../stock-bot.js';

export { AWS_ACCESS_KEY_ID, createChatTable, RUNTIME_ARN };

interface StackOptions {
  agentcore?: 'fake' | 'unreachable' | 'unconfigured';
  table?: 'created' | 'missing';
  /** The web UI origins: the BotCube Config's `domains.web`, then its `domains.webAliases`. */
  corsOrigins?: string[];
  /** Bot settings over the parity bot's, as an Operator's bot.yaml gives them. */
  bot?: Record<string, unknown>;
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

/** The parity bot's settings: the template's identity on the Echo model. */
export const PARITY_BOT = {
  agentIdentity: { name: 'BotCube', character: 'A template agent', avatar: '🧊' },
  accountKey: 'template',
  models: [{ key: 'echo', label: 'Echo', provider: 'echo' }],
};

/** The Credential Service as `/account/session` reads it: an account with no Linked Accounts. Nothing else is served. */
export function startNoLinkedAccounts() {
  return new HttpFake((request, response) => {
    if (`${request.method} ${request.path}` !== 'POST /account/linked-accounts') return sendJson(response, 404, { detail: 'Not Found' });
    sendJson(response, 200, { linkedAccounts: [] });
  }).listen();
}

export async function startStack(options: StackOptions = {}) {
  const endpoint = motoEndpoint();
  const home = await mkdtemp(join(tmpdir(), 'chat-parity-'));
  const name = `chat-${Math.random().toString(36).slice(2)}`;
  if (options.table !== 'missing') await createChatTable(endpoint, name);
  const agentcore = await new FakeAgentCore().listen();
  const sessionApi = await new FakeSessionApi().listen();
  const files = await new FakeEfs(join(home, 'files')).listen();
  const credentialService = await startNoLinkedAccounts();
  const unreachable = createServer((socket) => socket.destroy());
  if (options.agentcore === 'unreachable') {
    await new Promise<void>((done) => unreachable.listen(0, BIND_ADDRESS, done));
  }
  const address = unreachable.address();
  const agentcoreUrl = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : agentcore.url;
  const [web, ...webAliases] = options.corsOrigins ?? [];
  const imageConfig = testBotCubeConfig({ ...PARITY_BOT, ...options.bot }, web === undefined ? {} : { domains: { web, webAliases, chatService: 'https://chat.example.invalid' } });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home,
    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
    AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1', AWS_EC2_METADATA_DISABLED: 'true',
    AWS_ENDPOINT_URL_DYNAMODB: endpoint, BOTCUBE_CHAT_TABLE: name,
    BOTCUBE_CONFIG: imageConfig,
    BOTCUBE_TEST_IMAGE_SETTINGS: join(imageConfig, '..', 'bot.yaml'),
    BOTCUBE_LOCAL_SESSION_API_URL: sessionApi.url,
    AWS_ENDPOINT_URL_STS: endpoint,
    ...files.environment,
    ...(options.agentcore === 'unconfigured' ? {} : {
      AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      // The managed Agent Computer, as a deploy runs it; the fake AgentCore starts no browser, so a Turn's start only logs.
      AGENTCORE_AGENT_COMPUTER_BROWSER_ID: 'parity-browser',
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: agentcoreUrl,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE_CONTROL: agentcoreUrl,
    }),
    BOTCUBE_CREDENTIAL_SERVICE_URL: credentialService.url,
    BOTCUBE_CREDENTIAL_INVOCATION_SECRET: 'parity-credential-secret',
  };
  const closeFakes = async () => {
    await Promise.all([agentcore.close(), sessionApi.close(), files.close(), credentialService.close()]);
    if (unreachable.listening) await new Promise<void>((done) => unreachable.close(() => done()));
    await rm(home, { recursive: true, force: true });
  };
  const startService = () => startOnFreePort((port) => ({
    command: `${inject('parityServiceCommand').replace('node ', `node --import ${fileURLToPath(new URL('../image-process.mjs', import.meta.url))} `)} ${JSON.stringify(files.root)}`, env: { ...env, PORT: String(port) },
    url: `http://127.0.0.1:${port}/`, listening: `Chat Service listening on :${port}`,
  }));
  const service = await startService().catch(async (error: unknown) => {
    await closeFakes();
    throw error;
  });
  const url = new URL(service.url).origin;
  const accounts = new TestAccounts(name, DynamoDBDocumentClient.from(new DynamoDBClient(motoAws())), PARITY_BOT.accountKey);
  return {
    get url() { return url; },
    agentcore, sessionApi,  files,
    browser: () => new Browser(url),
    /** A browser signed in to a new registered account, as a User whose Sign-in saved them. */
    async signedInBrowser() {
      const browser = new Browser(url);
      browser.cookies.set(`${PARITY_BOT.accountKey}_session`, await accounts.signIn(`acct_${randomUUID()}`));
      return browser;
    },
    logs: () => service.output(),
    async stop() {
      await service.stop();
      await closeFakes();
    },
  };
}
