import { runFinishedOutcome } from './run-outcome.js';
import type { TurnTiming } from './turn-timing.js';
import { AbstractAgent, CompatibilityBoundary, EventType, transformChunks, type BaseEvent } from '@ag-ui/client';
import { Subject } from 'rxjs';
import { applyPatch, type Operation } from 'fast-json-patch';
import { AGENT_DOCUMENT_EDITED } from './agent-documents.js';
import { LiveViewInjector } from './live-view.js';
import type { TurnFailure } from './session-metadata.js';
import type { Upstream } from './upstream.js';

const encoder = new TextEncoder();
/**
 * An SSE comment the relay sends after each quiet `KEEPALIVE_MS`: Cloudflare cuts a stream that sends nothing
 * for 125 s. The interval is the SSE spec's suggestion for proxies that drop idle connections.
 */
const KEEPALIVE = encoder.encode(': keepalive\n\n');
const KEEPALIVE_MS = 15_000;

function reason(error: unknown): string {
  if (error instanceof Error && error.cause !== undefined) return `${error.message}: ${reason(error.cause)}`;
  return String(error);
}

function decoded(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  } catch {
    return {};
  }
}

/** SSE joins all of a frame's data fields with a newline before decoding JSON. */
export function sseFrameData(lines: readonly string[]): string | null {
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
  return data.length === 0 ? null : data.join('\n');
}

export function turnCredentials(forwardedProps: Record<string, unknown>, credentialProps: readonly string[]): string[] {
  const files = forwardedProps.files as Record<string, unknown> | null | undefined;
  const filesKeys = files !== null && typeof files === 'object' && !Array.isArray(files)
    ? [files.accessKeyId, files.secretAccessKey, files.sessionToken]
    : [];
  const props = [...credentialProps.map((prop) => forwardedProps[prop]), forwardedProps.turnIdentity];
  const queryValues = props.flatMap((value) =>
    typeof value === 'string' && URL.canParse(value) ? [...new URL(value).searchParams.values()] : [],
  );
  return [...filesKeys, ...props, ...queryValues].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
}

function credentialQueryTokens(credentials: readonly string[]) {
  return credentials
    .filter((credential) => URL.canParse(credential))
    .map((credential) => new URL(credential).searchParams.get('token'))
    .filter((token): token is string => token !== null && token !== '');
}

function encodedQueryTokens(text: string) {
  // Stryker disable next-line ArrayDeclaration: The inserted fallback value lacks a percent sign and is removed by the filter.
  return (text.match(/[A-Za-z0-9._~%+-]+/g) ?? []).filter((value) => value.includes('%'));
}

const queryToken = (value: string) => new URLSearchParams(`token=${value}`).get('token') ?? '';

function encodedQueryPrefix(text: string, tokens: readonly string[]) {
  let length = 0;
  for (const token of tokens) {
    for (const value of encodedQueryTokens(text)) {
      if (!text.endsWith(value)) continue;
      for (let candidate = Math.min(value.length, token.length * 3); candidate > length; candidate--) {
        const suffix = value.slice(-candidate);
        const prefix = queryToken(suffix.replace(/%(?:[0-9a-f])?$/i, ''));
        if (prefix.length < token.length && token.startsWith(prefix)) {
          length = candidate;
          break;
        }
      }
    }
  }
  return text.slice(text.length - length);
}

function credentialPrefix(text: string, credentials: readonly string[]) {
  let length = 0;
  for (const credential of credentials) {
    for (let candidate = Math.min(text.length, credential.length - 1); candidate > length; candidate--) {
      if (text.endsWith(credential.slice(0, candidate))) {
        length = candidate;
        break;
      }
    }
  }
  length = Math.max(length, encodedQueryPrefix(text, credentialQueryTokens(credentials)).length);
  const limit = Math.max(0, ...credentials.map((credential) => credential.length)) * 3;
  const url = matchingCredentialUrls(text, credentials, (supplied, expected) => {
    const prefix = supplied.replace(/%(?:[0-9a-f])?$/i, '');
    return prefix.length < expected.length && expected.startsWith(prefix);
  }).find((value) => text.endsWith(value) && value.length <= limit) ?? '';
  return text.slice(text.length - Math.max(url.length, length));
}

function matchingCredentialUrls(
  text: string,
  credentials: readonly string[],
  acceptsToken: (supplied: string, expected: string) => boolean,
) {
  return text.match(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi)?.filter((value) => {
    if (!URL.canParse(value)) return false;
    const candidate = new URL(value);
    return credentials.some((credential) => {
      if (!URL.canParse(credential)) return false;
      const expected = new URL(credential);
      const token = expected.searchParams.get('token');
      const supplied = candidate.searchParams.get('token');
      return token !== null && token !== '' && candidate.origin === expected.origin &&
        candidate.pathname === expected.pathname && supplied !== null && acceptsToken(supplied, token);
    });
  }) ?? [];
}

function decodedLeaks(value: unknown, credentials: readonly string[]): boolean {
  if (typeof value === 'string') return credentials.some((credential) => value.includes(credential)) ||
    matchingCredentialUrls(value, credentials, (supplied, expected) => supplied === expected).length !== 0 ||
    encodedQueryTokens(value).some((candidate) => credentialQueryTokens(credentials).some((token) => queryToken(candidate).includes(token)));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, part]) => decodedLeaks(key, credentials) || decodedLeaks(part, credentials));
  }
  return false;
}

