import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { telemetryCredentialFromEnv } from 'botcube-deployment-config/telemetry';
import { credentialSource, type CredentialSource } from './credential-source.js';

let activeTurns: Set<Promise<void>> | undefined;

export function registerTracingTurn(): (() => void) | undefined {
  const pending = activeTurns;
  if (pending === undefined) return undefined;
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  pending.add(done);
  return () => { pending.delete(done); finish?.(); };
}

export function startChatTracing(env: NodeJS.ProcessEnv = process.env): { shutdown(): Promise<void>; credential: CredentialSource | undefined } | undefined {
  if (env.OTEL_TRACES_EXPORTER !== 'otlp') return undefined;
  const credential = telemetryCredentialFromEnv(env);
  const source = credential && credentialSource('telemetry.credential', credential, { env });
  const sdk = new NodeSDK({
    serviceName: 'botcube-chat',
    // The exporter makes its own agent, which reads no proxy variables unless handed them (Deployment Config `proxy`).
    traceExporter: new OTLPTraceExporter({
      httpAgentOptions: { proxyEnv: env },
      ...(source ? { headers: async () => ({ Authorization: `Bearer ${(await source.get()).value}` }) } : {}),
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
