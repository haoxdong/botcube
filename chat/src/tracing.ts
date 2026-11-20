import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { DeploymentConfig } from 'botcube-deployment-config';
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

/** Export traces as the deploy's OTEL_* variables say, authenticated with the Deployment Config's telemetry credential. */
export function startChatTracing(
  telemetry: DeploymentConfig['telemetry'],
  env: NodeJS.ProcessEnv = process.env,
): { shutdown(): Promise<void>; credential: CredentialSource | undefined } | undefined {
  if (env.OTEL_TRACES_EXPORTER !== 'otlp') return undefined;
  const credential = telemetry.kind === 'otlp' ? telemetry.credential : undefined;
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