function deltaIdentity({ type, messageId, toolCallId }: Record<string, unknown>) {
  const toolTypes: readonly unknown[] = [EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END];
  const tool = toolTypes.includes(type);
  const identity = tool ? toolCallId : messageId;
  return `${tool ? 'tool' : 'message'}:${typeof identity === 'string' ? identity : ''}`;
}

function snapshotDeltas(message: Record<string, unknown>): Record<string, unknown>[] {
  const { id, content, toolCalls } = message;
  return [
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: content },
    ...recordValues(toolCalls).map((call) => {
      const tool = call as { id: unknown; function?: { arguments?: unknown } };
      return { type: EventType.TOOL_CALL_ARGS, toolCallId: tool.id, delta: tool.function?.arguments };
    }),
  ];
}

interface ToolJSON { quoted: boolean; escape: string }

function decodedToolArguments(text: string, state: ToolJSON) {
  let decoded = '';
  for (const character of text) {
    if (state.escape !== '') {
      state.escape += character;
      if (state.escape === '\\u' || (/^\\u[0-9a-f]{0,3}$/i).test(state.escape)) continue;
      const simple: Record<string, string> = { '\\"': '"', '\\\\': '\\', '\\/': '/', '\\b': '\b', '\\f': '\f', '\\n': '\n', '\\r': '\r', '\\t': '\t' };
      decoded += (/^\\u[0-9a-f]{4}$/i).test(state.escape)
        ? String.fromCharCode(Number.parseInt(state.escape.slice(2), 16))
        : (simple[state.escape] ?? state.escape);
      state.escape = '';
    } else if (state.quoted && character === '\\') {
      state.escape = character;
    } else {
      if (character === '"') state.quoted = !state.quoted;
      decoded += character;
    }
  }
  return decoded;
}

interface MessageBuffer {
  id: string;
  role: string;
  tools: string[];
  prefix: string;
  toolPrefixes: Map<string, string>;
  toolJSON?: Map<string, ToolJSON>;
  activity?: unknown;
}

interface PrefixState {
  candidates: Map<string, string>;
  pending: Set<string>;
  roles: Map<string, string>;
  activities: Map<string, unknown>;
  tools: Set<string>;
  order: MessageBuffer[];
  toolJSON: Map<string, ToolJSON>;
}

function recordValues(messages: unknown) {
  return Array.isArray(messages) ? messages.filter((value: unknown) => value !== null && typeof value === 'object') as Record<string, unknown>[] : [];
}

function messageBuffer(message: Record<string, unknown>, credentials: readonly string[]) {
  const deltas = snapshotDeltas(message);
  const tools = deltas.filter((event) => event.type === EventType.TOOL_CALL_ARGS).map((event) => String(event.toolCallId));
  const toolPrefixes = new Map<string, string>();
  const toolJSON = new Map<string, ToolJSON>();
  for (const event of deltas) {
    if (event.type === EventType.TOOL_CALL_ARGS && !toolPrefixes.has(String(event.toolCallId))) {
      const json = { quoted: false, escape: '' };
      const value = typeof event.delta === 'string' ? decodedToolArguments(event.delta, json) : '';
      toolJSON.set(String(event.toolCallId), json);
      toolPrefixes.set(String(event.toolCallId), credentialPrefix(value, credentials));
    }
  }
  return {
    id: String(message.id), role: String(message.role), tools,
    prefix: typeof message.content === 'string' ? credentialPrefix(message.content, credentials) : '', toolPrefixes, toolJSON,
    ...(message.role === 'activity' ? { activity: structuredClone(message.content) } : {}),
  };
}

function restoreSnapshotTools(entry: MessageBuffer, state: PrefixState) {
  if (entry.role !== 'assistant') return;
  for (const [id, prefix] of entry.toolPrefixes) {
    if (state.tools.has(id)) continue;
    state.tools.add(id);
    const json = entry.toolJSON?.get(id);
    if (json !== undefined) state.toolJSON.set(`tool:${id}`, json);
    retainPrefix(`tool:${id}`, prefix, state);
    if (json !== undefined && json.escape !== '') state.pending.add(`tool:${id}`);
  }
}

function replaceSnapshot(messages: unknown, state: PrefixState, credentials: readonly string[]) {
  const values = recordValues(messages);
  const incoming = new Map(values.map((message) => [message.id, message]));
  const preserveReasoning = !values.some(({ role }) => role === 'reasoning');
  const preserve = (entry: MessageBuffer) => entry.role === 'activity' || (preserveReasoning && entry.role === 'reasoning');
  const existing = state.order.filter((entry) => preserve(entry) || incoming.has(entry.id));
  const ids = new Set(existing.map(({ id }) => id));
  state.order = [
    ...existing.map((entry) => preserve(entry) ? entry : messageBuffer(incoming.get(entry.id) as Record<string, unknown>, credentials)),
    ...values.filter(({ id }) => !ids.has(String(id))).map((message) => messageBuffer(message, credentials)),
  ];
  state.candidates.clear();
  state.pending.clear();
  state.roles.clear();
  state.activities.clear();
  state.tools.clear();
  state.toolJSON.clear();
  for (const entry of state.order) {
    if (!state.roles.has(entry.id)) {
      state.roles.set(entry.id, entry.role);
      if (entry.role === 'activity') state.activities.set(entry.id, entry.activity);
      retainPrefix(`message:${entry.id}`, entry.prefix, state);
    }
    restoreSnapshotTools(entry, state);
  }
}

