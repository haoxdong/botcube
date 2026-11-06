import { runCompletionError } from './run-outcome.js';
import { contentToText, type RunAgentInput } from '@ag-ui/client';
import { TextMessageContentEventSchema, MessagesSnapshotEventSchema, ToolCallResultEventSchema, RunErrorEventSchema } from '@ag-ui/core/schemas';
import { readTurnEvents } from './turn-events.js';
import { turnCredentialGuard, turnErrorDetails } from './turn-stream.js';

export interface ScheduledRunOutput {
  texts: string[];
  toolResults: string[];
  error: string | null;
}

/** Read a Turn's AG-UI event stream to its end. */
export async function readScheduledRun(response: Response, label: string, credentials: readonly string[], initialMessages: RunAgentInput['messages']): Promise<ScheduledRunOutput> {
  if (!response.ok) {
    return { texts: [], toolResults: [], error: `${label} returned HTTP ${response.status}: ${turnErrorDetails((await response.text()).trim(), credentials)}` };
  }
  const texts = new Map<string, string>();
  let snapshotTexts = new Map<string, string>();
  const toolResults: string[] = [];
  let error: string | null = null;
  let finished = false;
  const withheld: ScheduledRunOutput = { texts: [], toolResults: [], error: "The agent's answer carried the Turn's credentials, so it was withheld" };
  const events = await readTurnEvents(await response.text(), credentials, initialMessages);
  if (events === null) return withheld;
  for (const event of events) {
    switch (event.type) {
      case 'TEXT_MESSAGE_CONTENT': {
        const { messageId, delta } = TextMessageContentEventSchema.parse(event);
        texts.set(messageId, (texts.get(messageId) ?? snapshotTexts.get(messageId) ?? '') + delta);
        break;
      }
      case 'MESSAGES_SNAPSHOT':
        snapshotTexts = currentSnapshotTexts(event, initialMessages.at(-1)?.id);
        break;
      case 'TOOL_CALL_RESULT': {
        const { content } = ToolCallResultEventSchema.parse(event);
        toolResults.push(typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join(''));
        break;
      }
      case 'RUN_ERROR':
        error = RunErrorEventSchema.parse(event).message;
        break;
      case 'RUN_FINISHED':
        finished = true;
        error ??= runCompletionError(event, label);
        break;
    }
  }

  error ??= finished ? null : `${label} stream ended before RUN_FINISHED`;
  const answers = new Map([...snapshotTexts, ...texts]);
  const output = { texts: [...answers.values()].map((text) => text.trim()).filter(Boolean), toolResults, error };
  // The scheduled consumer assembles its own text, independently of client snapshot replacement.
  return turnCredentialGuard(credentials).leaks('', [output]) ? withheld : output;
}

function currentSnapshotTexts(event: unknown, requestMessageId: string | undefined): Map<string, string> {
  const { messages } = MessagesSnapshotEventSchema.parse(event);
  const requestIndex = messages.findIndex((message) => message.id === requestMessageId);
  return new Map(messages.slice(requestIndex === -1 ? messages.length : requestIndex + 1)
    .filter((message) => message.role === 'assistant')
    .map((message) => [message.id, contentToText(message.content)] as const));
}

