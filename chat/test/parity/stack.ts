import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { inject } from 'vitest';
import { FakeAgentCore } from '../fakes/fake-agentcore.js';
import { FakeBedrock, FakeSessionApi } from '../fakes/fake-backends.js';
import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, createChatTable, RUNTIME_ARN } from '../fakes/stack.js';
import { motoEndpoint } from '../fakes/moto.js';
import { BIND_ADDRESS, startOnFreePort } from '../fakes/process.js';
import { Browser } from './browser.js';
import { FakeEfs } from './fake-efs.js';

export { AWS_ACCESS_KEY_ID, createChatTable, RUNTIME_ARN };

interface StackOptions {
  agentcore?: 'fake' | 'unreachable' | 'unconfigured';
  table?: 'created' | 'missing';
  corsOrigins?: string;
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

export async function startStack(options: StackOptions = {}) {
  const endpoint = motoEndpoint();
  const home = await mkdtemp(join(tmpdir(), 'chat-parity-'));
  const name = `chat-${Math.random().toString(36).slice(2)}`;
  if (options.table !== 'missing') await createChatTable(endpoint, name);
  const agentcore = await new FakeAgentCore().listen();
  const sessionApi = await new FakeSessionApi().listen();
  const bedrock = await new FakeBedrock().listen();
  const files = await new FakeEfs(join(home, 'files')).listen();
  const unreachable = createServer((socket) => socket.destroy());
  if (options.agentcore === 'unreachable') {
    await new Promise<void>((done) => unreachable.listen(0, BIND_ADDRESS, done));
  }
  const address = unreachable.address();
  const agentcoreUrl = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : agentcore.url;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home,
    AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
    AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1', AWS_EC2_METADATA_DISABLED: 'true',
    AWS_ENDPOINT_URL_DYNAMODB: endpoint, BOTCUBE_CHAT_TABLE: name,
    BOTCUBE_LOCAL_SESSION_API_URL: sessionApi.url,
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: bedrock.url,
    AWS_ENDPOINT_URL_STS: endpoint,
    ...files.environment,
    ...(options.agentcore === 'unconfigured' ? {} : {
      AGENTCORE_RUNTIME_ARN: RUNTIME_ARN,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: agentcoreUrl,
      AWS_ENDPOINT_URL_BEDROCK_AGENTCORE_CONTROL: agentcoreUrl,
    }),
    BOTCUBE_CREDENTIAL_SERVICE_URL: 'https://credentials.example',
    BOTCUBE_CREDENTIAL_INVOCATION_SECRET: 'parity-credential-secret',
    ...(options.corsOrigins === undefined ? {} : { BOTCUBE_CORS_ORIGINS: options.corsOrigins }),
  };
  const closeFakes = async () => {
    await Promise.all([agentcore.close(), sessionApi.close(), bedrock.close(), files.close()]);
    if (unreachable.listening) await new Promise<void>((done) => unreachable.close(() => done()));
    await rm(home, { recursive: true, force: true });
  };
  const startService = () => startOnFreePort((port) => ({
    command: inject('parityServiceCommand'), env: { ...env, PORT: String(port) },
    url: `http://127.0.0.1:${port}/`, listening: `Chat Service listening on :${port}`,
  }));
  const service = await startService().catch(async (error: unknown) => {
    await closeFakes();
    throw error;
  });
  const url = new URL(service.url).origin;
  return {
    get url() { return url; },
    agentcore, sessionApi, bedrock, files,
    browser: () => new Browser(url),
    logs: () => service.output(),
    async stop() {
      await service.stop();
      await closeFakes();
    },
  };
}