function retainPrefix(id: string, prefix: string, state: PrefixState) {
  if (prefix === '') return;
  state.candidates.set(id, prefix);
  state.pending.add(id);
}

function rememberMessageRole(event: Record<string, unknown>, roles: Map<string, string>) {
  let id = event.messageId;
  let role = event.type === EventType.REASONING_MESSAGE_START ? 'reasoning' : (typeof event.role === 'string' ? event.role : 'assistant');
  if (event.type === EventType.TOOL_CALL_START) {
    const parent = event.parentMessageId;
    id = typeof parent === 'string' && (!roles.has(parent) || roles.get(parent) === 'assistant') ? parent : event.toolCallId;
    role = 'assistant';
  }
  if (typeof id === 'string' && !roles.has(id)) roles.set(id, role);
}

function toolDelta(event: Record<string, unknown>, state: PrefixState) {
  const delta = String(event.delta);
  if (event.type !== EventType.TOOL_CALL_ARGS) return { delta, incompleteEscape: false };
  const id = deltaIdentity(event);
  const json = state.toolJSON.get(id) ?? { quoted: false, escape: '' };
  state.toolJSON.set(id, json);
  return { delta: decodedToolArguments(delta, json), incompleteEscape: json.escape !== '' };
}

function deltaPrefixLeaks(event: Record<string, unknown>, state: PrefixState, credentials: readonly string[]) {
  if (typeof event.delta !== 'string') return false;
  const id = deltaIdentity(event);
  const { delta, incompleteEscape } = toolDelta(event, state);
  const text = (state.candidates.get(id) ?? '') + delta;
  if (decodedLeaks(text, credentials)) return true;
  const prefix = credentialPrefix(text, credentials);
  if (prefix === '') {
    state.candidates.delete(id);
    if (!incompleteEscape) state.pending.delete(id);
  } else {
    state.candidates.set(id, prefix);
    state.pending.add(id);
  }
  if (incompleteEscape) state.pending.add(id);
  return false;
}

function seedMessages(messages: unknown, state: PrefixState, credentials: readonly string[]) {
  for (const message of recordValues(messages)) {
    if (typeof message.id !== 'string' || state.roles.has(message.id)) continue;
    const entry = messageBuffer(message, credentials);
    state.roles.set(entry.id, entry.role);
    state.order.push(entry);
    if (entry.role === 'activity') state.activities.set(entry.id, entry.activity);
    const deltas = snapshotDeltas(message).filter((event) => {
      if (event.type !== EventType.TOOL_CALL_ARGS) return true;
      const id = String(event.toolCallId);
      if (message.role !== 'assistant' || state.tools.has(id)) return false;
      state.tools.add(id);
      return true;
    });
    for (const event of deltas) {
      if (deltaPrefixLeaks(event, state, credentials)) return true;
    }
  }
  return false;
}

function resultLeaks(event: Record<string, unknown>, state: PrefixState, credentials: readonly string[]) {
  const id = event.messageId;
  if (typeof id !== 'string') return false;
  const owner = state.order.findIndex((message) => message.role === 'assistant' && message.tools.includes(String(event.toolCallId)));
  let position = owner < 0 ? state.order.length : owner + 1;
  if (owner >= 0) while (state.order[position]?.role === 'tool') position += 1;
  const first = state.order.findIndex((message) => message.id === id);
  const role = typeof event.role === 'string' ? event.role : 'tool';
  // Stryker disable next-line ArrayDeclaration: A protocol tool result never owns tool calls; only assistant buffers are searched.
  state.order.splice(position, 0, { id, role, tools: [], prefix: typeof event.content === 'string' ? credentialPrefix(event.content, credentials) : '', toolPrefixes: new Map() });
  if (first >= 0 && first < position) return false;
  state.roles.set(id, role);
  state.activities.delete(id);
  state.candidates.delete(`message:${id}`);
  return deltaPrefixLeaks({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: event.content }, state, credentials);
}

function replaceActivityBuffer(id: string, content: unknown, state: PrefixState, credentials: readonly string[]) {
  const entry = state.order.find((message) => message.id === id);
  // Stryker disable next-line ArrayDeclaration: Activity buffers never own tool calls, and assistant snapshots rebuild their tools.
  if (entry === undefined) state.order.push({ id, role: 'activity', tools: [], prefix: typeof content === 'string' ? credentialPrefix(content, credentials) : '', toolPrefixes: new Map(), activity: content });
  else { entry.role = 'activity'; entry.activity = content; entry.prefix = typeof content === 'string' ? credentialPrefix(content, credentials) : ''; }
}

function activityLeaks(event: Record<string, unknown>, state: PrefixState, credentials: readonly string[]) {
  const id = event.messageId;
  if (typeof id !== 'string') return false;
  let content: unknown;
  if (event.type === EventType.ACTIVITY_SNAPSHOT) {
    if (state.roles.has(id) && event.replace === false) return false;
    content = structuredClone(event.content);
  } else {
    if (state.roles.get(id) !== 'activity') return false;
    try {
      content = applyPatch(structuredClone(state.activities.get(id) ?? {}), (event.patch ?? []) as Operation[], true).newDocument;
    } catch {
      return false;
    }
  }
  replaceActivityBuffer(id, content, state, credentials);
  state.roles.set(id, 'activity');
  state.activities.set(id, content);
  state.candidates.delete(`message:${id}`);
  state.pending.delete(`message:${id}`);
  return deltaPrefixLeaks({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: content }, state, credentials);
}

