import { positiveInteger } from './config.js';
import { EventType } from '@ag-ui/client';
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
const KEEPALIVE_MS = positiveInteger(process.env, 'BOTCUBE_CHAT_KEEPALIVE_MS', 15_000);

function reason(error: unknown): string {
  if (error instanceof Error && error.cause !== undefined) return `${error.message}: ${reason(error.cause)}`;
  return String(error);
}

const json = (body: unknown, status: number) => Response.json(body, { status });

/** The JSON value a text decodes to, wrapped as an event; non-JSON text decodes to none. */
function decoded(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  } catch {
    // Non-JSON data carries no event; the frame itself is still forwarded.
    return {};
  }
}

/** SSE joins all of a frame's data fields with a newline before decoding JSON. */
export function sseFrameData(lines: readonly string[]): string | null {
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
  return data.length === 0 ? null : data.join('\n');
}

function dataEvents(lines: string[]): Record<string, unknown>[] {
  const data = sseFrameData(lines);
  return data === null ? [] : [decoded(data)];
}

/**
 * The credentials a Turn forwards to the Harness, its Files-sync keys (ADR 0077
 * decision 2) and the Cartridge's credential props, which must never reach the
 * client: a Harness that leaves them in its forwarded props streams them back in
 * the agent's state. An empty one would match every frame, so it is dropped.
 */
export function turnCredentials(forwardedProps: Record<string, unknown>, credentialProps: readonly string[]): string[] {
  const files = forwardedProps.files as Record<string, unknown> | null | undefined;
  const filesKeys = files !== null && typeof files === 'object' && !Array.isArray(files)
    ? [files.accessKeyId, files.secretAccessKey, files.sessionToken]
    : [];
  const memory = forwardedProps.turnMemory as { token?: unknown } | undefined;
  const props = [...credentialProps.map((prop) => forwardedProps[prop]), memory?.token];
  // A credential URL's query values (a tokened CDP URL's token) authenticate on their own.
  const queryValues = props.flatMap((value) =>
    typeof value === 'string' && URL.canParse(value) ? [...new URL(value).searchParams.values()] : [],
  );
  return [...filesKeys, ...props, ...queryValues].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
}


/** Only bearer tokens derived from this Turn's credential URLs have query decoding semantics. */
function credentialQueryTokens(credentials: readonly string[]): string[] {
  return credentials
    .filter((credential) => URL.canParse(credential))
    .map((credential) => new URL(credential).searchParams.get('token'))
    .filter((token): token is string => token !== null && token !== '');
}

/** Query-token occurrences, including escapes split across deltas. */
function encodedQueryTokens(text: string): string[] {
  // Stryker disable next-line ArrayDeclaration: The inserted fallback value lacks a percent sign and is removed by the filter.
  return (text.match(/[A-Za-z0-9._~%+-]+/g) ?? []).filter((value) => value.includes('%'));
}

const queryToken = (value: string): string => new URLSearchParams(`token=${value}`).get('token') ?? '';

/** Visit only the bounded suffix candidates, longest first. Negative lengths produce no candidates. */
function descendingCandidates(upper: number, lower: number): number[] {
  return Array.from({ length: upper - lower }, (_, index) => upper - index);
}

