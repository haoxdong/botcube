import type { ScheduledRunCard } from '../../src/session-api.js';
import { HttpFake, sendJson } from './http-fake.js';

type SessionOperation = 'get' | 'purge' | 'post';

export type SessionApiEvent =
  | {
      operation: SessionOperation;
      sessionId: string;
      userId: string;
      /** What a `post` adds to the Session as the agent's message. */
      content?: string;
      /** The ID a `post` gives that message. */
      messageId?: string;
      /** The run card a scheduled run's `post` carries. */
      scheduledRun?: ScheduledRunCard;
      /** The message a `get` names, which the history it reads must hold. */
      contains?: string;
    }
  | { operation: 'memory'; userId: string }
  | { operation: 'memory-add'; userId: string; text: string }
  | { operation: 'memory-edit'; userId: string; recordId: string; text: string }
  | { operation: 'memory-delete'; userId: string; recordId: string };

/** One line of a user's Memory document: a memory record and its text. */
export interface MemoryLine {
  id: string;
  text: string;
}

/** How long a Session reply takes while the fake throttles: long enough for concurrent reads to overlap. */
const SESSION_REPLY_MS = 20;

const EMPTY_REPLIES: Record<SessionOperation, unknown> = {
  get: { messages: [] },
  purge: {},
  post: {},
};

/**
 * The session API's local HTTP mode: `POST /invocations`; Session replies scripted per
 * operation and Session ID, and each user's Memory lines kept, edited, and deleted in memory.
 */
export class FakeSessionApi extends HttpFake {
  private readonly replies = new Map<string, { status: number; body: unknown }>();
  beforePurgeReply: (() => Promise<void>) | undefined;
  /** Each user's Memory, by user ID. */
  readonly memories = new Map<string, MemoryLine[]>();
  /**
   * Session operations at once beyond this are throttled, as the deployed function's account
   * concurrency throttles them: HTTP 429. While it is set, each Session reply takes SESSION_REPLY_MS.
   */
  concurrencyLimit: number | undefined;
  private inFlight = 0;

  constructor() {
    super(async (request, response) => {
      const event = JSON.parse(request.body) as SessionApiEvent;
      if (event.operation === 'purge') await this.beforePurgeReply?.();
      if ('sessionId' in event) {
        if (this.concurrencyLimit !== undefined) {
          if (this.inFlight >= this.concurrencyLimit) {
            sendJson(response, 429, { Reason: 'ConcurrentInvocationLimitExceeded', Type: 'User', message: 'Rate Exceeded.' });
            return;
          }
          this.inFlight += 1;
          await new Promise((resolve) => setTimeout(resolve, SESSION_REPLY_MS));
          this.inFlight -= 1;
        }
        const reply = this.sessionReply(event.operation, event.sessionId);
        sendJson(response, reply.status, reply.body);
        return;
      }
      const lines = this.memories.get(event.userId) ?? [];
      if (event.operation === 'memory') {
        sendJson(response, 200, { lines });
        return;
      }
      if (event.operation === 'memory-add') {
        const line = { id: `pending:pending-memory-20261024:event-${lines.length}`, text: event.text };
        lines.unshift(line);
        this.memories.set(event.userId, lines);
        sendJson(response, 200, { line });
        return;
      }
      const line = lines.find(({ id }) => id === event.recordId);
      if (line === undefined) {
        sendJson(response, 404, { error: `Memory has no line ${event.recordId}`, code: 'MEMORY_LINE_NOT_FOUND' });
        return;
      }
      if (event.operation === 'memory-edit') line.text = event.text;
      else lines.splice(lines.indexOf(line), 1);
      sendJson(response, 200, {});
    });
  }

  private sessionReply(operation: SessionOperation, sessionId: string): { status: number; body: unknown } {
    return this.replies.get(`${operation} ${sessionId}`) ?? { status: 200, body: EMPTY_REPLIES[operation] };
  }

  /** Script the Session's reply to `operation`. */
  reply(sessionId: string, status: number, body: unknown, operation: SessionOperation = 'get'): void {
    this.replies.set(`${operation} ${sessionId}`, { status, body });
  }

  events(): SessionApiEvent[] {
    return this.requests.map((request) => JSON.parse(request.body) as SessionApiEvent);
  }
}

/** What the fake summary model answers for a finished Turn: a title and a one-line summary, or a 500. */
export type TurnSummaryAnswer = { title: string; summary: string } | 'fail';

/** A Bedrock Converse request, as the Chat Service sends one with a forced tool. */
interface ConverseRequest {
  messages: { content: { text: string }[] }[];
  toolConfig: { toolChoice: { tool: { name: string } } };
}

const converse = (request: { body: string }) => JSON.parse(request.body) as ConverseRequest;
const forcedTool = (request: { body: string }) => converse(request).toolConfig.toolChoice.tool.name;
const prompt = (request: { body: string }) => converse(request).messages[0]?.content[0]?.text ?? '{}';