function rememberTool(event: Record<string, unknown>, state: PrefixState) {
  const parent = event.parentMessageId;
  const owner = typeof parent === 'string' && state.roles.get(parent) === 'assistant' ? parent : event.toolCallId;
  const entry = state.order.find((message) => message.id === owner);
  entry?.tools.push(String(event.toolCallId));
  if (typeof event.toolCallId === 'string') state.tools.add(event.toolCallId);
}

function startPrefix(event: Record<string, unknown>, state: PrefixState) {
  const previous = new Set(state.roles.keys());
  rememberMessageRole(event, state.roles);
  for (const [messageId, role] of state.roles) if (!previous.has(messageId)) state.order.push({ id: messageId, role, tools: [], prefix: '', toolPrefixes: new Map() });
  if (event.type === EventType.TOOL_CALL_START) rememberTool(event, state);
  if (state.candidates.has(deltaIdentity(event))) state.pending.add(deltaIdentity(event));
}

function updateMessageBuffer(event: Record<string, unknown>, state: PrefixState) {
  if (event.type === EventType.TOOL_CALL_ARGS) return;
  if (typeof event.messageId !== 'string' || typeof event.delta !== 'string') return;
  const entry = state.order.find((message) => message.id === event.messageId);
  if (entry === undefined) return;
  entry.prefix = state.candidates.get(`message:${event.messageId}`) ?? '';
  if (entry.role !== 'activity') return;
  const prior = state.activities.get(event.messageId);
  entry.activity = (typeof prior === 'string' ? prior : '') + event.delta;
  state.activities.set(event.messageId, entry.activity);
}

function multipartMessageLeaks(messages: unknown, credentials: readonly string[]) {
  return recordValues(messages).some(({ content }) => {
    if (!Array.isArray(content)) return false;
    let text = '';
    return content.some((part: unknown) => {
      if (part === null || typeof part !== 'object') { text = ''; return false; }
      const value = part as Record<string, unknown>;
      if (value.type !== 'text' || typeof value.text !== 'string') { text = ''; return false; }
      text += value.text;
      return decodedLeaks(text, credentials);
    });
  });
}

function statePointerLeaks(delta: unknown, credentials: readonly string[]) {
  return recordValues(delta).some((operation) => ['path', 'from'].some((field) => {
    const pointer = operation[field];
    if (typeof pointer !== 'string' || !pointer.startsWith('/')) return false;
    return pointer.split('/').some((segment) => decodedLeaks(segment.replace(/~1/g, '/').replace(/~0/g, '~'), credentials));
  }));
}

function messageToolArgumentsLeak(messages: unknown, credentials: readonly string[]) {
  return recordValues(messages).flatMap(snapshotDeltas).some((event) => event.type === EventType.TOOL_CALL_ARGS &&
    typeof event.delta === 'string' && decodedLeaks(decodedToolArguments(event.delta, { quoted: false, escape: '' }), credentials));
}

function seededEventLeaks(event: Record<string, unknown>, state: PrefixState, credentials: readonly string[]) {
  switch (event.type) {
    case EventType.STATE_DELTA: return statePointerLeaks(event.delta, credentials);
    case EventType.RUN_STARTED: {
      const messages = (event.input as { messages?: unknown } | undefined)?.messages;
      return multipartMessageLeaks(messages, credentials) || messageToolArgumentsLeak(messages, credentials) || seedMessages(messages, state, credentials);
    }
    case EventType.TOOL_CALL_RESULT: return multipartMessageLeaks([event], credentials) || resultLeaks(event, state, credentials);
    case EventType.ACTIVITY_SNAPSHOT:
    case EventType.ACTIVITY_DELTA: return activityLeaks(event, state, credentials);
    case EventType.MESSAGES_SNAPSHOT:
      if (multipartMessageLeaks(event.messages, credentials) || messageToolArgumentsLeak(event.messages, credentials)) return true;
      replaceSnapshot(event.messages, state, credentials); return false;
    default: return false;
  }
}

function deltaLeaks(events: Record<string, unknown>[], state: PrefixState, credentials: readonly string[]) {
  const starts: readonly unknown[] = [EventType.TEXT_MESSAGE_START, EventType.REASONING_MESSAGE_START, EventType.TOOL_CALL_START];
  const ends: readonly unknown[] = [EventType.TEXT_MESSAGE_END, EventType.REASONING_MESSAGE_END, EventType.TOOL_CALL_END];
  const contents: readonly unknown[] = [EventType.TEXT_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_CONTENT, EventType.TOOL_CALL_ARGS];
  for (const event of events) {
    const { type } = event;
    if (seededEventLeaks(event, state, credentials)) return true;
    const id = deltaIdentity(event);
    if (ends.includes(type)) state.pending.delete(id);
    if (starts.includes(type)) startPrefix(event, state);
    if (contents.includes(type) && deltaPrefixLeaks(event, state, credentials)) return true;
    if (contents.includes(type)) updateMessageBuffer(event, state);

  }
  return false;
}

