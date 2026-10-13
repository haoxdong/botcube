import { EventType } from '@ag-ui/client';

/** Chat's stages of a Turn, in the order they are reached. */
const STAGES = ['requester', 'model', 'admitted', 'payload', 'identity', 'liveView', 'dispatch', 'invoke', 'firstFrame', 'firstToken', 'lastToken', 'end'] as const;
type TurnStage = (typeof STAGES)[number];

const token = ({ type, delta }: Record<string, unknown>): boolean =>
  type === EventType.TEXT_MESSAGE_CONTENT && typeof delta === 'string' && delta.trim() !== '';

/**
 * One Turn's `chat_turn_timing` line: each stage's offset from receipt on Chat's monotonic clock, logged once as the
 * Turn ends. `e2eMs` runs to the last token relayed to the client (End-to-end Latency), else to the end. `userAgent` lets
 * the daily Orchestration Overhead budget leave out the deploy checks' Turns.
 */
export class TurnTiming {
  model: string | undefined;
  private readonly chatMs: Partial<Record<TurnStage, number>> = {};
  private runFinished = false;
  private logged = false;

  constructor(private readonly receipt: number, private readonly runId: string, private readonly sessionId: string,
    private readonly userAgent?: string) {}

  /** Record a stage reached now, or at `at`; a repeat is ignored. */
  mark(stage: TurnStage, at = performance.now()): void {
    this.chatMs[stage] ??= this.offset(at);
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
    if (events.some(({ type }) => type === EventType.RUN_FINISHED)) this.runFinished = true;
  }

  /** Log the Turn once: finished when its RUN_FINISHED was relayed, else failed, or gone when the client went away. */
  finish(status?: 'gone'): void {
    if (this.logged) return;
    this.logged = true;
    this.mark('end');
    const chatMs = Object.fromEntries(STAGES.flatMap((stage) => this.chatMs[stage] === undefined ? [] : [[stage, this.chatMs[stage]]]));
    console.info(JSON.stringify({ event: 'chat_turn_timing', runId: this.runId, sessionId: this.sessionId, userAgent: this.userAgent, model: this.model,
      status: status ?? (this.runFinished ? 'finished' : 'failed'),
      e2eMs: this.chatMs.lastToken ?? this.chatMs.end, chatMs }));
  }
}
