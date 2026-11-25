import type { ServerResponse } from 'node:http';
import type { SessionApiEvent } from '../../src/session-api.js';
import { HttpFake, sendJson } from './http-fake.js';

type SessionEvent = Extract<SessionApiEvent, { sessionId: string }>;
type SessionOperation = SessionEvent['operation'];

/** One record of a user's Extracted Memory and its text. */
export interface MemoryRecord {
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
 * operation and Session ID, and each user's Extracted Memory kept until a `forget` deletes it.
 */
export class FakeSessionApi extends HttpFake {
  private readonly replies = new Map<string, { status: number; body: unknown }>();
  beforePurgeReply: (() => Promise<void>) | undefined;
  /** Each user's Extracted Memory, by user ID. */
  readonly memories = new Map<string, MemoryRecord[]>();
  /** How many `forget` calls to come fail, as an AgentCore error part way through the deletion fails one. */
  failForget = 0;
  /** The User IDs whose `forget` fails, as AgentCore throttling one actor's deletes does, until removed. */
  readonly refuseForget = new Set<string>();
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
      if ('sessionId' in event) await this.answerSession(event, response);
      else this.answerForget(event, response);
    });
  }

  private async answerSession(event: SessionEvent, response: ServerResponse): Promise<void> {
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
  }

  private answerForget(event: Extract<SessionApiEvent, { operation: 'forget' }>, response: ServerResponse): void {
    if (this.failForget > 0 || this.refuseForget.has(event.userId)) {
      if (this.failForget > 0) this.failForget -= 1;
      sendJson(response, 500, { errorMessage: 'Rate exceeded', errorType: 'ThrottlingException' });
      return;
    }
    this.memories.delete(event.userId);
    sendJson(response, 200, {});
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

/** Text content as either wire carries it: a string, or parts each with their text. */
type Content = string | null | undefined | { type: string; text?: string }[];

const contentText = (content: Content) => (typeof content === 'string' ? content : (content ?? []).map(({ text }) => text ?? '').join(''));

interface MessagesRequest {
  model: string;
  messages: { role: string; content: Content }[];
}

/** A Chat Completions request, as an `openai` model sends one unless the gateway's openai provider uses Responses. */
interface ChatCompletionsRequest {
  model: string;
  stream?: boolean;
  messages: { role: string; content: Content }[];
}

/** A Responses request, as an `openai` model sends one when the gateway's openai provider uses Responses. */
interface ResponsesRequest {
  model: string;
  stream?: boolean;
  input: { type?: string; role?: string; content?: Content; output?: string }[];
}

/** The provider API a model request comes on: OpenAI's Chat Completions or Responses, or Anthropic's Messages. */
type ModelsApi = 'chat-completions' | 'responses' | 'messages';

/** A request on either API, as the fake answers it. */
interface ModelCall {
  wire: ModelsApi;
  model: string;
  stream: boolean;
  /** The newest user message's text, which the fake echoes. */
  asked: string | undefined;
  /** The tool results the request carries back, in order. */
  toolResults: string[];
  /** Whether a tool result follows the newest user message: the agent called a tool and sent back its result. */
  toolAnswered: boolean;
}

/** The API each model route serves. */
const WIRES: Readonly<Record<string, ModelsApi>> = { '/v1/chat/completions': 'chat-completions', '/v1/responses': 'responses', '/v1/messages': 'messages' };

function lastAskedIndex(items: ReadonlyArray<{ role?: string }>): number {
  return items.map(({ role }) => role).lastIndexOf('user');
}

/** The request on `wire`, parsed once. */
function modelCall(wire: ModelsApi, body: string): ModelCall {
  if (wire === 'messages') {
    const { model, messages } = JSON.parse(body) as MessagesRequest;
    const lastAsked = lastAskedIndex(messages);
    return {
      wire, model, stream: false,
      asked: lastAsked < 0 ? undefined : contentText(messages[lastAsked]?.content),
      toolResults: [], toolAnswered: false,
    };
  }
  if (wire === 'chat-completions') {
    const { model, stream, messages } = JSON.parse(body) as ChatCompletionsRequest;
    const lastAsked = lastAskedIndex(messages);
    const results = (items: ChatCompletionsRequest['messages']) => items.flatMap(({ role, content }) => (role === 'tool' ? [contentText(content)] : []));
    return {
      wire, model, stream: stream === true,
      asked: lastAsked < 0 ? undefined : contentText(messages[lastAsked]?.content),
      toolResults: results(messages),
      toolAnswered: results(messages.slice(lastAsked + 1)).length > 0,
    };
  }
  const { model, stream, input } = JSON.parse(body) as ResponsesRequest;
  const lastAsked = lastAskedIndex(input);
  const results = (items: ResponsesRequest['input']) => items.flatMap(({ type, output }) => (type === 'function_call_output' ? [output ?? ''] : []));
  return {
    wire, model, stream: stream === true,
    asked: lastAsked < 0 ? undefined : contentText(input[lastAsked]?.content),
    toolResults: results(input),
    toolAnswered: results(input.slice(lastAsked + 1)).length > 0,
  };
}

/** What the model answers, under an id of its own as a gateway gives each answer: text, or a call to a tool with its arguments. */
type Answer = { id: number } & ({ text: string } | { tool: string; callId: string; arguments: string });

/**
 * A model gateway (the BotCube Config's `openai-compatible` models), serving OpenAI's Chat Completions at
 * `<url>/v1/chat/completions` and Responses at `<url>/v1/responses`, and Anthropic's Messages, unstreamed, at `<url>/v1/messages`. It answers as
 * BotCube's echo model does, streamed when asked; with `agentToolCall` set, it first calls that tool, and echoes once the
 * tool's result is back. It accepts only `apiKey` and records every request, headers included.
 */
export class FakeOpenAICompatible extends HttpFake {
  /** The tool the agent's model calls before it answers a user message, and its arguments. */
  agentToolCall: { name: string; arguments: Record<string, unknown> } | undefined;
  /** The statuses the next requests are answered with before any body, as a gateway in front of the models fails. */
  readonly gatewayFailures: number[] = [];
  /** How the next requests' connections drop: reset before any response byte, closed before it, or reset after the response started. */
  readonly drops: ('before-response' | 'closed-before-response' | 'mid-response')[] = [];
  /** The tool calls the next requests ending in a user message are answered with, one each; a tool's result is then echoed as usual. */
  readonly toolCalls: { name: string; arguments: Record<string, unknown> }[] = [];

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
        response.write('{"id":"resp_1","object":"response",', () => response.socket?.resetAndDestroy());
        return;
      }
      const wire = WIRES[request.path];
      if (request.method !== 'POST' || wire === undefined) {
        sendJson(response, 404, { error: { message: `No route ${request.method} ${request.path}` } });
        return;
      }
      if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
        sendJson(response, 401, { error: { message: 'Incorrect API key provided' } });
        return;
      }
      const call = modelCall(wire, request.body);
      const answer = this.answer(call, this.requests.length);
      if (wire === 'messages') {
        sendJson(response, 200, messagesBody(call.model, answer));
        return;
      }
      if (wire === 'chat-completions') {
        if (!call.stream) {
          sendJson(response, 200, { id: `chatcmpl-${answer.id}`, object: 'chat.completion', model: call.model, choices: [{ index: 0, message: chatMessage(answer), finish_reason: 'text' in answer ? 'stop' : 'tool_calls' }] });
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(chatStream(call.model, answer));
        return;
      }
      if (!call.stream) {
        sendJson(response, 200, responsesBody(call.model, answer));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(responsesStream(call.model, answer));
    });
  }

  private answer({ asked, toolAnswered }: ModelCall, id: number): Answer {
    const scripted = toolAnswered ? undefined : this.toolCalls.shift();
    if (scripted !== undefined) return { id, tool: scripted.name, callId: `${scripted.name}-call`, arguments: JSON.stringify(scripted.arguments) };
    if (this.agentToolCall !== undefined && !toolAnswered) {
      return { id, tool: this.agentToolCall.name, callId: `call-${id}`, arguments: JSON.stringify(this.agentToolCall.arguments) };
    }
    return { id, text: `Echo: ${asked ?? ''}` };
  }

  private calls(): ModelCall[] {
    return this.requests.flatMap(({ path, body }) => {
      const wire = WIRES[path];
      return wire === undefined ? [] : [modelCall(wire, body)];
    });
  }

  /** The model each request named, in order. */
  models(): string[] {
    return this.calls().map(({ model }) => model);
  }

  /** The API each model request came on, in order. */
  wires(): ModelsApi[] {
    return this.calls().map(({ wire }) => wire);
  }

  /** The tool results the agent's model requests carried back, in order. */
  toolResults(): string[] {
    return this.calls().flatMap(({ toolResults }) => toolResults);
  }
}

