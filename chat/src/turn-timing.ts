import { runFinishedOutcome } from './run-outcome.js';
import { registerTracingTurn } from './tracing.js';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context, type Span } from '@opentelemetry/api';
import { EventType } from '@ag-ui/client';

/** Chat's stages of a Turn, in the order they are reached. */
const STAGES = ['requester', 'model', 'admitted', 'payload', 'identity', 'liveView', 'warmupWaitStart', 'warmupWaitEnd', 'dispatch', 'invoke', 'firstFrame', 'firstToken', 'lastToken', 'end'] as const;
type TurnStage = (typeof STAGES)[number];

const token = ({ type, delta }: Record<string, unknown>): boolean =>
  (type === EventType.TEXT_MESSAGE_CONTENT || type === EventType.TEXT_MESSAGE_CHUNK) && typeof delta === 'string' && delta.trim() !== '';

/**
 * One Turn's `chat_turn_timing` line: each stage's offset from receipt on Chat's monotonic clock, logged once as the
 * Turn ends. `e2eMs` runs to the last token relayed to the client (End-to-end Latency), else to the end. `userAgent` lets
 * the daily Orchestration Overhead budget leave out the deploy checks' Turns.
 */
export class TurnTiming {
  model: string | undefined;
  readonly traceContext: Context;
  private readonly span: Span;
  private readonly tracedTurnFinished = registerTracingTurn();
  private invokeSpan: Span | undefined;
  private invokeContext: Context | undefined;
  private readonly chatMs: Partial<Record<TurnStage, number>> = {};
  private status: 'finished' | 'failed' | 'stopped' = 'failed';
  private logged = false;

  constructor(private readonly receipt: number, private readonly runId: string, private readonly sessionId: string,
    private readonly userAgent?: string) {
    this.span = trace.getTracer('botcube-chat').startSpan('Chat Turn', {
      kind: SpanKind.SERVER,
      startTime: performance.timeOrigin + receipt,
      attributes: { 'run.id': runId, 'session.id': sessionId },
    }, ROOT_CONTEXT);
    this.traceContext = trace.setSpan(ROOT_CONTEXT, this.span);
  }

  invokeTraceContext(): Context {
    if (this.invokeContext === undefined) {
      this.invokeSpan = trace.getTracer('botcube-chat').startSpan('AgentCore invoke', { kind: SpanKind.CLIENT }, this.traceContext);
      this.invokeContext = trace.setSpan(this.traceContext, this.invokeSpan);
    }
    return this.invokeContext;
  }

  fail(): void {
    this.span.setStatus({ code: SpanStatusCode.ERROR });
    this.invokeSpan?.setStatus({ code: SpanStatusCode.ERROR });
  }

  /** Record a stage reached now, or at `at`; a repeat is ignored. */
  mark(stage: TurnStage, at = performance.now()): void {
    if (this.chatMs[stage] !== undefined) return;
    this.chatMs[stage] = this.offset(at);
    this.span.addEvent(stage, performance.timeOrigin + at);
  }

  private offset(at: number): number {
    return Math.round((at - this.receipt) * 10) / 10;
  }

  /** Upstream events read at `readAt`. */
  observe(events: readonly Record<string, unknown>[], readAt: number): void {
    this.mark('firstFrame', readAt);
    if (events.some(token)) this.mark('firstToken', readAt);
  }

  /** Events enqueued to the client. */
  emitted(events: readonly Record<string, unknown>[]): void {
    if (events.some(token)) {
      this.chatMs.lastToken = this.offset(performance.now());
    }
    for (const event of events) {
      if (event.type === EventType.RUN_FINISHED) this.status = runFinishedOutcome(event) === 'success' ? 'finished' : 'failed';
      if (event.type === EventType.RUN_ERROR) this.status = event.code === 'TURN_STOPPED' ? 'stopped' : 'failed';
    }
  }

  finish(status?: 'gone'): void {
    if (this.logged) return;
    this.logged = true;
    this.mark('end');
    const outcome = status ?? this.status;
    this.span.setAttribute('turn.status', outcome);
    if (this.model !== undefined) this.span.setAttribute('model', this.model);
    if (outcome === 'failed') {
      this.fail();
    }
    const end = performance.timeOrigin + performance.now();
    this.invokeSpan?.end(end);
    this.span.end(end);
    this.tracedTurnFinished?.();
    const chatMs = Object.fromEntries(STAGES.flatMap((stage) => this.chatMs[stage] === undefined ? [] : [[stage, this.chatMs[stage]]]));
    console.info(JSON.stringify({ event: 'chat_turn_timing', runId: this.runId, sessionId: this.sessionId, userAgent: this.userAgent, model: this.model,
      status: outcome,
      e2eMs: this.chatMs.lastToken ?? this.chatMs.end, chatMs }));
  }
}
