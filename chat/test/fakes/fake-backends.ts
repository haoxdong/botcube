import { HttpFake, sendJson } from './http-fake.js';

type SessionOperation = 'get' | 'activity' | 'purge' | 'post';

export type SessionApiEvent =
  | {
      operation: Exclude<SessionOperation, 'activity'>;
      sessionId: string;
      userId: string;
      /** What a `post` adds to the Session as the agent's message. */
      content?: string;
      /** The ID a `post` gives that message. */
      messageId?: string;
      /** The message a `get` names, which the history it reads must hold. */
      contains?: string;
    }
  | { operation: 'activity'; sessions: { sessionId: string; userId: string }[] }
  | { operation: 'memory'; userId: string }
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
  activity: { tasks: [] },
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
      if ('sessionId' in event || 'sessions' in event) {
        if (this.concurrencyLimit !== undefined) {
          if (this.inFlight >= this.concurrencyLimit) {
            sendJson(response, 429, { Reason: 'ConcurrentInvocationLimitExceeded', Type: 'User', message: 'Rate Exceeded.' });
            return;
          }
          this.inFlight += 1;
          await new Promise((resolve) => setTimeout(resolve, SESSION_REPLY_MS));
          this.inFlight -= 1;
        }
        const reply = 'sessions' in event ? this.activityReply(event.sessions) : this.sessionReply(event.operation, event.sessionId);
        sendJson(response, reply.status, reply.body);
        return;
      }
      const lines = this.memories.get(event.userId) ?? [];
      if (event.operation === 'memory') {
        sendJson(response, 200, { lines });
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

  /** A batched `activity`: each Session's scripted tasks, tagged with its ID; the first failing Session's reply fails it. */
  private activityReply(sessions: { sessionId: string }[]): { status: number; body: unknown } {
    const replies = sessions.map(({ sessionId }) => ({ sessionId, reply: this.sessionReply('activity', sessionId) }));
    const failed = replies.find(({ reply }) => reply.status !== 200);
    if (failed !== undefined) return failed.reply;
    const tasks = replies.flatMap(({ sessionId, reply }) =>
      (reply.body as { tasks: object[] }).tasks.map((task) => ({ sessionId, ...task })),
    );
    return { status: 200, body: { tasks } };
  }

  /** Script the Session's reply to `operation`; a batched `activity` answers each of its Sessions' scripted tasks. */
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
