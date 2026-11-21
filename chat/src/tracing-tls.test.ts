import { copyFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { context, propagation, trace } from '@opentelemetry/api';
import type { EndpointTls } from 'botcube-config/blocks';
import { telemetryEnvironment } from 'botcube-config/telemetry';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeMtlsFront, FakeMtlsProxy, IMPOSTOR_IDENTITY, mtlsCertificates, SERVER_IDENTITY, trustCa } from '../test/fakes/mtls.js';
import { endpointTls } from './endpoint-tls.js';
import { startProxyRelay } from './proxy-relay.js';
import { startChatTracing } from './tracing.js';

const certificates = mtlsCertificates();
const files = { certificate: join(certificates.dir, 'telemetry-client.pem'), key: join(certificates.dir, 'telemetry-client.key') };
const rotateTo = (name: 'clientA' | 'clientB') => {
  copyFileSync(certificates.files[name].certificate, files.certificate);
  copyFileSync(certificates.files[name].key, files.key);
};
const exports: Buffer[] = [];
const collector = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    exports.push(Buffer.concat(chunks));
    response.end();
  });
});
let untrust: () => void;
let tracing: ReturnType<typeof startChatTracing>;
beforeAll(async () => {
  untrust = trustCa(certificates.authority);
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
});
afterEach(async () => {
  await tracing?.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  exports.length = 0;
});
afterAll(async () => {
  collector.closeAllConnections();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
  untrust();
  certificates.remove();
});

/** Start the Chat Service's tracing for a BotCube Config whose OTLP Endpoint on `port` has TLS, exporting each span as it ends. */
function startTracing(port: number, tls: EndpointTls, proxyEnv: Record<string, string> = {}): void {
  const telemetry = { kind: 'otlp', url: `https://127.0.0.1:${port}/v1/traces`, tls } as const;
  const env = {
    ...telemetryEnvironment(telemetry).chatService, ...proxyEnv,
    OTEL_BSP_SCHEDULE_DELAY: '1', OTEL_RESOURCE_ATTRIBUTES: '', OTEL_NODE_RESOURCE_DETECTORS: 'none',
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  tracing = startChatTracing(telemetry, process.env);
}

async function exported(span: string): Promise<void> {
  trace.getTracer('test').startSpan(span).end();
  await vi.waitFor(() => expect(exports.some((body) => body.includes(span))).toBe(true));
}

describe('Chat traces to an OTLP Endpoint with TLS', () => {
  const collectorPort = () => (collector.address() as AddressInfo).port;

  it('arrive with the client certificate presented to a collector carrying the expected identity', async () => {
    rotateTo('clientA');
    const front = new FakeMtlsFront(certificates, collectorPort());
    try {
      startTracing(await front.listen(), { clientCertificate: files, serverIdentity: SERVER_IDENTITY });

      await exported('mtls export probe');

      expect(front.clients).toEqual(['client-a']);
    } finally {
      await front.close();
    }
  });

  it('present a certificate whose files were replaced on the next connection, without a restart', async () => {
    rotateTo('clientA');
    const front = new FakeMtlsFront(certificates, collectorPort());
    try {
      startTracing(await front.listen(), { clientCertificate: files, serverIdentity: SERVER_IDENTITY });

      await exported('before rotation');
      rotateTo('clientB');
      front.dropConnections();
      await exported('after rotation');

      expect(front.clients).toEqual(['client-a', 'client-b']);
    } finally {
      await front.close();
    }
  });

  it('are refused by a collector carrying another identity, logging the expected and received identities once', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const front = new FakeMtlsFront(certificates, collectorPort(), 'impostor');
    try {
      startTracing(await front.listen(), { clientCertificate: certificates.files.clientA, serverIdentity: SERVER_IDENTITY });

      trace.getTracer('test').startSpan('refused export probe').end();
      await vi.waitFor(() => expect(errors).toHaveBeenCalled());

      expect(errors.mock.calls).toEqual([[`OTLP export: telemetry TLS: expected server identity ${SERVER_IDENTITY}, but the server presented ${IMPOSTOR_IDENTITY}`]]);
      expect(exports).toEqual([]);
    } finally {
      await front.close();
    }
  });

  it('are refused by a collector whose certificate names another host, with a client certificate and no expected identity', async () => {
    const front = new FakeMtlsFront(certificates, collectorPort());
    try {
      startTracing(await front.listen(), { clientCertificate: certificates.files.clientA });

      trace.getTracer('test').startSpan('hostname probe').end();
      const flushed = tracing?.shutdown();
      tracing = undefined;
      await expect(flushed).rejects.toThrow("Hostname/IP does not match certificate's altnames: IP: 127.0.0.1");

      expect(exports).toEqual([]);
    } finally {
      await front.close();
    }
  });

  it("keep the certificate and identity check through the proxy relay, which presents the proxy's own", async () => {
    const front = new FakeMtlsFront(certificates, collectorPort());
    const port = await front.listen();
    const proxy = new FakeMtlsProxy(certificates, 'server', { [`127.0.0.1:${port}`]: port });
    const relay = await startProxyRelay({
      upstream: await proxy.listen(), listen: { host: '127.0.0.1', port: 0 }, headers: {},
      tls: endpointTls('proxy', { clientCertificate: certificates.files.clientB, serverIdentity: SERVER_IDENTITY }),
    });
    try {
      startTracing(port, { clientCertificate: certificates.files.clientA, serverIdentity: SERVER_IDENTITY }, { HTTPS_PROXY: relay.url, https_proxy: relay.url, NO_PROXY: '', no_proxy: '' });

      await exported('proxied export probe');

      expect([proxy.hosts(), proxy.clients(), front.clients]).toEqual([[`127.0.0.1:${port}`], ['client-b'], ['client-a']]);
    } finally {
      front.dropConnections();
      await Promise.all([front.close(), relay.close(), proxy.close()]);
    }
  });
});