function chunkEvents() {
  const source = new Subject<BaseEvent>();
  const agent = new class extends AbstractAgent {
    run() { return source; }
  }();
  const input = { threadId: '', runId: '', messages: [], tools: [], context: [], state: {}, forwardedProps: {} };
  let output: Record<string, unknown>[] = [];
  let failure: unknown;
  new CompatibilityBoundary().run(input, agent).pipe(transformChunks()).subscribe({
    next: (event) => output.push(event),
    error: (error: unknown) => { failure = error; },
  });
  return (events: Record<string, unknown>[]) => {
    output = [];
    for (const event of events) source.next(event as BaseEvent);
    if (failure !== undefined) throw failure;
    return output;
  };
}

/** Client-held history omitted from this Turn. */
export interface HeldIds {
  messageIds: readonly string[];
  toolCallIds: readonly string[];
}

export function turnCredentialGuard(credentials: readonly string[], initialMessages?: unknown, held?: HeldIds): {
  leaks: (text: string, events: Record<string, unknown>[]) => boolean;
  hasPendingPrefix: () => boolean;
  /** The stream wrote to history the guard never saw. */
  wroteHeld: () => boolean;
} {
  const prefixes: PrefixState = { candidates: new Map(), pending: new Set(), roles: new Map(), activities: new Map(), tools: new Set(), order: [], toolJSON: new Map() };
  replaceSnapshot(initialMessages, prefixes, credentials);
  prefixes.pending.clear();
  const heldIds = new Set([...(held?.messageIds ?? []).map((id) => `message:${id}`), ...(held?.toolCallIds ?? []).map((id) => `tool:${id}`)]);
  let wroteHeld = false;
  const normalize = chunkEvents();
  return {
    leaks: (text, events) => {
      if (decodedLeaks(text, credentials) || decodedLeaks(events, credentials)) return true;
      const normalized = normalize(events);
      if (deltaLeaks(normalized, prefixes, credentials)) return true;
      wroteHeld = normalized.some((event) => heldIds.has(deltaIdentity(event)));
      return wroteHeld;
    },
    hasPendingPrefix: () => prefixes.pending.size !== 0,
    wroteHeld: () => wroteHeld,
  };
}

export function turnErrorDetails(details: string, credentials: readonly string[]): string {
  return turnCredentialGuard(credentials).leaks(details, [decoded(details)])
    ? "The error body carried the Turn's credentials, so it was withheld"
    : details;
}

export function persistedTurnError(message: string): string {
  const characters = Array.from(message);
  return characters.length <= 4096 ? message : `${characters.slice(0, 4095).join('')}…`;
}

interface RelayedTurn {
  timing?: TurnTiming;
  body: string;
  sessionId: string;
  accept?: string | undefined;
  initialBrowserSessionId?: string;
  saveAgentDocumentEdit: (edit: unknown) => Promise<void>;
  credentials: readonly string[];
  initialMessages?: readonly unknown[];
  held?: HeldIds;
  /** Runs after success without holding the stream open; records its own failure. */
  finished: (answer: string) => void | Promise<void>;
  /** Once at upstream end, even without a client, with the last relayed failure. */
  ended: (failure: TurnFailure | undefined) => Promise<void>;
  /** Awaited before RUN_STARTED is relayed, once the Harness accepts this Turn. */
  started?: () => Promise<void>;
  /** Awaited before the run error that ends the Turn is relayed, with that error's message. */
  failed: (message: string) => void | Promise<void>;
  /**
   * Aborts when the client leaves. The Node adapter neither reads nor cancels a response whose client left before it
   * began, so this drains the upstream and calls `ended` itself.
   */
  client?: AbortSignal | undefined;
  active?: () => void;
}

/** Persist edits before relay; withhold credential-bearing frames, including split deltas. */
export async function relayTurn(upstream: Upstream, turn: RelayedTurn): Promise<Response> {
  let response: Response;
  try {
    turn.timing?.mark('invoke');
    response = await upstream.invoke(turn.body, turn.sessionId, { accept: turn.accept, traceContext: turn.timing?.invokeTraceContext() });
  } catch (error) {
    console.error(`${upstream.label} request failed before the stream opened`, error);
    const message = `${upstream.label} request failed`;
    const details = turnErrorDetails(reason(error), turn.credentials);
    await tellEnd(turn, { code: 'AGENTCORE_UPSTREAM_REQUEST_ERROR', message: persistedTurnError(`${message}: ${details}`) });
    turn.timing?.finish();
    return Response.json({ error: message, details }, { status: 502 });
  }
  if (!response.ok || response.body === null) {
    const failed = await upstreamError(upstream, response, turn.credentials);
    await tellEnd(turn, failed.failure);
    turn.timing?.finish();
    return failed.response;
  }
  return new Response(
    relayFrames(upstream, turn, response.body),
    {
      headers: { 'content-type': response.headers.get('content-type') ?? 'text/event-stream' },
    },
  );
}

async function tellEnd(turn: RelayedTurn, failure?: TurnFailure) {
  try {
    await turn.ended(failure);
    return;
  } catch (error) {
    console.error(`The Turn's end could not be recorded session_id=${turn.sessionId}`, error);
    return error;
  }
}

const TURN_STOPPED = 'TURN_STOPPED';

