import { defined } from '../test/defined.js';
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { agentCoreUpstream, localAgentUpstream, type Upstream } from './upstream.js';
import { TurnTiming } from './turn-timing.js';
import { relayTurn } from './turn-stream.js';
import { startChatTracing } from './tracing.js';

const exporter = new InMemorySpanExporter();
const processor = new SimpleSpanProcessor({ exporter });
const sdk = new NodeSDK({
  serviceName: 'botcube-chat',
  spanProcessors: [processor],
  idGenerator: new AWSXRayIdGenerator(),
  textMapPropagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new AWSXRayPropagator()] }),
  resourceDetectors: [], logRecordProcessors: [], metricReaders: [],
});
beforeAll(() => sdk.start());
afterAll(() => sdk.shutdown());
beforeEach(() => {
  exporter.reset();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const spans = async () => { await processor.forceFlush(); return exporter.getFinishedSpans(); };
const turn = { body: '{"prompt":"private prompt"}', sessionId: 'session', credentials: ['private credential'],
  saveAgentDocumentEdit: async () => undefined, finished: () => undefined, ended: async () => undefined, failed: () => undefined };
const finished = 'data: {"type":"RUN_FINISHED"}\n\n';
const bytes = (text: string) => new TextEncoder().encode(text);

async function listening(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

it.each(['local', 'agentcore'] as const)('propagates both trace headers over real %s HTTP with traceparent injected before signing', async (kind) => {
  let headers: IncomingHttpHeaders = {};
  const handler: RequestListener = (req, res) => { headers = req.headers; res.end('ok'); };
  const server = createServer(handler);
  const url = `http://${await listening(server)}`;
  const timing = new TurnTiming(performance.now(), 'run', 'session');
  const captured = timing.invokeTraceContext();
  const expected = defined(trace.getSpanContext(captured), 'captured span context');
  const upstream = kind === 'local' ? localAgentUpstream(url)
    : agentCoreUpstream({ arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test', region: 'us-east-1', endpoint: url });
  try {
    const response = await upstream.invoke(turn.body, 'session', { traceContext: captured });
    expect(await response.text()).toBe('ok');
    expect(headers.traceparent).toBe(`00-${expected.traceId}-${expected.spanId}-01`);
    expect(headers['x-amzn-trace-id']).toBe(`Root=1-${expected.traceId.slice(0, 8)}-${expected.traceId.slice(8)};Parent=${expected.spanId};Sampled=1`);
    if (kind === 'agentcore') {
      expect(headers.authorization).toMatch(/SignedHeaders=[^,]*traceparent/);
    }
  } finally {
    timing.finish();
    await close(server);
  }
});

it('keeps concurrent root and invoke spans open until stream drain and exports no content', async () => {
  const unrelated = trace.getTracer('test').startSpan('unrelated');
  const receipt = performance.now() - 10;
  const first = context.with(trace.setSpan(ROOT_CONTEXT, unrelated), () => new TurnTiming(receipt, 'first', 'session', 'private user agent'));
  const second = new TurnTiming(performance.now(), 'second', 'session');
  first.model = 'test-model';
  const contexts: string[] = [];
  const upstream: Upstream = { label: 'Test', invoke: async (_body, _session, init) => {
    contexts.push(defined(trace.getSpanContext(defined(init?.traceContext, 'invocation trace context')), 'invocation span context').traceId);
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(bytes(finished)); controller.close(); } }, { highWaterMark: 0 }));
  } };
  const [a, b] = await Promise.all([relayTurn(upstream, { ...turn, timing: first }), relayTurn(upstream, { ...turn, timing: second })]);
  expect(await spans()).toHaveLength(0);
  expect(contexts[0]).not.toBe(contexts[1]);
  expect(await a.text()).toBe(finished);
  expect(await b.text()).toBe(finished);
  first.finish();
  const exported = await spans();
  expect(exported).toHaveLength(4);
  const roots = exported.filter((span) => span.name === 'Chat Turn');
  expect(roots).toHaveLength(2);
  for (const root of roots) {
    expect(root.parentSpanContext).toBeUndefined();
    expect(root.kind).toBe(SpanKind.SERVER);
    const child = defined(exported.find((span) => span.parentSpanContext?.spanId === root.spanContext().spanId), 'invoke child span');
    expect(child.name).toBe('AgentCore invoke');
    expect(child.kind).toBe(SpanKind.CLIENT);
    expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(child.endTime).toEqual(root.endTime);
    expect(root.attributes['turn.status']).toBe('finished');
    expect(root.events.map((event) => event.name)).toEqual(['invoke', 'firstFrame', 'end']);
  }
  const firstRoot = defined(roots.find((span) => span.attributes['run.id'] === 'first'), 'first Turn root');
  expect(firstRoot.startTime[0] * 1000 + firstRoot.startTime[1] / 1e6).toBeCloseTo(performance.timeOrigin + receipt, 2);
  expect(firstRoot.attributes.model).toBe('test-model');
  const safe = JSON.stringify(exported.map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })));
  expect(safe).not.toContain('private');
});

