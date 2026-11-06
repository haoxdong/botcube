import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { NodeSDK } from '@opentelemetry/sdk-node';

let activeTurns: Set<Promise<void>> | undefined;

export function registerTracingTurn(): (() => void) | undefined {
  const pending = activeTurns;
  if (pending === undefined) return undefined;
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  pending.add(done);
  return () => { pending.delete(done); finish?.(); };
}

export function startChatTracing(env: NodeJS.ProcessEnv = process.env): { shutdown(): Promise<void> } | undefined {
  if (env.OTEL_TRACES_EXPORTER !== 'otlp') return undefined;
  const sdk = new NodeSDK({
    serviceName: 'botcube-chat',
    traceExporter: new OTLPTraceExporter(),
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
  return { shutdown: () => shutdown ??= Promise.all([...pending]).then(async () => {
    await sdk.shutdown();
    if (activeTurns === pending) activeTurns = undefined;
  }) };
}