async function upstreamError(upstream: Upstream, response: Response, credentials: readonly string[]) {
  const error = `${upstream.label} returned HTTP ${response.status}`;
  const failed = (error: string, details: string, status: number) => ({
    response: Response.json({ error, details }, { status }),
    failure: { code: 'AGENTCORE_UPSTREAM_HTTP_ERROR', message: persistedTurnError(details ? `${error}: ${details}` : error) },
  });
  let details: string;
  try {
    details = (await response.text()).trim();
  } catch (readError) {
    console.error(`Failed to read the ${upstream.label} error body`, readError);
    return failed(`${error} but its error body could not be read`, turnErrorDetails(reason(readError), credentials), 502);
  }
  const safeDetails = turnErrorDetails(details, credentials);
  if (safeDetails !== details) {
    console.error(`${upstream.label} error status=${response.status} carried a Turn credential; its body was withheld`);
  }
  console.warn(`${upstream.label} error status=${response.status} details=${safeDetails}`);
  return failed(error, safeDetails, response.status >= 400 ? response.status : 502);
}

function snapshotAnswerTexts(messages: unknown) {
  const texts = new Map<string, string>();
  for (const message of recordValues(messages)) {
    if (message.role === 'assistant' && typeof message.content === 'string') texts.set(String(message.id), message.content);
  }
  return texts;
}

interface RelayedFrames {
  out: string;
  events: Record<string, unknown>[];
}

const runErrorFrame = (message: string, code: string) => {
  const event = { type: EventType.RUN_ERROR, message, code };
  return { out: `data: ${JSON.stringify(event)}\n\n`, events: [event] };
};

function relayedOutcome() {
  let texts = new Map<string, string>();
  const normalize = chunkEvents();
  return {
    observe(events: Record<string, unknown>[]) {
      for (const { type, messageId, delta, messages } of normalize(events)) {
        if (type === EventType.TEXT_MESSAGE_CONTENT && typeof delta === 'string') {
          texts.set(String(messageId), (texts.get(String(messageId)) ?? '') + delta);
        }
        if (type === EventType.MESSAGES_SNAPSHOT) texts = snapshotAnswerTexts(messages);
      }
    },
    answer: () => ([...texts.values()].at(-1) ?? '').trim(),
  };
}

/** Invoke the Stop payload; throw on refusal. */
export async function stopTurn(upstream: Upstream, stop: string, sessionId: string): Promise<void> {
  const response = await upstream.invoke(stop, sessionId);
  await response.body?.cancel();
  if (!response.ok) throw new Error(`${upstream.label} refused to stop the Turn: HTTP ${response.status}`);
}