it.each(['request', 'http', 'stream', 'unexpected'] as const)('ends failed spans once on %s failure', async (failure) => {
  const timing = new TurnTiming(performance.now(), failure, 'session');
  const upstream: Upstream = { label: 'Test', invoke: async () => {
    if (failure === 'request') throw new Error('private error');
    if (failure === 'http') return new Response('private error', { status: 503 });
    return new Response(new ReadableStream({ pull(controller) {
      if (failure === 'stream') controller.error(new Error('private error'));
      else { controller.enqueue(bytes(finished)); controller.close(); }
    } }));
  } };
  if (failure === 'unexpected') vi.spyOn(timing, 'observe').mockImplementation(() => { throw new Error('private unexpected'); });
  const response = await relayTurn(upstream, { ...turn, timing });
  if (failure === 'unexpected') await expect(response.text()).rejects.toThrow('private unexpected');
  else await response.text();
  timing.finish();
  const exported = await spans();
  expect(exported).toHaveLength(2);
  for (const span of exported) expect(span.status.code).toBe(SpanStatusCode.ERROR);
  expect(JSON.stringify(exported.map((span) => ({ attributes: span.attributes, events: span.events, status: span.status })))).not.toContain('private');
});

it('marks a failed end record as an error without changing the timing log outcome', async () => {
  const timing = new TurnTiming(performance.now(), 'end-failure', 'session');
  const response = await relayTurn({ label: 'Test', invoke: async () => new Response(finished) }, {
    ...turn, timing, ended: async () => { throw new Error('private persistence error'); },
  });
  await expect(response.text()).rejects.toThrow('private persistence error');
  const exported = await spans();
  expect(exported).toHaveLength(2);
  expect(exported.every((span) => span.status.code === SpanStatusCode.ERROR)).toBe(true);
  expect(defined(exported.find((span) => span.name === 'Chat Turn'), 'Chat Turn root').attributes['turn.status']).toBe('finished');
});

it('drains a cancelled client before ending spans once', async () => {
  const timing = new TurnTiming(performance.now(), 'cancel', 'session');
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const response = await relayTurn({ label: 'Test', invoke: async () => new Response(new ReadableStream({ async pull(controller) {
    await gate;
    controller.enqueue(bytes(finished));
    controller.close();
  } }, { highWaterMark: 0 })) }, { ...turn, timing });
  const cancelled = defined(response.body, 'stream body').cancel();
  expect(await spans()).toHaveLength(0);
  defined(release, 'drain release')();
  await cancelled;
  timing.finish('gone');
  const exported = await spans();
  expect(exported).toHaveLength(2);
  expect(defined(exported.find((span) => span.name === 'Chat Turn'), 'Chat Turn root').attributes['turn.status']).toBe('gone');
});

it('ends a Turn rejected during preparation without creating an invoke span', async () => {
  const timing = new TurnTiming(performance.now(), 'preparation', 'session');
  timing.mark('requester');
  timing.mark('requester');
  timing.finish();
  const exported = await spans();
  expect(exported).toHaveLength(1);
  expect(defined(exported[0], 'exported span').events.map((event) => event.name)).toEqual(['requester', 'end']);
  expect(defined(exported[0], 'exported span').status.code).toBe(SpanStatusCode.ERROR);
});

it('does not start an exporter unless OTLP traces are explicitly enabled', () => {
  expect(startChatTracing({})).toBeUndefined();
  expect(startChatTracing({ OTEL_TRACES_EXPORTER: 'none' })).toBeUndefined();
});
