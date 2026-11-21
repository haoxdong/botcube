import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { BotCubeConfig } from 'botcube-config';
import { Agent, type RequestOptions } from 'node:https';
import type { Duplex } from 'node:stream';
import { credentialSource, type CredentialSource } from './credential-source.js';
import { endpointTls, EndpointTlsError, type EndpointTls, type TlsConnectOptions } from './endpoint-tls.js';

let activeTurns: Set<Promise<void>> | undefined;

export function registerTracingTurn(): (() => void) | undefined {
  const pending = activeTurns;
  if (pending === undefined) return undefined;
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  pending.add(done);
  return () => { pending.delete(done); finish?.(); };
}

/** Export traces as the deploy's OTEL_* variables say, with the BotCube Config's telemetry credential and TLS. */
export function startChatTracing(
  telemetry: BotCubeConfig['integrations']['telemetry'],
  env: NodeJS.ProcessEnv = process.env,
): { shutdown(): Promise<void>; credential: CredentialSource | undefined } | undefined {
  if (env.OTEL_TRACES_EXPORTER !== 'otlp') return undefined;
  const otlp = telemetry.kind === 'otlp' ? telemetry : undefined;
  const source = otlp?.credential && credentialSource('telemetry.credential', otlp.credential, { env });
  const transport = otlp?.tls && tlsTransport(endpointTls('telemetry', otlp.tls, { env }), env);
  const sdk = new NodeSDK({
    serviceName: 'botcube-chat',
    // The exporter makes its own agent, which reads no proxy variables unless handed them (BotCube Config `proxy`).
    traceExporter: new OTLPTraceExporter({
      httpAgentOptions: transport?.agent ?? { proxyEnv: env },
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

/**
 * The exporter's agent for an Endpoint with TLS, and `refresh`, which reads its client certificate. The exporter builds
 * its agent once and awaits its headers right before each export's request, which opens a new connection as the agent
 * keeps none alive, so a refresh there presents the certificate as read for that connection; Node's agent opens it
 * directly or through the tunnel of the proxy `env` names. The exporter reports a failed export only to OpenTelemetry's
 * diagnostic logger, which BotCube leaves off, so a refused certificate or identity is logged here.
 */
function tlsTransport(tls: EndpointTls, env: NodeJS.ProcessEnv): { agent: () => Agent; refresh(): Promise<void> } {
  let current: TlsConnectOptions = {};
  class EndpointTlsAgent extends Agent {
    override createConnection(options: RequestOptions, callback?: (error: Error | null, stream: Duplex) => void): Duplex | null | undefined {
      return super.createConnection({ ...options, ...current }, callback);
    }
  }
  return {
    agent: () => new EndpointTlsAgent({ proxyEnv: env, maxCachedSessions: 0 }),
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