function relayFrames(upstream: Upstream, turn: RelayedTurn, body: ReadableStream<Uint8Array>) {
  type Frame = ReturnType<typeof flush>[number];
  const { sessionId, credentials, finished } = turn;
  const liveView = new LiveViewInjector(turn.initialBrowserSessionId);
  const outcome = relayedOutcome();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let readAt = Date.now();
  let monotonicReadAt = performance.now();
  let pending = '';
  let frame: string[] = [];
  const guard = turnCredentialGuard(credentials, turn.initialMessages, turn.held);
  const withheld: Frame[] = [];
  let terminal = false;
  let startFailure: { error: unknown } | undefined;
  let endTiming: { readAt: number; summarized: Promise<{ summaryMs: number; summaryFailed: boolean }>; endedMs?: number } | undefined;
  let endLogged = false;
  const logEnd = (client: 'attached' | 'gone', endedFailed: boolean) => {
    if (endTiming === undefined || endLogged) return;
    endLogged = true;
    const { readAt, summarized, endedMs } = endTiming;
    const doneMs = Date.now() - readAt;
    void summarized.then(({ summaryMs, summaryFailed }) => {
      console.info(`${upstream.label} relayed the Turn's end session_id=${sessionId} run_finished_read_at=${new Date(readAt).toISOString()} summary_ms=${summaryMs} summary_failed=${summaryFailed} ended_ms=${endedMs} ended_failed=${endedFailed} done_ms=${doneMs} client=${client}`);
    });
  };

  const complete = async (answer: string) => {
    const summaryAt = Date.now();
    try {
      await finished(answer);
      return { summaryMs: Date.now() - summaryAt, summaryFailed: false };
    } catch (error) {
      console.error(`The Turn's completion failed after its answer was relayed session_id=${sessionId}`, error);
      return { summaryMs: Date.now() - summaryAt, summaryFailed: true };
    }
  };

  const flush = () => {
    if (frame.length === 0) return [];
    const data = sseFrameData(frame);
    const events = data === null ? [] : [decoded(data)];
    const dataLines = frame.filter((line) => line.startsWith('data:'));
    const liveViewEvents = dataLines.length === 1 && dataLines[0]?.startsWith('data: ')
      ? events
      : dataLines.filter((line) => line.startsWith('data: ')).map((line) => decoded(line.slice(6)));
    const injected = liveView.after(liveViewEvents);
    const text = `${frame.join('\n')}\n\n${injected.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}`;
    const out = { text, events, emittedEvents: [...events, ...injected], readAt, monotonicReadAt };
    frame = [];
    return [out];
  };

  const take = (text: string) => {
    pending += text;
    // A trailing CR may be the first half of a CRLF split across chunks.
    const lines = pending.split(/\r\n|\r(?!$)|\n/);
    pending = lines.splice(-1).join();
    const frames: Frame[] = [];
    for (const line of lines) {
      if (line === '') frames.push(...flush());
      else frame.push(line);
    }
    return frames;
  };

  const logRunErrors = (events: Frame['events']) => {
    for (const { type, code, message } of events) {
      if (type === EventType.RUN_ERROR) {
        terminal = true;
        console.error(`${upstream.label} run failed session_id=${sessionId} code=${String(code)} message=${String(message)}`);
      }
    }
  };

  const recordFailure = async (message: string) => {
    try {
      await turn.failed(message);
      return null;
    } catch (error) {
      console.error(`Saving a failed Turn's Activity entry failed session_id=${sessionId}`, error);
      return runErrorFrame(`${message}; its Activity entry could not be saved: ${reason(error)}`, 'TURN_ACTIVITY_FAILED');
    }
  };

  const failure = async (message: string, code: string) =>
    (await recordFailure(message)) ?? runErrorFrame(message, code);

  const terminalError = async (events: Frame['events'], frameReadAt: number) => {
    const runFinished = events.find(({ type }) => type === EventType.RUN_FINISHED);
    if (runFinished !== undefined) {
      terminal = true;
      if (runFinishedOutcome(runFinished) === 'success') endTiming = { readAt: frameReadAt, summarized: complete(outcome.answer()) };
      return null;
    }
    const runError = events.find(({ type }) => type === EventType.RUN_ERROR);
    return runError === undefined ? null : recordFailure(String(runError.message));
  };

  const readinessError = async (events: Frame['events']) => {
    if (turn.started === undefined || !events.some(({ type }) => type === EventType.RUN_STARTED)) return null;
    try {
      await turn.started();
      return null;
    } catch (error) {
      startFailure = { error };
      console.error(`The Turn's start could not be recorded session_id=${sessionId}`, error);
      return failure(`The Turn's start could not be recorded: ${reason(error)}`, 'TURN_START_FAILED');
    }
  };

  const saveFrames = async (frames: Frame[]) => {
    let out = '';
    const emittedEvents: Record<string, unknown>[] = [];
    for (const { text, events, emittedEvents: frameEmittedEvents, readAt: frameReadAt, monotonicReadAt: frameReadMono } of frames) {
      turn.timing?.observe(events, frameReadMono);
      logRunErrors(events);
      for (const { value } of events.filter(({ type, name }) => type === EventType.CUSTOM && name === AGENT_DOCUMENT_EDITED)) {
        try {
          // eslint-disable-next-line no-await-in-loop -- saves each edit in stream order, before its frame is relayed
          await turn.saveAgentDocumentEdit(value);
        } catch (error) {
          console.error('Saving an agent document edit failed', error);
          const message = `The agent's edit could not be saved: ${error instanceof Error ? error.message : String(error)}`;
          // eslint-disable-next-line no-await-in-loop -- the stream ends with this error
          const classified = await failure(message, 'AGENT_DOCUMENT_SAVE_FAILED');
          return { out: out + classified.out, events: [...emittedEvents, ...classified.events], failed: true };
        }
      }
      outcome.observe(events);
      // eslint-disable-next-line no-await-in-loop -- readiness is recorded before this frame is relayed
      const readiness = await readinessError(events);
      if (readiness !== null) return { out: out + readiness.out, events: [...emittedEvents, ...readiness.events], failed: true };
      // eslint-disable-next-line no-await-in-loop -- a failed Turn's outcome is saved before its terminal frame is relayed
      const error = await terminalError(events, frameReadAt);
      if (error !== null) return { out: out + error.out, events: [...emittedEvents, ...error.events], failed: true };
      out += text;
      emittedEvents.push(...frameEmittedEvents);
    }
    return { out, events: emittedEvents, failed: false };
  };

  const saved = async (frames: Frame[], done: boolean) => {
    const ready: Frame[] = [];
    let credentialLeak = false;
    for (const next of frames) {
      try {
        if (guard.leaks(next.text, next.events)) {
          credentialLeak = true;
          break;
        }
      } catch (error) {
        const message = `${upstream.label} stream could not be inspected: ${turnErrorDetails(reason(error), credentials)}`;
        console.error(`${upstream.label} stream inspection failed session_id=${sessionId} code=AGENTCORE_UPSTREAM_STREAM_ERROR`);
        return failure(message, 'AGENTCORE_UPSTREAM_STREAM_ERROR').then((frame) => ({ ...frame, failed: true }));
      }
      withheld.push(next);
      if (!guard.hasPendingPrefix()) ready.push(...withheld.splice(0));
    }
    if (done && !credentialLeak) ready.push(...withheld.splice(0));
    const prior = await saveFrames(ready);
    if (prior.failed || !credentialLeak) return prior;
    if (guard.wroteHeld()) {
      console.error(`${upstream.label} streamed into an earlier message the client did not send session_id=${sessionId}; the stream was withheld`);
      const unchecked = await failure("The agent's answer wrote to an earlier message the Chat Service never saw, so it was withheld", 'TURN_EARLIER_MESSAGE_IN_STREAM');
      return { out: prior.out + unchecked.out, events: [...prior.events, ...unchecked.events], failed: true };
    }
    console.error(`${upstream.label} streamed a Turn credential session_id=${sessionId}; the stream was withheld`);
    const leaked = await failure("The agent's answer carried the Turn's credentials, so it was withheld", 'TURN_CREDENTIALS_IN_STREAM');
    return { out: prior.out + leaked.out, events: [...prior.events, ...leaked.events], failed: true };
  };

  const relayNext = async () => {
    let frames: Frame[];
    let done = false;
    try {
      const chunk = await reader.read();
      turn.active?.();
      readAt = Date.now();
      monotonicReadAt = performance.now();
      if (chunk.done) {
        // Stryker disable next-line Regex: pending holds a CR only as its last character, since any other CR splits a line
        const last = (pending + decoder.decode()).replace(/\r$/, '');
        if (last !== '') frame.push(last);
        frames = flush();
        done = true;
      } else {
        frames = take(decoder.decode(chunk.value, { stream: true }));
      }
    } catch (error) {
      if (terminal) return { out: '', events: [], end: true };
      terminal = true;
      console.error(`${upstream.label} stream failed session_id=${sessionId} code=AGENTCORE_UPSTREAM_STREAM_ERROR`, error);
      const failed = await failure(`${upstream.label} stream failed: ${reason(error)}`, 'AGENTCORE_UPSTREAM_STREAM_ERROR');
      frames = [...flush(), { text: failed.out, events: [], emittedEvents: failed.events, readAt, monotonicReadAt }];
      done = true;
    }
    const { out, events, failed } = await saved(frames, done);
    if (failed && !done) await reader.cancel();
    if (done && !failed && !terminal) {
      console.error(`${upstream.label} stream ended before the Turn finished session_id=${sessionId} code=AGENTCORE_UPSTREAM_STREAM_ERROR`);
      const failed = await failure(`${upstream.label} stream ended before the Turn finished`, 'AGENTCORE_UPSTREAM_STREAM_ERROR');
      return { out: out + failed.out, events: [...events, ...failed.events], end: true };
    }
    return { out, events, end: done || failed };
  };

  let reading: Promise<unknown> = Promise.resolve();
  let ending: Promise<unknown> | undefined;
  let sentFailure: TurnFailure | undefined;
  const relayInOrder = () => {
    const next = reading.then(async () => {
      if (ending !== undefined) return { out: '', events: [], end: true };
      const relayed = await relayNext();
      const runError = relayed.events.filter(({ type, code }) => type === EventType.RUN_ERROR && code !== TURN_STOPPED).at(-1);
      if (runError !== undefined) {
        const { code, message } = runError;
        sentFailure = { ...(typeof code === 'string' ? { code } : {}), message: persistedTurnError(String(message)) };
      }
      if (relayed.end) {
        const endingAt = Date.now();
        ending = tellEnd(turn, sentFailure).finally(() => {
          if (endTiming !== undefined) endTiming.endedMs = Date.now() - endingAt;
        });
      }
      return relayed;
    });
    reading = next;
    return next;
  };

  let cancelled = false;
  let abandoned: Promise<void> | undefined;
  const abandon = () => abandoned ??= (async () => {
    cancelled = true;
    try {
      let next: RelayedFrames & { end: boolean };
      do {
        // eslint-disable-next-line no-await-in-loop -- each read depends on the frames before it
        next = await relayInOrder();
      } while (!next.end);
      const endFailure = await ending;
      if (endFailure !== undefined) turn.timing?.fail();
      logEnd('gone', endFailure !== undefined);
    } catch (error) {
      turn.timing?.fail();
      throw error;
    } finally {
      turn.timing?.finish('gone');
    }
  })();
  const { client } = turn;
  if (client !== undefined) {
    const left = () => {
      if (ending !== undefined) return;
      console.warn(`The client left before the Turn ended session_id=${sessionId}; reading the upstream to its end`);
      abandon().catch((error: unknown) => { console.error(`The abandoned Turn could not be read to its end session_id=${sessionId}`, error); });
    };
    if (client.aborted) left();
    else client.addEventListener('abort', left, { once: true });
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: NodeJS.Timeout | undefined;
      const keepAlive = () => {
        timer = setTimeout(() => {
          if (cancelled) return;
          controller.enqueue(KEEPALIVE);
          keepAlive();
        }, KEEPALIVE_MS);
      };
      keepAlive();
      // A pull that enqueues nothing is not called again, so read on until a frame
      // completes or the stream ends (a large frame spans several reads).
      let next: RelayedFrames & { end: boolean };
      try {
        do {
          // eslint-disable-next-line no-await-in-loop -- each read depends on the frames before it
          next = await relayInOrder();
        } while (next.out === '' && !next.end);
      } catch (error) {
        turn.timing?.fail();
        turn.timing?.finish();
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (next.out !== '') {
        controller.enqueue(encoder.encode(next.out));
        turn.timing?.emitted(next.events);
      }
      if (!next.end) return;
      const endFailure = await ending;
      if (endFailure !== undefined) turn.timing?.fail();
      turn.timing?.finish();
      if (endFailure === undefined) {
        controller.close();
        logEnd('attached', false);
      } else {
        controller.error(startFailure === undefined
          ? endFailure
          : new AggregateError([startFailure.error, endFailure], "The Turn's start failed and its end could not be recorded"));
        logEnd('attached', true);
      }
    },
    cancel() {
      return abandon();
    },
  });
}
