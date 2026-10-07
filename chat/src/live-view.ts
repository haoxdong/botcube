import { EventType } from '@ag-ui/client';

// A streamed delta may still be growing, so it names a browser Session only once
// whitespace follows the ID; complete text may also end with it.
const SESSION_PARTIAL = /\bSession:\s*([A-Za-z0-9._:-]+)(?=\s)/;
const SESSION_COMPLETE = /\bSession:\s*([A-Za-z0-9._:-]+)(?=$|\s)/;
const SESSION_URL_PARTIAL = /\bhttps?:\/\/[^\s]*bedrock-agentcore[^\s]*\/session\/([A-Za-z0-9._:-]+)(?=[/?#\s])/;
const SESSION_URL_COMPLETE = /\bhttps?:\/\/[^\s]*bedrock-agentcore[^\s]*\/session\/([A-Za-z0-9._:-]+)(?=$|[/?#\s])/;
const BROWSER_CLOSED = /\bbrowser\s+(?:session\s+)?closed\b/i;

type LiveView = { open: true; sessionId: string } | { open: false };

function liveViewFor(text: string, complete: boolean): LiveView | null {
  const match =
    (complete ? SESSION_COMPLETE : SESSION_PARTIAL).exec(text) ??
    (complete ? SESSION_URL_COMPLETE : SESSION_URL_PARTIAL).exec(text);
  const sessionId = match?.[1];
  if (sessionId !== undefined) return { open: true, sessionId };
  return BROWSER_CLOSED.test(text) ? { open: false } : null;
}

/**
 * Watches one Turn's SSE frames for text that opens or closes the agent's browser
 * Session, and answers the CUSTOM events to send right after each frame. Text
 * messages are read whole, at their end, since an ID can span deltas.
 */
export class LiveViewInjector {
  private readonly messages = new Map<unknown, string>();

  constructor(private readonly eventName: string, private initialSessionId?: string) {}

  /** The CUSTOM event frames that follow this frame (its lines, without the blank line). */
  after(lines: string[]): string[] {
    return lines
      .flatMap((line) => (line.startsWith('data: ') ? [this.liveViewForData(line.slice(6))] : []))
      .filter((view): view is LiveView => view !== null)
      .map(
        (value) =>
          `data: ${JSON.stringify({ type: EventType.CUSTOM, name: this.eventName, value })}\n\n`,
      );
  }

  private liveViewForData(data: string): LiveView | null {
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      // Non-JSON data carries no live-view text; the frame itself is still forwarded.
      return null;
    }
    // Any other JSON value destructures to no fields.
    if (event === null) return null;
    const { type, messageId, delta, content } = event as Record<string, unknown>;
    if (type === EventType.RUN_STARTED && this.initialSessionId !== undefined) {
      const sessionId = this.initialSessionId;
      this.initialSessionId = undefined;
      return { open: true, sessionId };
    }
    if (type === EventType.TEXT_MESSAGE_END) {
      // Stryker disable next-line StringLiteral: a message with no text opens nothing, nor does "Stryker was here!"
      const text = this.messages.get(messageId) ?? '';
      this.messages.delete(messageId);
      return liveViewFor(text, true);
    }
    const text = typeof delta === 'string' ? delta : content;
    if (typeof text !== 'string') return null;
    if (type === EventType.TEXT_MESSAGE_CONTENT && typeof messageId === 'string') {
      // Stryker disable next-line StringLiteral: each pattern starts at a word boundary, which "Stryker was here!" ends with, so a prefix before the first delta changes no match
      this.messages.set(messageId, (this.messages.get(messageId) ?? '') + text);
      return null;
    }
    return liveViewFor(text, typeof delta !== 'string');
  }
}
