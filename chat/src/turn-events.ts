import { runHttpRequest, transformChunks, transformHttpEventStream, type BaseEvent } from '@ag-ui/client';
import { createParser } from 'eventsource-parser';
import { turnCredentialGuard } from './turn-stream.js';

/** Non-relay consumers can decode events; the relay must preserve the wire text. */
export async function readTurnEvents(stream: string, credentials: readonly string[], initialMessages: readonly unknown[] = []): Promise<BaseEvent[] | null> {
  const guard = turnCredentialGuard(credentials, initialMessages);
  if (guard.leaks(stream, [])) return null;
  const frames: string[] = [];
  const discarded = { malformed: false };
  const parser = createParser({ onEvent({ data }) {
    try {
      JSON.parse(data);
    } catch {
      discarded.malformed = true;
      return;
    }
    frames.push(`data: ${data.replace(/\n/g, '\ndata: ')}\n\n`);
  } });
  parser.feed(stream);
  if (discarded.malformed && frames.length === 0) throw new SyntaxError('The Runtime sent an invalid AG-UI event stream');
  const response = new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } });
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    let withheld = false;
    transformHttpEventStream(runHttpRequest(async () => response)).pipe(transformChunks()).subscribe({
      next(event) {
        if (guard.leaks('', [event])) {
          withheld = true;
        } else {
          events.push(event);
        }
      },
      // Parser and chunk errors can quote their input, including escaped credentials.
      error() { reject(new SyntaxError('The Runtime sent an invalid AG-UI event stream')); },
      complete() { resolve(withheld ? null : events); },
    });
  });
}