function encodedQueryPrefix(text: string, tokens: readonly string[]): string {
  let length = 0;
  for (const token of tokens) {
    for (const value of encodedQueryTokens(text)) {
      if (!text.endsWith(value)) continue;
      // Bound the retained suffix to this known token's longest percent-encoded representation.
      for (const candidate of descendingCandidates(Math.min(value.length, token.length * 3), length)) {
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

/** Retain only the suffix that could become one of this Turn's credentials. */
function credentialPrefix(text: string, credentials: readonly string[]): string {
  let length = 0;
  for (const credential of credentials) {
    for (const candidate of descendingCandidates(Math.min(text.length, credential.length - 1), length)) {
      if (text.endsWith(credential.slice(0, candidate))) {
        length = candidate;
        break;
      }
    }
  }
  length = Math.max(length, encodedQueryPrefix(text, credentialQueryTokens(credentials)).length);
  const limit = Math.max(0, ...credentials.map((credential) => credential.length)) * 3;
  const url = matchingCredentialUrls(text, credentials, (supplied, expected) => {
    // An escape may itself span deltas; only the known URL's token is decoded.
    const prefix = supplied.replace(/%(?:[0-9a-f])?$/i, '');
    return prefix.length < expected.length && expected.startsWith(prefix);
  }).find((value) => text.endsWith(value) && value.length <= limit) ?? '';
  return text.slice(text.length - Math.max(url.length, length));
}

/** Only URL occurrences at a known credential URL's origin and path are normalized. */
function matchingCredentialUrls(
  text: string,
  credentials: readonly string[],
  acceptsToken: (supplied: string, expected: string) => boolean,
): string[] {
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

/** Credentials can appear anywhere in a parsed event, including escaped state or errors. */
function decodedLeaks(value: unknown, credentials: readonly string[]): boolean {
  if (typeof value === 'string') return credentials.some((credential) => value.includes(credential)) ||
    matchingCredentialUrls(value, credentials, (supplied, expected) => supplied === expected).length !== 0 ||
    encodedQueryTokens(value).some((candidate) => credentialQueryTokens(credentials).some((token) => queryToken(candidate).includes(token)));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, part]) => decodedLeaks(key, credentials) || decodedLeaks(part, credentials));
  }
  return false;
}

/** Text messages and tool arguments accumulate independently, even when their IDs match. */
function deltaIdentity({ type, messageId, toolCallId }: Record<string, unknown>): string {
  const toolTypes: readonly unknown[] = [EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END];
  const tool = toolTypes.includes(type);
  const identity = tool ? toolCallId : messageId;
  return `${tool ? 'tool' : 'message'}:${typeof identity === 'string' ? identity : ''}`;
}

/** Message snapshots replace the same text and tool-argument buffers the client appends to. */
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

function decodedToolArguments(text: string, state: ToolJSON): string {
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

function recordValues(messages: unknown): Record<string, unknown>[] {
  return Array.isArray(messages) ? messages.filter((value: unknown) => value !== null && typeof value === 'object') as Record<string, unknown>[] : [];
}

function messageToolIds(message: Record<string, unknown>): string[] {
  return snapshotDeltas(message).filter((event) => event.type === EventType.TOOL_CALL_ARGS).map((event) => String(event.toolCallId));
}

function messageBuffer(message: Record<string, unknown>, credentials: readonly string[]): MessageBuffer {
  const tools = messageToolIds(message);
  const toolPrefixes = new Map<string, string>();
  const toolJSON = new Map<string, ToolJSON>();
  for (const event of snapshotDeltas(message)) {
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

function recordMessage(message: Record<string, unknown>, state: PrefixState, credentials: readonly string[]): void {
  if (typeof message.id !== 'string') return;
  const entry = messageBuffer(message, credentials);
  state.roles.set(entry.id, entry.role);
  state.order.push(entry);
  if (entry.role === 'activity') state.activities.set(entry.id, entry.activity);
}

function firstToolDeltas(messages: Record<string, unknown>[], state: PrefixState): Record<string, unknown>[] {
  return messages.flatMap((message) => snapshotDeltas(message).filter((event) => {
    if (event.type !== EventType.TOOL_CALL_ARGS) return true;
    const id = String(event.toolCallId);
    if (message.role !== 'assistant' || state.tools.has(id)) return false;
    state.tools.add(id);
    return true;
  }));
}

function restoreSnapshotTools(entry: MessageBuffer, state: PrefixState): void {
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

/** The client preserves reasoning messages only when a snapshot supplies none. */
function replaceSnapshot(messages: unknown, state: PrefixState, credentials: readonly string[]): Record<string, unknown>[] {
  const values = recordValues(messages);
  const incoming = new Map(values.map((message) => [message.id, message]));
  const preserveReasoning = !values.some(({ role }) => role === 'reasoning');
  const preserve = (entry: MessageBuffer): boolean => entry.role === 'activity' || (preserveReasoning && entry.role === 'reasoning');
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
  return [];
}

function retainPrefix(id: string, prefix: string, state: PrefixState): void {
  if (prefix === '') return;
  state.candidates.set(id, prefix);
  state.pending.add(id);
}

/** Starts append to an existing client message rather than replacing its role. */
function rememberMessageRole(event: Record<string, unknown>, roles: Map<string, string>): void {
  let id = event.messageId;
  let role = event.type === EventType.REASONING_MESSAGE_START ? 'reasoning' : (typeof event.role === 'string' ? event.role : 'assistant');
  if (event.type === EventType.TOOL_CALL_START) {
    const parent = event.parentMessageId;
    id = typeof parent === 'string' && (!roles.has(parent) || roles.get(parent) === 'assistant') ? parent : event.toolCallId;
    role = 'assistant';
  }
  if (typeof id === 'string' && !roles.has(id)) roles.set(id, role);
}

function toolDelta(event: Record<string, unknown>, state: PrefixState): { delta: string; incompleteEscape: boolean } {
  const delta = String(event.delta);
  if (event.type !== EventType.TOOL_CALL_ARGS) return { delta, incompleteEscape: false };
  const id = deltaIdentity(event);
  const json = state.toolJSON.get(id) ?? { quoted: false, escape: '' };
  state.toolJSON.set(id, json);
  return { delta: decodedToolArguments(delta, json), incompleteEscape: json.escape !== '' };
}

function deltaPrefixLeaks(event: Record<string, unknown>, state: PrefixState, credentials: readonly string[]): boolean {
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

/** Seed the buffers actually added by the client; RUN_STARTED merges absent IDs. */
function seedMessages(messages: unknown, state: PrefixState, credentials: readonly string[]): boolean {
  for (const message of recordValues(messages)) {
    if (typeof message.id !== 'string' || state.roles.has(message.id)) continue;
    recordMessage(message, state, credentials);
    for (const event of firstToolDeltas([message], state)) {
      if (deltaPrefixLeaks(event, state, credentials)) return true;
    }
  }
  return false;
}

/** Results are inserted after their owning assistant and its contiguous tool results. */
function resultLeaks(event: Record<string, unknown>, state: PrefixState, credentials: readonly string[]): boolean {
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

function replaceActivityBuffer(id: string, content: unknown, state: PrefixState, credentials: readonly string[]): void {
  const entry = state.order.find((message) => message.id === id);
  // Stryker disable next-line ArrayDeclaration: Activity buffers never own tool calls, and assistant snapshots rebuild their tools.
  if (entry === undefined) state.order.push({ id, role: 'activity', tools: [], prefix: typeof content === 'string' ? credentialPrefix(content, credentials) : '', toolPrefixes: new Map(), activity: content });
  else { entry.role = 'activity'; entry.activity = content; entry.prefix = typeof content === 'string' ? credentialPrefix(content, credentials) : ''; }
}

/** Activity updates replace content; rejected JSON patches leave the client's buffer intact. */
function activityLeaks(event: Record<string, unknown>, state: PrefixState, credentials: readonly string[]): boolean {
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
      // A truthful probe of the client's validated patch: rejection preserves its prior content.
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

function rememberTool(event: Record<string, unknown>, state: PrefixState): void {
  const parent = event.parentMessageId;
  const owner = typeof parent === 'string' && state.roles.get(parent) === 'assistant' ? parent : event.toolCallId;
  const entry = state.order.find((message) => message.id === owner);
  entry?.tools.push(String(event.toolCallId));
  if (typeof event.toolCallId === 'string') state.tools.add(event.toolCallId);
}

function startPrefix(event: Record<string, unknown>, state: PrefixState): void {
  const previous = new Set(state.roles.keys());
  rememberMessageRole(event, state.roles);
  for (const [messageId, role] of state.roles) if (!previous.has(messageId)) state.order.push({ id: messageId, role, tools: [], prefix: '', toolPrefixes: new Map() });
  if (event.type === EventType.TOOL_CALL_START) rememberTool(event, state);
  if (state.candidates.has(deltaIdentity(event))) state.pending.add(deltaIdentity(event));
}

function updateMessageBuffer(event: Record<string, unknown>, state: PrefixState): void {
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

/** Adjacent protocol text parts retain the issued credential even when the UI inserts separators. */
function multipartMessageLeaks(messages: unknown, credentials: readonly string[]): boolean {
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

/** JSON Patch applies these two escapes to each pointer segment before accessing client state. */
function statePointerLeaks(delta: unknown, credentials: readonly string[]): boolean {
  return recordValues(delta).some((operation) => ['path', 'from'].some((field) => {
    const pointer = operation[field];
    if (typeof pointer !== 'string' || !pointer.startsWith('/')) return false;
    return pointer.split('/').some((segment) => decodedLeaks(segment.replace(/~1/g, '/').replace(/~0/g, '~'), credentials));
  }));
}

function messageToolArgumentsLeak(messages: unknown, credentials: readonly string[]): boolean {
  return recordValues(messages).flatMap(snapshotDeltas).some((event) => event.type === EventType.TOOL_CALL_ARGS &&
    typeof event.delta === 'string' && decodedLeaks(decodedToolArguments(event.delta, { quoted: false, escape: '' }), credentials));
}

function seededEventLeaks(event: Record<string, unknown>, state: PrefixState, credentials: readonly string[]): boolean {
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

function deltaLeaks(events: Record<string, unknown>[], state: PrefixState, credentials: readonly string[]): boolean {
  const starts: readonly unknown[] = [EventType.TEXT_MESSAGE_START, EventType.REASONING_MESSAGE_START, EventType.TOOL_CALL_START];
  const ends: readonly unknown[] = [EventType.TEXT_MESSAGE_END, EventType.REASONING_MESSAGE_END, EventType.TOOL_CALL_END];
  const contents: readonly unknown[] = [EventType.TEXT_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_CONTENT, EventType.TOOL_CALL_ARGS];
  for (const event of events) {
    const { type } = event;
    if (seededEventLeaks(event, state, credentials)) return true;
    const id = deltaIdentity(event);
    // The client retains cumulative content after END and appends if the ID is reused.
    if (ends.includes(type)) state.pending.delete(id);
    if (starts.includes(type)) startPrefix(event, state);
    if (contents.includes(type) && deltaPrefixLeaks(event, state, credentials)) return true;
    if (contents.includes(type)) updateMessageBuffer(event, state);

  }
  return false;
}

/** Mirror the installed client's chunk IDs and boundaries for inspection; preserve the original wire. */
function chunkEvents(): (events: Record<string, unknown>[]) => Record<string, unknown>[] {
  const chunks: Record<string, { field: string; start: EventType; content: EventType; end: EventType }> = {
    [EventType.TEXT_MESSAGE_CHUNK]: { field: 'messageId', start: EventType.TEXT_MESSAGE_START, content: EventType.TEXT_MESSAGE_CONTENT, end: EventType.TEXT_MESSAGE_END },
    [EventType.TOOL_CALL_CHUNK]: { field: 'toolCallId', start: EventType.TOOL_CALL_START, content: EventType.TOOL_CALL_ARGS, end: EventType.TOOL_CALL_END },
    [EventType.REASONING_MESSAGE_CHUNK]: { field: 'messageId', start: EventType.REASONING_MESSAGE_START, content: EventType.REASONING_MESSAGE_CONTENT, end: EventType.REASONING_MESSAGE_END },
  };
  const boundaries: readonly unknown[] = [
    EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END,
    EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT,
    EventType.STATE_SNAPSHOT, EventType.STATE_DELTA, EventType.MESSAGES_SNAPSHOT, EventType.CUSTOM,
    EventType.RUN_STARTED, EventType.RUN_FINISHED, EventType.RUN_ERROR, EventType.STEP_STARTED, EventType.STEP_FINISHED,
    'THINKING_START', 'THINKING_END', 'THINKING_TEXT_MESSAGE_START',
    'THINKING_TEXT_MESSAGE_CONTENT', 'THINKING_TEXT_MESSAGE_END', EventType.REASONING_START,
    EventType.REASONING_MESSAGE_START, EventType.REASONING_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_END, EventType.REASONING_END,
  ];
  let active: { type: string; id: unknown; field: string; end: EventType } | undefined;
  const close = (): Record<string, unknown>[] => {
    if (active === undefined) return [];
    const event = { type: active.end, [active.field]: active.id };
    active = undefined;
    return [event];
  };
  return (events) => events.flatMap((event) => {
    const type = typeof event.type === 'string' ? event.type : '';
    const chunk = chunks[type];
    if (chunk === undefined) return boundaries.includes(type) ? [...close(), event] : [event];
    const supplied = event[chunk.field];
    // Reasoning treats an empty ID as omitted, while text/tool chunks test undefined.
    const identified = type === EventType.REASONING_MESSAGE_CHUNK ? Boolean(supplied) : supplied !== undefined;
    const output = active?.type !== type || (identified && supplied !== active.id) ? close() : [];
    if (active === undefined) {
      // Invalid first chunks cannot be accumulated by the client either.
      if (supplied === undefined || (type === EventType.TOOL_CALL_CHUNK && event.toolCallName === undefined)) return output;
      active = { type, id: supplied, field: chunk.field, end: chunk.end };
      output.push({ type: chunk.start, [chunk.field]: supplied });
    }
    if (event.delta !== undefined) output.push({ type: chunk.content, [chunk.field]: active.id, delta: event.delta });
    return output;
  });
}

/** The earlier messages and tool calls a client holds but did not send with its Turn. */
export interface HeldIds {
  messageIds: readonly string[];
  toolCallIds: readonly string[];
}

/** One Turn's fail-closed check shared by interactive and scheduled output consumers. */
export function turnCredentialGuard(credentials: readonly string[], initialMessages?: unknown, held?: HeldIds): {
  leaks: (text: string, events: Record<string, unknown>[]) => boolean;
  hasPendingPrefix: () => boolean;
  /** Whether a withheld stream wrote to a held message or tool call, whose content the guard never saw. */
  wroteHeld: () => boolean;
} {
  const prefixes: PrefixState = { candidates: new Map(), pending: new Set(), roles: new Map(), activities: new Map(), tools: new Set(), order: [], toolJSON: new Map() };
  // The client starts from its own request history even when RUN_STARTED omits input.
  replaceSnapshot(initialMessages, prefixes, credentials);
  // Completed history is inactive until a later event starts or appends to that ID.
  prefixes.pending.clear();
  const heldIds = new Set([...(held?.messageIds ?? []).map((id) => `message:${id}`), ...(held?.toolCallIds ?? []).map((id) => `tool:${id}`)]);
  let wroteHeld = false;
  const normalize = chunkEvents();
  return {
    leaks: (text, events) => {
      if (decodedLeaks(text, credentials) || decodedLeaks(events, credentials)) return true;
      const normalized = normalize(events);
      if (deltaLeaks(normalized, prefixes, credentials)) return true;
      // The client appends to a held buffer, so the guard cannot tell what the appended text completes.
      wroteHeld = normalized.some((event) => heldIds.has(deltaIdentity(event)));
      return wroteHeld;
    },
    hasPendingPrefix: () => prefixes.pending.size !== 0,
    wroteHeld: () => wroteHeld,
  };
}

/** Preserve ordinary refusal details while withholding raw or JSON-escaped Turn credentials. */
export function turnErrorDetails(details: string, credentials: readonly string[]): string {
  return turnCredentialGuard(credentials).leaks(details, [decoded(details)])
    ? "The error body carried the Turn's credentials, so it was withheld"
    : details;
}

export function persistedTurnError(message: string): string {
  const characters = Array.from(message);
  return characters.length <= 4096 ? message : `${characters.slice(0, 4095).join('')}…`;
}

/** One Turn to send upstream, and what its relay does with the answer. */
interface RelayedTurn {
  body: string;
  sessionId: string;
  accept?: string | undefined;
  browserEventName: string;
  initialBrowserSessionId?: string;
  saveAgentDocumentEdit: (edit: unknown) => Promise<void>;
  credentials: readonly string[];
  initialMessages?: readonly unknown[];
  held?: HeldIds;
  /**
   * Called as the run's successful terminal frame is relayed, with the agent's last message. It runs on after the stream
   * closes, so it records its own failure where the Session shows it; the relay logs that failure too.
   */
  finished: (answer: string) => void | Promise<void>;
  /**
   * Called once the upstream stream is over, however it ended, with or without a client: with the run error the client
   * was sent last, when the Turn failed.
   */
  ended: (failure: TurnFailure | undefined) => Promise<void>;
  /** Awaited before RUN_STARTED is relayed, once the Harness accepts this Turn. */
  started?: () => Promise<void>;
  /** Awaited before the run error that ends the Turn is relayed, with that error's message. */
  failed: (message: string) => void | Promise<void>;
}

/**
 * Send one Turn upstream and relay its answer: the SSE frames verbatim, each
 * followed by any browser live-view event it triggers, or a classified error.
 * Each agent document edit is saved before its frame is relayed. A frame that
 * carries any of the Turn's credentials, including across message deltas, ends the stream with an error instead,
 * whatever Harness version sent it.
 */
export async function relayTurn(upstream: Upstream, turn: RelayedTurn): Promise<Response> {
  let response: Response;
  try {
    response = await upstream.invoke(turn.body, turn.sessionId, { accept: turn.accept });
  } catch (error) {
    console.error(`${upstream.label} request failed before the stream opened`, error);
    const message = `${upstream.label} request failed`;
    const details = turnErrorDetails(reason(error), turn.credentials);
    await tellEnd(turn, { code: 'AGENTCORE_UPSTREAM_REQUEST_ERROR', message: persistedTurnError(`${message}: ${details}`) });
    return json({ error: message, details }, 502);
  }
  // A bodiless success (a 204, say) carries no answer to relay.
  if (!response.ok || response.body === null) {
    const failed = await upstreamError(upstream, response, turn.credentials);
    await tellEnd(turn, failed.failure);
    return failed.response;
  }
  return new Response(
    relayFrames(upstream, turn, response.body),
    {
      headers: { 'content-type': response.headers.get('content-type') ?? 'text/event-stream' },
    },
  );
}

/** Tell the Turn's end, logging a failure to record it and returning that failure. */
async function tellEnd(turn: RelayedTurn, failure?: TurnFailure): Promise<unknown> {
  try {
    await turn.ended(failure);
    return undefined;
  } catch (error) {
    console.error(`The Turn's end could not be recorded session_id=${turn.sessionId}`, error);
    return error;
  }
}

/** The Harness's run error for a Turn the user stopped: the user's choice, no failure. */
const TURN_STOPPED = 'TURN_STOPPED';

/** The last run error in relayed text, as its client was sent it, leaving out a Stop's. */
function lastRunError(out: string): TurnFailure | undefined {
  const runError = out
    .split('\n\n')
    .flatMap((frame) => dataEvents(frame.split('\n')))
    .filter(({ type, code }) => type === EventType.RUN_ERROR && code !== TURN_STOPPED)
    .at(-1);
  if (runError === undefined) return undefined;
  const { code, message } = runError;
  return { ...(typeof code === 'string' ? { code } : {}), message: String(message) };
}

async function upstreamError(upstream: Upstream, response: Response, credentials: readonly string[]): Promise<{ response: Response; failure: TurnFailure }> {
  const error = `${upstream.label} returned HTTP ${response.status}`;
  const failed = (error: string, details: string, status: number) => ({
    response: json({ error, details }, status),
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

function snapshotAnswerTexts(messages: unknown): Map<string, string> {
  const texts = new Map<string, string>();
  for (const message of recordValues(messages)) {
    if (message.role === 'assistant' && typeof message.content === 'string') texts.set(String(message.id), message.content);
  }
  return texts;
}

const runErrorFrame = (message: string, code: string) =>
  `data: ${JSON.stringify({ type: EventType.RUN_ERROR, message, code })}\n\n`;

/** What the relayed events said: the agent's messages' text, and whether the run finished. */
function relayedOutcome(): { observe: (events: Record<string, unknown>[]) => void; answer: () => string | null } {
  let texts = new Map<string, string>();
  let runFinished = false;
  const normalize = chunkEvents();
  return {
    observe(events) {
      for (const { type, messageId, delta, messages } of normalize(events)) {
        if (type === EventType.RUN_FINISHED) runFinished = true;
        if (type === EventType.TEXT_MESSAGE_CONTENT && typeof delta === 'string') {
          texts.set(String(messageId), (texts.get(String(messageId)) ?? '') + delta);
        }
        if (type === EventType.MESSAGES_SNAPSHOT) texts = snapshotAnswerTexts(messages);
      }
    },
    /** The last agent message of a finished run; null when the run did not finish. */
    answer: () => (runFinished ? ([...texts.values()].at(-1) ?? '').trim() : null),
  };
}

/** Ask the upstream to stop the Session's Turn with this `stop` invocation, as an explicit Stop does; throws when it cannot. */
export async function stopTurn(upstream: Upstream, stop: string, sessionId: string): Promise<void> {
  const response = await upstream.invoke(stop, sessionId);
  await response.body?.cancel();
  if (!response.ok) throw new Error(`${upstream.label} refused to stop the Turn: HTTP ${response.status}`);
}

/** One relayable frame: its text (with any live-view events after it) and the agent document edits it carries. */
interface Frame {
  text: string;
  edits: unknown[];
  events: Record<string, unknown>[];
  readAt: number;
}

/**
 * The upstream body re-framed at blank lines, with live-view events after their
 * frames, and each run error the agent sends logged unless it carries a Turn credential. A frame carrying agent document edits is relayed only once they are
 * saved; a failed save ends the stream with a classified error instead.
 */
function relayFrames(upstream: Upstream, turn: RelayedTurn, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const { sessionId, credentials, finished } = turn;
  const liveView = new LiveViewInjector(turn.browserEventName, turn.initialBrowserSessionId);
  const outcome = relayedOutcome();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let readAt = Date.now();
  let pending = '';
  let frame: string[] = [];
  const guard = turnCredentialGuard(credentials, turn.initialMessages, turn.held);
  const withheld: Frame[] = [];
  let terminal = false;
  let startFailure: { error: unknown } | undefined;
  // Upstream receipt and local relay completion. Pulls can prefetch before the client consumes
  // queued bytes; these timings do not establish downstream receipt or distinguish backpressure by themselves.
  // The summary runs on after the stream closes, so the end is logged once both are done.
  let endTiming: { readAt: number; summarized: Promise<{ summaryMs: number; summaryFailed: boolean }>; endedMs?: number } | undefined;
  const logEnd = (client: 'attached' | 'gone', endedFailed: boolean): void => {
    if (endTiming === undefined) return;
    const { readAt, summarized, endedMs } = endTiming;
    const doneMs = Date.now() - readAt;
    void summarized.then(({ summaryMs, summaryFailed }) => {
      console.info(`${upstream.label} relayed the Turn's end session_id=${sessionId} run_finished_read_at=${new Date(readAt).toISOString()} summary_ms=${summaryMs} summary_failed=${summaryFailed} ended_ms=${endedMs} ended_failed=${endedFailed} done_ms=${doneMs} client=${client}`);
    });
  };

  /** Complete a finished Turn without holding its stream open: how long it took, and whether it failed. */
  const complete = async (answer: string): Promise<{ summaryMs: number; summaryFailed: boolean }> => {
    const summaryAt = Date.now();
    try {
      await finished(answer);
      return { summaryMs: Date.now() - summaryAt, summaryFailed: false };
    } catch (error) {
      console.error(`The Turn's completion failed after its answer was relayed session_id=${sessionId}`, error);
      return { summaryMs: Date.now() - summaryAt, summaryFailed: true };
    }
  };

  const flush = (): Frame[] => {
    if (frame.length === 0) return [];
    const events = dataEvents(frame);
    const text = `${frame.join('\n')}\n\n${liveView.after(frame).join('')}`;
    const edits = events.flatMap(({ type, name, value }) =>
      type === EventType.CUSTOM && name === AGENT_DOCUMENT_EDITED ? [value] : [],
    );
    const out = { text, edits, events, readAt };
    frame = [];
    return [out];
  };

  const take = (text: string): Frame[] => {
    pending += text;
    // A trailing CR may be the first half of a CRLF split across chunks.
    const lines = pending.split(/\r\n|\r(?!$)|\n/);
    // The split always ends with the unterminated rest, which one-element join() returns as is.
    pending = lines.splice(-1).join();
    const frames: Frame[] = [];
    for (const line of lines) {
      if (line === '') frames.push(...flush());
      else frame.push(line);
    }
    return frames;
  };

  /**
   * The frames' text up to the first that carries a credential or an edit that
   * fails to save, then that failure's error; whether one failed.
   */
  const logRunErrors = (events: Frame['events']): void => {
    for (const { type, code, message } of events) {
      if (type === EventType.RUN_ERROR) {
        terminal = true;
        console.error(`${upstream.label} run failed session_id=${sessionId} code=${String(code)} message=${String(message)}`);
      }
    }
  };

  /** Record the Turn as failed; the run error to relay instead when that fails, else null. */
  const recordFailure = async (message: string): Promise<string | null> => {
    try {
      await turn.failed(message);
      return null;
    } catch (error) {
      console.error(`Saving a failed Turn's Activity entry failed session_id=${sessionId}`, error);
      return runErrorFrame(`${message}; its Activity entry could not be saved: ${reason(error)}`, 'TURN_ACTIVITY_FAILED');
    }
  };

  /** The run error that ends the Turn, relayed once the Turn is recorded as failed. */
  const failure = async (message: string, code: string): Promise<string> =>
    (await recordFailure(message)) ?? runErrorFrame(message, code);

  /**
   * Record the outcome a frame's terminal event ends the Turn with: a finished run's completion, started
   * without waiting for it, or a run error's failure. The error frame to relay in its place when that fails, else null.
   */
  const terminalError = async (events: Frame['events'], frameReadAt: number): Promise<string | null> => {
    if (events.some(({ type }) => type === EventType.RUN_FINISHED)) {
      terminal = true;
      endTiming = { readAt: frameReadAt, summarized: complete(outcome.answer() ?? '') };
      return null;
    }
    const runError = events.find(({ type }) => type === EventType.RUN_ERROR);
    return runError === undefined ? null : recordFailure(String(runError.message));
  };

  /** Record readiness before its RUN_STARTED frame, or classify why it could not be recorded. */
  const readinessError = async (events: Frame['events']): Promise<string | null> => {
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

  const saveFrames = async (frames: Frame[]): Promise<{ out: string; failed: boolean }> => {
    let out = '';
    for (const { text, edits, events, readAt: frameReadAt } of frames) {
      // Log only frames already checked for decoded credentials and delta prefixes.
      logRunErrors(events);
      for (const edit of edits) {
        try {
          // eslint-disable-next-line no-await-in-loop -- saves each edit in stream order, before its frame is relayed
          await turn.saveAgentDocumentEdit(edit);
        } catch (error) {
          console.error('Saving an agent document edit failed', error);
          const message = `The agent's edit could not be saved: ${error instanceof Error ? error.message : String(error)}`;
          // eslint-disable-next-line no-await-in-loop -- the stream ends with this error
          return { out: `${out}${await failure(message, 'AGENT_DOCUMENT_SAVE_FAILED')}`, failed: true };
        }
      }
      outcome.observe(events);
      // eslint-disable-next-line no-await-in-loop -- readiness is recorded before this frame is relayed
      const readiness = await readinessError(events);
      if (readiness !== null) return { out: `${out}${readiness}`, failed: true };
      // eslint-disable-next-line no-await-in-loop -- a failed Turn's outcome is saved before its terminal frame is relayed
      const error = await terminalError(events, frameReadAt);
      if (error !== null) return { out: `${out}${error}`, failed: true };
      out += text;
    }
    return { out, failed: false };
  };

  const saved = async (frames: Frame[], done: boolean): Promise<{ out: string; failed: boolean }> => {
    const ready: Frame[] = [];
    let credentialLeak = false;
    for (const next of frames) {
      if (guard.leaks(next.text, next.events)) {
        credentialLeak = true;
        break;
      }
      withheld.push(next);
      // Keep whole frames in order until a message or tool call's possible credential prefix
      // is disproved or its message/tool call ends. Ordinary deltas stream immediately.
      // Prefixes are bounded by known credential representations; queued frames wait for
      // every unresolved message or tool call, including interleaved frames.
      if (!guard.hasPendingPrefix()) ready.push(...withheld.splice(0));
    }
    // No later delta can complete a prefix once the upstream stream ends.
    if (done && !credentialLeak) ready.push(...withheld.splice(0));
    const prior = await saveFrames(ready);
    if (prior.failed || !credentialLeak) return prior;
    if (guard.wroteHeld()) {
      console.error(`${upstream.label} streamed into an earlier message the client did not send session_id=${sessionId}; the stream was withheld`);
      const unchecked = await failure("The agent's answer wrote to an earlier message the Chat Service never saw, so it was withheld", 'TURN_EARLIER_MESSAGE_IN_STREAM');
      return { out: `${prior.out}${unchecked}`, failed: true };
    }
    console.error(`${upstream.label} streamed a Turn credential session_id=${sessionId}; the stream was withheld`);
    const leaked = await failure("The agent's answer carried the Turn's credentials, so it was withheld", 'TURN_CREDENTIALS_IN_STREAM');
    return { out: `${prior.out}${leaked}`, failed: true };
  };

  /** One upstream read's relayable text, and whether the relayed stream ends with it. */
  const relayNext = async (): Promise<{ out: string; end: boolean }> => {
    let frames: Frame[];
    let done = false;
    try {
      const chunk = await reader.read();
      readAt = Date.now();
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
      terminal = true;
      console.error(`${upstream.label} stream failed session_id=${sessionId} code=AGENTCORE_UPSTREAM_STREAM_ERROR`, error);
      const failed = await failure(`${upstream.label} stream failed: ${reason(error)}`, 'AGENTCORE_UPSTREAM_STREAM_ERROR');
      frames = [...flush(), { text: failed, edits: [], events: [], readAt }];
      done = true;
    }
    const { out, failed } = await saved(frames, done);
    if (failed && !done) await reader.cancel();
    if (done && !failed && !terminal) {
      console.error(`${upstream.label} stream ended before the Turn finished session_id=${sessionId} code=AGENTCORE_UPSTREAM_STREAM_ERROR`);
      const failed = await failure(`${upstream.label} stream ended before the Turn finished`, 'AGENTCORE_UPSTREAM_STREAM_ERROR');
      return { out: `${out}${failed}`, end: true };
    }
    return { out, end: done || failed };
  };

  // A client that goes away cancels the stream while a pull may still be reading: reads take turns, and the end is told once.
  let reading: Promise<unknown> = Promise.resolve();
  let ending: Promise<unknown> | undefined;
  let sentFailure: TurnFailure | undefined;
  const relayInOrder = (): Promise<{ out: string; end: boolean }> => {
    const next = reading.then(async () => {
      if (ending !== undefined) return { out: '', end: true };
      const relayed = await relayNext();
      sentFailure = lastRunError(relayed.out) ?? sentFailure;
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
      let next: { out: string; end: boolean };
      try {
        do {
          // eslint-disable-next-line no-await-in-loop -- each read depends on the frames before it
          next = await relayInOrder();
        } while (next.out === '' && !next.end);
      } finally {
        clearTimeout(timer);
      }
      if (next.out !== '') controller.enqueue(encoder.encode(next.out));
      if (!next.end) return;
      const endFailure = await ending;
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
    async cancel() {
      cancelled = true;
      // Only an explicit Stop stops a Turn: one whose client went away runs on, its edits and summary
      // saved and its failure logged as with a client.
      let next: { out: string; end: boolean };
      do {
        // eslint-disable-next-line no-await-in-loop -- each read depends on the frames before it
        next = await relayInOrder();
      } while (!next.end);
      const endFailure = await ending;
      logEnd('gone', endFailure !== undefined);
    },
  });
}
