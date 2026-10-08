import type { ServerResponse } from 'node:http';
import { HttpFake, sendJson, type RecordedRequest } from './http-fake.js';

export type UpstreamScript =
  /**
   * 200 SSE: each frame is followed by a blank line; `drop` cuts the connection after them.
   * Frames given as a function are built from the invocation's forwarded props.
   */
  | { kind: 'stream'; frames: string[] | ((forwardedProps: Record<string, unknown>) => string[]); drop?: boolean }
  /** A non-2xx answer; a null body is cut off before it can be read. */
  | { kind: 'error'; status: number; body: string | null };

export interface InvocationPayload {
  threadId: string;
  forwardedProps: Record<string, unknown>;
  [key: string]: unknown;
}

export class FakeAgentCore extends HttpFake {
  private readonly browserControls = new Map<string, string[]>();
  private readonly promptScripts = new Map<string, UpstreamScript>();
  private readonly scripts = new Map<string, UpstreamScript>();
  constructor() {
    super((request, response) => {
      if (request.path.includes('/sessions/streams/update')) {
        const sessionId = new URL(request.path, 'http://localhost').searchParams.get('sessionId') ?? '';
        const controls = this.browserControls.get(sessionId);
        if (!controls) {
          sendJson(response, 404, { message: `Browser session ${sessionId} not found` });
          return;
        }
        const update = JSON.parse(request.body) as { streamUpdate?: { automationStreamUpdate?: { streamStatus?: unknown } } };
        const status = update.streamUpdate?.automationStreamUpdate?.streamStatus;
        if (request.headers['content-type'] !== 'application/json' || typeof status !== 'string') {
          sendJson(response, 400, { message: 'ValidationException: streamUpdate.automationStreamUpdate.streamStatus' });
          return;
        }
        controls.push(status);
        sendJson(response, 200, {});
        return;
      }
      if (!request.path.startsWith('/runtimes/')) {
        sendJson(response, 404, { message: `No runtime route ${request.path}` });
        return;
      }
      const payload = JSON.parse(request.body) as { threadId: string; forwardedProps: Record<string, unknown>; messages: { content: unknown }[] };
      playRuntime(this.scripts.get(payload.threadId) ?? this.promptScripts.get(String(payload.messages.at(-1)?.content)) ?? { kind: 'stream', frames: ['data: {"type":"RUN_STARTED"}', 'data: {"type":"RUN_FINISHED"}'] }, payload.forwardedProps, response);
    });
  }
  startBrowser(): string {
    const sessionId = `fake-browser-${this.browserControls.size + 1}`;
    this.browserControls.set(sessionId, []);
    return sessionId;
  }
  controlChanges(sessionId: string): string[] {
    const controls = this.browserControls.get(sessionId);
    if (!controls) throw new Error(`Browser session ${sessionId} not found`);
    return controls;
  }
  script(threadId: string, script: UpstreamScript): void { this.scripts.set(threadId, script); }
  scriptPrompt(prompt: string, script: UpstreamScript): void { this.promptScripts.set(prompt, script); }
  invocationFor(threadId: string): RecordedRequest & { payload: InvocationPayload } {
    const matches = this.invocations().map((request) => ({ ...request, payload: JSON.parse(request.body) as InvocationPayload })).filter((request) => request.payload.threadId === threadId);
    const invocation = matches[0];
    if (matches.length !== 1 || !invocation) throw new Error(`Expected one invocation for ${threadId}, got ${matches.length}`);
    return invocation;
  }
  invocations(): RecordedRequest[] { return this.requests.filter((request) => request.path.startsWith('/runtimes/')); }
}

export function playRuntime(script: UpstreamScript, forwardedProps: Record<string, unknown>, response: ServerResponse): void {
  if (script.kind === 'error') {
    if (script.body === null) {
      response.writeHead(script.status, { 'content-length': '1000' });
      response.write('{"message":', () => response.socket?.destroy());
      return;
    }
    response.writeHead(script.status, { 'content-type': 'application/json' });
    response.end(script.body);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const frames = typeof script.frames === 'function' ? script.frames(forwardedProps) : script.frames;
  const body = frames.map((frame) => `${frame}\n\n`).join('');
  if (script.drop) {
    response.write(body, () => response.socket?.destroy());
    return;
  }
  response.end(body);
}

