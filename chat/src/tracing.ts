import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { BotCubeConfig } from 'botcube-config';
import { Agent as HttpAgent, type ProxyEnv } from 'node:http';
import { Agent, type RequestOptions } from 'node:https';
import type { Duplex } from 'node:stream';
import { credentialSource, type CredentialSource } from './credential-source.js';
import { endpointTls, EndpointTlsError, type EndpointTls, type TlsConnectOptions } from './endpoint-tls.js';
import { proxyUrl, type ProxyUrl } from './proxy-relay.js';

let activeTurns: Set<Promise<void>> | undefined;

export function registerTracingTurn(): (() => void) | undefined {
  const pending = activeTurns;
  if (pending === undefined) return undefined;
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  pending.add(done);
  return () => { pending.delete(done); finish?.(); };
}

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
  const source = otlp?.credential && credentialSource('telemetry.credential', otlp.credential, { env });
  const through = otlp?.proxy && proxyUrl(proxy, env);
  const transport = otlp?.tls && tlsTransport(endpointTls('telemetry', otlp.tls, { env }), through);
  const sdk = new NodeSDK({
    serviceName: 'botcube-chat',
    // The exporter builds its agent on its first export, so a proxy's relay starts then.
    traceExporter: new OTLPTraceExporter({
      httpAgentOptions: transport?.agent ?? (through ? proxiedAgent(through) : {}),
      ...(source || transport ? {
        headers: async (): Promise<Record<string, string>> => {
          await transport?.refresh();
          return source ? { Authorization: `Bearer ${(await source.get()).value}` } : {};
        },
      } : {}),
    }),
    idGenerator: new AWSXRayIdGenerator(),
    textMapPropagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new AWSXRayPropagator()] }),
    instrumentations: [],
    logRecordProcessors: [],
    metricReaders: [],
  });
  sdk.start();
  const pending = new Set<Promise<void>>();
  activeTurns = pending;
  let shutdown: Promise<void> | undefined;
  return {
    credential: source,
    shutdown: () => shutdown ??= Promise.all([...pending]).then(async () => {
      await sdk.shutdown();
      if (activeTurns === pending) activeTurns = undefined;
    }),
  };
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

/**
 * The exporter's agent for an Endpoint with TLS, and `refresh`, which reads its client certificate. The exporter builds
 * its agent once and awaits its headers right before each export's request, which opens a new connection as the agent
 * keeps none alive, so a refresh there presents the certificate as read for that connection; Node's agent opens it
 * directly or through the tunnel of the proxy `through` names. The exporter reports a failed export only to OpenTelemetry's
 * diagnostic logger, which BotCube leaves off, so a refused certificate or identity is logged here.
 */
function tlsTransport(tls: EndpointTls, through: ProxyUrl | undefined): { agent: () => Promise<Agent>; refresh(): Promise<void> } {
  let current: TlsConnectOptions = {};
  class EndpointTlsAgent extends Agent {
    override createConnection(options: RequestOptions, callback?: (error: Error | null, stream: Duplex) => void): Duplex | null | undefined {
      return super.createConnection({ ...options, ...current }, callback);
    }
  }
  return {
    agent: async () => new EndpointTlsAgent({ proxyEnv: await proxyEnv(through), maxCachedSessions: 0 }),
    async refresh() {
      const { checkServerIdentity, ...certificate } = await tls.connectOptions().catch((error: unknown) => {
        if (error instanceof EndpointTlsError) console.error(`OTLP export: ${error.message}`);
        throw error;
      });
      current = { ...certificate, ...(checkServerIdentity ? { checkServerIdentity: loggingRefusal(checkServerIdentity) } : {}) };
    },
  };
}

function loggingRefusal(check: NonNullable<TlsConnectOptions['checkServerIdentity']>): NonNullable<TlsConnectOptions['checkServerIdentity']> {
  return (host, certificate) => {
    const refused = check(host, certificate);
    if (refused) console.error(`OTLP export: ${refused.message}`);
    return refused;
  };
}
