import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { BotCubeConfig } from 'botcube-config';
import { Agent as HttpAgent, type ProxyEnv } from 'node:http';
import { Agent } from 'node:https';
import { credentialSource, type CredentialSource } from './credential-source.js';
import { endpointTls } from './endpoint-tls.js';
import { proxiedFetch, proxyUrl, type ProxyUrl } from './proxy-relay.js';

/**
 * Export traces as the deploy's OTEL_* variables say, with the BotCube Config's telemetry credential and TLS, through
 * its `proxy` when the telemetry Endpoint names it and direct otherwise.
 */
export function startChatTracing(
  telemetry: BotCubeConfig['integrations']['telemetry'],
  env: NodeJS.ProcessEnv = process.env,
  proxy: BotCubeConfig['integrations']['proxy'] = { kind: 'none' },
): { shutdown(): Promise<void>; credential: CredentialSource | undefined } | undefined {
  if (env.OTEL_TRACES_EXPORTER !== 'otlp') return undefined;
  const otlp = telemetry.kind === 'otlp' ? telemetry : undefined;
  const through = otlp?.proxy && proxyUrl(proxy, env);
  const source = otlp?.credential && credentialSource('telemetry.credential', otlp.credential, { env, fetch: through && proxiedFetch(through) });
  const tls = otlp?.tls && endpointTls('telemetry', otlp.tls, { env });
  const sdk = new NodeSDK({
    serviceName: 'botcube-chat',
    // The exporter builds its agent on its first export, so a proxy's relay starts then.
    traceExporter: new OTLPTraceExporter({
      httpAgentOptions: tls
        ? async () => tls.agent(await through?.(), (error) => console.error(`OTLP export: ${error.message}`))
        : through ? proxiedAgent(through) : {},
      ...(source ? { headers: async () => ({ Authorization: `Bearer ${(await source.get()).value}` }) } : {}),
    }),
    idGenerator: new AWSXRayIdGenerator(),
    textMapPropagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new AWSXRayPropagator()] }),
    instrumentations: [],
    logRecordProcessors: [],
    metricReaders: [],
  });
  sdk.start();
  return { credential: source, shutdown: () => sdk.shutdown() };
}

/** Node's tunnel to the proxy `through` names, for every destination. */
const proxyEnv = async (through: ProxyUrl | undefined): Promise<ProxyEnv> => {
  const { NODE_ENV } = process.env;
  if (through === undefined) return { NODE_ENV };
  const url = await through();
  return { NODE_ENV, HTTP_PROXY: url, HTTPS_PROXY: url };
};

/** The exporter's agent through the proxy `through` names. */
const proxiedAgent = (through: ProxyUrl) => async (protocol: string): Promise<HttpAgent | Agent> =>
  protocol === 'http:' ? new HttpAgent({ proxyEnv: await proxyEnv(through) }) : new Agent({ proxyEnv: await proxyEnv(through) });