const chatToolCall = ({ callId, tool, arguments: args }: Extract<Answer, { tool: string }>) => ({ id: callId, type: 'function', function: { name: tool, arguments: args } });

function chatMessage(answer: Answer) {
  return 'text' in answer ? { role: 'assistant', content: answer.text } : { role: 'assistant', content: null, tool_calls: [chatToolCall(answer)] };
}

function chatStream(model: string, answer: Answer): string {
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({ id: `chatcmpl-${answer.id}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const delta = 'text' in answer
    ? { role: 'assistant', content: answer.text }
    : { role: 'assistant', content: null, tool_calls: [{ index: 0, ...chatToolCall(answer) }] };
  return `${chunk(delta, null)}${chunk({}, 'text' in answer ? 'stop' : 'tool_calls')}data: [DONE]\n\n`;
}

/** The answer as an unstreamed Messages reply: its text, or its call to a tool. */
function messagesBody(model: string, answer: Answer) {
  const content = 'text' in answer
    ? { type: 'text', text: answer.text }
    : { type: 'tool_use', id: answer.callId, name: answer.tool, input: JSON.parse(answer.arguments) as unknown };
  const stop = 'text' in answer ? 'end_turn' : 'tool_use';
  return { id: `msg_${answer.id}`, type: 'message', role: 'assistant', model, content: [content], stop_reason: stop, usage: { input_tokens: 26, output_tokens: 4 } };
}

const RESPONSES_USAGE = { input_tokens: 26, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 30 };

/** The answer's one output item, finished. */
function responsesItem(answer: Answer) {
  if ('text' in answer) {
    return { id: `msg_${answer.id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', annotations: [], logprobs: [], text: answer.text }] };
  }
  return { id: `fc_${answer.id}`, type: 'function_call', status: 'completed', call_id: answer.callId, name: answer.tool, arguments: answer.arguments };
}

function responsesBody(model: string, answer: Answer, status = 'completed') {
  return { id: `resp_${answer.id}`, object: 'response', created_at: 1_790_965_829, status, model, output: status === 'completed' ? [responsesItem(answer)] : [], usage: status === 'completed' ? RESPONSES_USAGE : null };
}

/** The answer as a Responses event stream: the response, its one output item streamed, then the completed response. */
function responsesStream(model: string, answer: Answer): string {
  const item = responsesItem(answer);
  const events: Record<string, unknown>[] = [{ type: 'response.created', response: responsesBody(model, answer, 'in_progress') }];
  if ('text' in answer) {
    const part = { type: 'output_text', annotations: [], logprobs: [], text: '' };
    const at = { item_id: item.id, output_index: 0, content_index: 0 };
    events.push(
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', ...at, part },
      { type: 'response.output_text.delta', ...at, delta: answer.text, logprobs: [] },
      { type: 'response.output_text.done', ...at, text: answer.text, logprobs: [] },
      { type: 'response.content_part.done', ...at, part: { ...part, text: answer.text } },
    );
  } else {
    events.push(
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: answer.arguments },
      { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: answer.arguments },
    );
  }
  events.push({ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: responsesBody(model, answer) });
  return events.map((event, index) => `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join('');
}
