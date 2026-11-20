import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EndpointTls } from 'botcube-deployment-config/blocks';
import { modelsDeployment } from 'botcube-deployment-config/models';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeOpenAICompatible } from '../test/fakes/fake-backends.js';
import { FakeMtlsFront, FakeMtlsProxy, mtlsCertificates, SERVER_IDENTITY, trustCa } from '../test/fakes/mtls.js';
import { endpointTls } from './endpoint-tls.js';
import { startProxyRelay } from './proxy-relay.js';
import { turnSummarizer, turnSummaryModelFromEnv } from './turn-summaries.js';

const certificates = mtlsCertificates();
const keyFile = join(certificates.dir, 'models-api-key');
const files = { certificate: join(certificates.dir, 'models-client.pem'), key: join(certificates.dir, 'models-client.key') };
const rotateTo = (name: 'clientA' | 'clientB') => {
  copyFileSync(certificates.files[name].certificate, files.certificate);
  copyFileSync(certificates.files[name].key, files.key);
};
const models = new FakeOpenAICompatible('sk-mounted');
let front: FakeMtlsFront;
let url: string;
let untrust: () => void;
beforeAll(async () => {
  untrust = trustCa(certificates.authority);
  writeFileSync(keyFile, 'sk-mounted\n');
  await models.listen();
  front = new FakeMtlsFront(certificates, Number(new URL(models.url).port));
  url = `https://127.0.0.1:${await front.listen()}/v1`;
});
beforeEach(() => {
  rotateTo('clientA');
  front.dropConnections();
  front.clients.length = 0;
  models.requests.length = 0;
});
afterAll(async () => {
  await Promise.all([front.close(), models.close()]);
  untrust();
  certificates.remove();
});

/** The environment the deploy gives the Chat Service for a models Endpoint with TLS, at the stand-in's mTLS front. */
function deployed(tls: EndpointTls): NodeJS.ProcessEnv {
  return { ...modelsDeployment({ kind: 'openai-compatible', url, credential: { kind: 'file', path: keyFile }, turnSummaryModel: 'example-summary', wire: 'chat-completions', tls })?.chatService };
}

const turn = { request: 'Hello, who are you?', answer: 'Echo: Hello, who are you?' };
const summarize = (env: NodeJS.ProcessEnv) => turnSummarizer(turnSummaryModelFromEnv(env, 'us-east-1'))(turn);
const SUMMARY = { title: 'Answered a question', summary: 'Replied to the user' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Turn summaries on a models Endpoint with TLS', () => {
  it('present the client certificate to an Endpoint carrying the expected identity', async () => {
    expect(await summarize(deployed({ clientCertificate: files, serverIdentity: SERVER_IDENTITY }))).toEqual(SUMMARY);

    expect(front.clients).toEqual(['client-a']);
    expect(models.summarizedTurns()).toEqual([turn]);
  });

  it('present a certificate whose files were replaced on the next connection, without a restart', async () => {
    const summarizer = turnSummarizer(turnSummaryModelFromEnv(deployed({ clientCertificate: files, serverIdentity: SERVER_IDENTITY }), 'us-east-1'));

    await summarizer(turn);
    rotateTo('clientB');
    front.dropConnections();
    await summarizer(turn);

    expect(front.clients).toEqual(['client-a', 'client-b']);
  });

  it("go through the proxy relay, which presents the proxy's certificate, and present the Endpoint's own through the tunnel", async () => {
    const proxy = new FakeMtlsProxy(certificates, 'server', { [new URL(url).host]: Number(new URL(url).port) });
    const relay = await startProxyRelay({
      upstream: await proxy.listen(), listen: { host: '127.0.0.1', port: 0 }, headers: {},
      tls: endpointTls('proxy', { clientCertificate: certificates.files.clientB, serverIdentity: SERVER_IDENTITY }),
    });
    try {
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) vi.stubEnv(name, relay.url);
      for (const name of ['NO_PROXY', 'no_proxy']) vi.stubEnv(name, '');

      expect(await summarize({ ...deployed({ clientCertificate: files, serverIdentity: SERVER_IDENTITY }), NODE_USE_ENV_PROXY: '1' })).toEqual(SUMMARY);

      expect([proxy.hosts(), proxy.clients(), front.clients]).toEqual([[new URL(url).host], ['client-b'], ['client-a']]);
    } finally {
      front.dropConnections();
      await Promise.all([relay.close(), proxy.close()]);
    }
  });
});
