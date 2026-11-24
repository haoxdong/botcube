import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotCubeConfig } from 'botcube-config';
import type { EndpointTls } from 'botcube-config/blocks';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeOpenAICompatible } from '../test/fakes/fake-backends.js';
import { FakeMtlsFront, FakeMtlsProxy, mtlsCertificates, SERVER_IDENTITY, trustCa } from '../test/fakes/mtls.js';
import { turnSummarizer, turnSummaryModel } from './turn-summaries.js';

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

/** The BotCube Config's `models` section for an Endpoint with TLS, at the stand-in's mTLS front. */
function deployed(tls: EndpointTls): BotCubeConfig['integrations']['modelGateway'] {
  return { kind: 'openai-compatible', url, credential: { kind: 'file', path: keyFile }, turnSummaryModel: 'openai:example-summary', tls };
}

const turn = { request: 'Hello, who are you?', answer: 'Echo: Hello, who are you?' };
const summarize = (models: BotCubeConfig['integrations']['modelGateway'], proxy?: BotCubeConfig['integrations']['proxy']) => turnSummarizer(turnSummaryModel(models, {}, 'us-east-1', proxy))(turn);
const SUMMARY = { title: 'Answered a question', summary: 'Replied to the user' };

describe('Turn summaries on a models Endpoint with TLS', () => {
  it('present the client certificate to an Endpoint carrying the expected identity', async () => {
    expect(await summarize(deployed({ clientCertificate: files, serverIdentity: SERVER_IDENTITY }))).toEqual(SUMMARY);

    expect(front.clients).toEqual(['client-a']);
    expect(models.summarizedTurns()).toEqual([turn]);
  });

  it('present a certificate whose files were replaced on the next connection, without a restart', async () => {
    const summarizer = turnSummarizer(turnSummaryModel(deployed({ clientCertificate: files, serverIdentity: SERVER_IDENTITY }), {}, 'us-east-1'));

    await summarizer(turn);
    rotateTo('clientB');
    front.dropConnections();
    await summarizer(turn);

    expect(front.clients).toEqual(['client-a', 'client-b']);
  });

  describe('beside a proxy with TLS', () => {
    let proxy: FakeMtlsProxy;
    let viaProxy: BotCubeConfig['integrations']['proxy'];
    beforeAll(async () => {
      proxy = new FakeMtlsProxy(certificates, 'server', { [new URL(url).host]: Number(new URL(url).port) });
      viaProxy = { kind: 'forward', url: (await proxy.listen()).href, tls: { clientCertificate: certificates.files.clientB, serverIdentity: SERVER_IDENTITY } };
    });
    afterAll(() => proxy.close());
    beforeEach(() => proxy.connections.length = 0);

    it("go through the proxy's relay when the Endpoint names it, presenting the proxy's certificate and the Endpoint's own through the tunnel", async () => {
      const named = { ...deployed({ clientCertificate: files, serverIdentity: SERVER_IDENTITY }), proxy: 'integrations.proxy' } as const;

      expect(await summarize(named, viaProxy)).toEqual(SUMMARY);

      expect([proxy.hosts(), proxy.clients(), front.clients]).toEqual([[new URL(url).host], ['client-b'], ['client-a']]);
    });

    it('go direct when the Endpoint names no proxy', async () => {
      expect(await summarize(deployed({ clientCertificate: files, serverIdentity: SERVER_IDENTITY }), viaProxy)).toEqual(SUMMARY);

      expect([proxy.hosts(), front.clients]).toEqual([[], ['client-a']]);
    });
  });
});
