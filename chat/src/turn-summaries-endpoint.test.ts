import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelsDeployment } from 'botcube-deployment-config/models';
import { errors } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeOpenAICompatible } from '../test/fakes/fake-backends.js';
import { turnSummarizer, turnSummaryModelFromEnv } from './turn-summaries.js';

const API_KEY = 'sk-mounted';
const endpoint = new FakeOpenAICompatible(API_KEY);
const dir = mkdtempSync(join(tmpdir(), 'models-endpoint-'));
const keyFile = join(dir, 'models-api-key');
beforeAll(async () => {
  writeFileSync(keyFile, `${API_KEY}\n`);
  await endpoint.listen();
});
beforeEach(() => {
  endpoint.requests.length = 0;
  endpoint.gatewayFailures.length = 0;
  endpoint.drops.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await endpoint.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The environment the deploy gives the Chat Service for an OpenAI-compatible `models` Endpoint, at the stand-in. */
function deployed(models: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  const config = {
    kind: 'openai-compatible' as const,
    url: `${endpoint.url}/v1`,
    credential: { kind: 'file' as const, path: keyFile },
    headers: { 'x-tenant': 'botcube-example' },
    turnSummaryModel: 'example-summary',
    ...models,
  };
  return { ...modelsDeployment(config)?.chatService };
}

const turn = { request: 'Hello, who are you?', answer: 'Echo: Hello, who are you?' };
const summarize = (env: NodeJS.ProcessEnv) => turnSummarizer(turnSummaryModelFromEnv(env, 'us-east-1'))(turn);

describe('Turn summaries on an OpenAI-compatible models Endpoint', () => {
  it("send the Endpoint's credential as the bearer token, and its headers", async () => {
    expect(await summarize(deployed())).toEqual({ title: 'Answered a question', summary: 'Replied to the user' });

    expect(endpoint.summarizedTurns()).toEqual([turn]);
    expect(endpoint.models()).toEqual(['example-summary']);
    expect(endpoint.requests[0]?.headers).toMatchObject({ authorization: `Bearer ${API_KEY}`, 'x-tenant': 'botcube-example' });
  });

  it('keep working on an Endpoint whose cache markers only the Harness writes', async () => {
    expect(await summarize(deployed({ cacheMarkers: 'claude' }))).toEqual({ title: 'Answered a question', summary: 'Replied to the user' });

    expect(endpoint.summarizedTurns()).toEqual([turn]);
    expect(endpoint.requests[0]?.body).not.toContain('cache_control');
  });

  it.each([502, 503, 504])('retry an HTTP %i before the first byte', async (status) => {
    endpoint.gatewayFailures.push(status, status);

    expect(await summarize(deployed())).toEqual({ title: 'Answered a question', summary: 'Replied to the user' });
    expect(endpoint.requests).toHaveLength(3);
  });

  it('fail after three answers of HTTP 503', async () => {
    endpoint.gatewayFailures.push(503, 503, 503);

    await expect(summarize(deployed())).rejects.toThrow('The summary model answered HTTP 503');
    expect(endpoint.requests).toHaveLength(3);
  });

  it('retry a connection dropped before the response', async () => {
    endpoint.drops.push('before-response', 'before-response');

    expect(await summarize(deployed())).toEqual({ title: 'Answered a question', summary: 'Replied to the user' });
    expect(endpoint.requests).toHaveLength(3);
  });

  it('fail after three dropped connections', async () => {
    endpoint.drops.push('before-response', 'before-response', 'before-response');

    await expect(summarize(deployed())).rejects.toThrow('fetch failed');
    expect(endpoint.requests).toHaveLength(3);
  });

  it('retry a refused connection', async () => {
    const attempts = vi.spyOn(globalThis, 'fetch');

    await expect(summarize(deployed({ url: `${await closedPort()}/v1` }))).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } });
    expect(attempts).toHaveBeenCalledTimes(3);
  });

  it('retry a connect timeout', async () => {
    const attempts = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed', { cause: new errors.ConnectTimeoutError() }));

    await expect(summarize(deployed())).rejects.toMatchObject({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    expect(attempts).toHaveBeenCalledTimes(3);
  });

  it('fail without retrying a connection closed before the response', async () => {
    endpoint.drops.push('closed-before-response');

    await expect(summarize(deployed())).rejects.toMatchObject({ cause: { code: 'UND_ERR_SOCKET' } });
    expect(endpoint.requests).toHaveLength(1);
  });

  it('fail once on a response dropped after it started', async () => {
    endpoint.drops.push('mid-response');

    await expect(summarize(deployed())).rejects.toThrow();
    expect(endpoint.requests).toHaveLength(1);
  });

  it.each([500, 429, 401])('fail on an HTTP %i without retrying', async (status) => {
    endpoint.gatewayFailures.push(status);

    await expect(summarize(deployed())).rejects.toThrow(`The summary model answered HTTP ${status}`);
    expect(endpoint.requests).toHaveLength(1);
  });

  it('fail naming the seam and the source when the credential cannot be read', async () => {
    const path = join(dir, 'absent');
    await expect(summarize(deployed({ credential: { kind: 'file', path } }))).rejects.toThrow(`models credential (file ${path}): ENOENT`);
    expect(endpoint.requests).toEqual([]);
  });

  it('stop at startup on an Endpoint the deploy wrote wrong, naming its variable', () => {
    expect(() => turnSummaryModelFromEnv({ BOTCUBE_MODELS_ENDPOINT: '{"url":"https://models.example.com/v1"}', BOTCUBE_TURN_SUMMARY_MODEL: 'example-summary' }, 'us-east-1'))
      .toThrow('BOTCUBE_MODELS_ENDPOINT: credential: ');
  });

  it('stop at startup on a command credential the deploy did not opt in to', () => {
    const env = deployed({ credential: { kind: 'command', command: ['/usr/local/bin/token-broker'], timeoutSeconds: 30 } });
    expect(() => turnSummaryModelFromEnv(env, 'us-east-1')).toThrow('models credential (command /usr/local/bin/token-broker): a command credential runs only when BOTCUBE_ALLOW_COMMAND_CREDENTIALS=1');
  });
});

async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return `http://127.0.0.1:${address.port}`;
}