/**
 * The Bedrock Converse endpoint the Chat Service's models are called at. It answers a
 * finished Turn's summary with `turnSummary`, and records every request.
 */
export class FakeBedrock extends HttpFake {
  turnSummary: TurnSummaryAnswer = { title: 'Answered a question', summary: 'Replied to the user' };

  constructor() {
    super((request, response) => {
      const tool = forcedTool(request);
      if (this.turnSummary === 'fail') {
        sendJson(response, 500, { message: `fake ${tool} model failure` });
        return;
      }
      sendJson(response, 200, {
        output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: `${tool}-1`, name: tool, input: this.turnSummary } }] } },
        stopReason: 'tool_use',
      });
    });
  }

  /** The finished Turns sent for a summary, as the summary prompt carries them. */
  summarizedTurns(): { request: string; answer: string }[] {
    return this.requests
      .filter((request) => forcedTool(request) === 'turn_summary')
      .map((request) => JSON.parse(prompt(request)) as { request: string; answer: string });
  }
}

/** The newest user message, which a fake answers. */
function lastUserMessage(messages: ChatCompletionsRequest['messages']): ChatCompletionsRequest['messages'][number] | undefined {
  return [...messages].reverse().find(({ role }) => role === 'user');
}

/** A chat completions request, as the Harness's agent model and the Chat Service's summary model send one. */
interface ChatCompletionsRequest {
  model: string;
  stream?: boolean;
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
  tool_choice?: { type: 'function'; function: { name: string } };
}

const completionText = (content: ChatCompletionsRequest['messages'][number]['content']) =>
  typeof content === 'string' ? content : content.map(({ text }) => text ?? '').join('');

/**
 * An OpenAI-compatible endpoint (the Deployment Config's `openai-compatible` models), at `<url>/v1`: it answers a
 * forced `turn_summary` with `turnSummary`, and any other request as BotCube's echo model does, streamed when asked.
 * It accepts only `apiKey` and records every request, headers included.
 */
export class FakeOpenAICompatible extends HttpFake {
  turnSummary: TurnSummaryAnswer = { title: 'Answered a question', summary: 'Replied to the user' };
  /** The statuses the next requests are answered with before any body, as a gateway in front of the models fails. */
  readonly gatewayFailures: number[] = [];
  /** How the next requests' connections drop: reset before any response byte, closed before it, or reset after the response started. */
  readonly drops: ('before-response' | 'closed-before-response' | 'mid-response')[] = [];

  constructor(readonly apiKey: string) {
    super((request, response) => {
      const failure = this.gatewayFailures.shift();
      if (failure !== undefined) {
        sendJson(response, failure, { error: { message: `fake gateway HTTP ${failure}` } });
        return;
      }
      const drop = this.drops.shift();
      if (drop === 'before-response') {
        response.socket?.resetAndDestroy();
        return;
      }
      if (drop === 'closed-before-response') {
        response.socket?.end();
        return;
      }
      if (drop === 'mid-response') {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1024' });
        response.write('{"id":"chatcmpl-1","object":"chat.completion",', () => response.socket?.resetAndDestroy());
        return;
      }
      if (request.method !== 'POST' || request.path !== '/v1/chat/completions') {
        sendJson(response, 404, { error: { message: `No route ${request.method} ${request.path}` } });
        return;
      }
      if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
        sendJson(response, 401, { error: { message: 'Incorrect API key provided' } });
        return;
      }
      const body = JSON.parse(request.body) as ChatCompletionsRequest;
      const tool = body.tool_choice?.function.name;
      if (tool !== undefined) {
        if (this.turnSummary === 'fail') {
          sendJson(response, 500, { error: { message: `fake ${tool} model failure` } });
          return;
        }
        const call = { id: `${tool}-1`, type: 'function', function: { name: tool, arguments: JSON.stringify(this.turnSummary) } };
        sendJson(response, 200, { id: 'chatcmpl-1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }] });
        return;
      }
      const asked = lastUserMessage(body.messages);
      const content = `Echo: ${asked === undefined ? '' : completionText(asked.content)}`;
      if (!body.stream) {
        sendJson(response, 200, { id: 'chatcmpl-1', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
        return;
      }
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`${chunk({ role: 'assistant', content }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
    });
  }

  /** The model each request named, in order. */
  models(): string[] {
    return this.requests.map((request) => (JSON.parse(request.body) as ChatCompletionsRequest).model);
  }

  /** The finished Turns sent for a summary, as the summary prompt carries them. */
  summarizedTurns(): { request: string; answer: string }[] {
    return this.requests
      .map((request) => JSON.parse(request.body) as ChatCompletionsRequest)
      .filter(({ tool_choice }) => tool_choice?.function.name === 'turn_summary')
      .map(({ messages }) => JSON.parse(completionText(lastUserMessage(messages)?.content ?? '{}')) as { request: string; answer: string });
  }
}
