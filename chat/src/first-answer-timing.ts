import { EventType } from '@ag-ui/client';

const uuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(value);

export class FirstAnswerTiming {
  private identity: { runId: string; sessionId: string; modelId: string } | undefined;
  private readonly starts = new Set<string>();
  private readonly prior = new Set<string>();
  private readonly offsetsMs: Record<string, number> = { receipt: 0 };
  private invalidReason: string | undefined;
  private messageId: string | undefined;
  private logged = false;

  constructor(private readonly receipt: number) {}

  admitted(runId: string, sessionId: string, modelId: string, messages: readonly unknown[]): void {
    if (uuid(runId) && uuid(sessionId) && nativeId(modelId)) this.identity = { runId, sessionId, modelId };
    else this.invalidReason = 'invalid_identity';
    for (const message of messages) {
      if (message !== null && typeof message === 'object' && 'id' in message && nativeId(message.id)) this.prior.add(message.id);
    }
    this.mark('admissionComplete', performance.now());
  }

  invoke(): void { this.mark('invokeDispatch', performance.now()); }

  observe(events: readonly Record<string, unknown>[], readAt: number): void {
    if (this.logged) return;
    for (const event of events) this.observeEvent(event, readAt);
  }

  private observeEvent(event: Record<string, unknown>, readAt: number): void {
    if (event.type === EventType.TEXT_MESSAGE_START) {
      if (!nativeId(event.messageId) || this.starts.has(event.messageId) || this.prior.has(event.messageId) || this.starts.size >= 64) {
        this.invalidReason ??= 'invalid_message_start';
      } else if (event.role === 'assistant') this.starts.add(event.messageId);
    }
    if (event.type !== EventType.TEXT_MESSAGE_CONTENT || typeof event.delta !== 'string' || !event.delta.trim() || this.messageId !== undefined) return;
    if (!nativeId(event.messageId) || !this.starts.has(event.messageId) || this.prior.has(event.messageId)) {
      this.invalidReason ??= 'unmatched_answer';
      return;
    }
    this.messageId = event.messageId;
    this.mark('answerReceived', readAt);
  }

  emitted(events: readonly Record<string, unknown>[]): void {
    if (this.logged || this.messageId === undefined) return;
    if (!events.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT && event.messageId === this.messageId && typeof event.delta === 'string' && event.delta.trim())) return;
    this.mark('answerEmitted', performance.now());
    this.report();
  }

  finish(): void {
    if (!this.logged) { this.invalidReason ??= 'missing_answer_boundary'; this.report(); }
  }

  private mark(phase: string, now: number): void {
    if (phase in this.offsetsMs) { this.invalidReason ??= 'repeated_boundary'; return; }
    const offset = now - this.receipt;
    const previous = Object.values(this.offsetsMs).at(-1) ?? 0;
    if (!Number.isFinite(offset) || offset < previous) this.invalidReason ??= 'unordered_boundary';
    else this.offsetsMs[phase] = offset;
  }

  private report(): void {
    const complete = ['admissionComplete', 'invokeDispatch', 'answerReceived', 'answerEmitted'].every((key) => key in this.offsetsMs);
    console.info(JSON.stringify({ event: 'chat_first_answer_boundary', ...this.identity,
      ...(this.messageId === undefined ? {} : { publicMessageId: this.messageId }), offsetsMs: this.offsetsMs,
      status: complete && this.invalidReason === undefined ? 'complete' : 'invalid',
      ...(this.invalidReason === undefined ? {} : { invalidReason: this.invalidReason }) }));
    this.logged = true;
  }
}
