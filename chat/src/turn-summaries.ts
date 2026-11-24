import { createParser } from 'eventsource-parser';
import type { AgentModel } from './models.js';
import type { Requester } from './requester.js';
import { createHash } from 'node:crypto';
import type { BotCubeConfig } from 'botcube-config';
import { isGatewayProvider, providerModel } from 'botcube-config/blocks';
import { z } from 'zod';
import { awsFetch } from './aws.js';
import { endpoint, type Endpoint } from './endpoint.js';
import { SessionDeletedError, type TurnActivity, type TurnSummary } from './session-metadata.js';

/** A finished Turn as the summary model reads it: the user's request and the agent's last answer. */
export interface FinishedTurn {
  request: string;
  answer: string;
}

export type TurnSummarizer = (turn: FinishedTurn) => Promise<TurnSummary>;

export type CompletedTurnSummarizer = (
  turn: FinishedTurn,
  context: { requester: Requester; sessionId: string; model: AgentModel },
) => Promise<TurnSummary>;

/** Where the summary model is called on Bedrock: its Converse URL, signed for this region. */
export interface BedrockSummaryModel {
  kind: 'bedrock';
  region: string;
  url: string;
}

/** The summary model on the model gateway (the BotCube Config's `modelGateway`, ADR 0091), called on its provider's own API. */
export interface GatewaySummaryModel {
  kind: 'openai-compatible';
  endpoint: Endpoint;
  model: string;
  api: GatewayApi;
}

/** Where the summary model is called. */
export type TurnSummaryModel = BedrockSummaryModel | GatewaySummaryModel;

/** The model Turn summaries run on; the production stack's Bedrock grant (`TURN_SUMMARY_MODEL`) names it too. */
const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const SUMMARY_TOOL = 'turn_summary';

const SYSTEM_PROMPT = `You write the activity log entry for one task an AI agent finished for its user.
You are given, as JSON, the user's request and the agent's last answer.
Answer with the ${SUMMARY_TOOL} tool: a title of two to five words naming the task, and a one-line summary, in the past tense, of what the agent did or found.`;

/**
 * The summary model the BotCube Config's `modelGateway` names: the gateway's `turnSummaryModel`, `provider:model`, where
 * `providers` serves that provider or else at the gateway's URL, as the Harness calls it; else Bedrock's in this region.
 */
export function turnSummaryModel(models: BotCubeConfig['integrations']['modelGateway'], env: NodeJS.ProcessEnv, region: string, proxy?: BotCubeConfig['integrations']['proxy']): TurnSummaryModel {
  if (models.kind === 'openai-compatible') {
    const summary = providerModel(models.turnSummaryModel);
    if (summary === undefined || !isGatewayProvider(summary.provider)) throw new Error(`turnSummaryModel ${models.turnSummaryModel}: not a gateway model, which the BotCube Config's schema checks`);
    const provider = summary.provider;
    const api = provider === 'anthropic' ? 'messages' : models.providers?.openai?.useResponsesApi ? 'responses' : 'chat-completions';
    const route = models.providers?.[provider];
    const reached = { ...models, ...route, url: route?.url ?? models.url, credential: route?.credential ?? models.credential };
    return { kind: 'openai-compatible', endpoint: endpoint('models', reached, env, proxy), model: summary.model, api };
  }
  const bedrock = (env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME || `https://bedrock-runtime.${region}.amazonaws.com`).replace(/\/+$/, '');
  return { kind: 'bedrock', region, url: `${bedrock}/model/${encodeURIComponent(MODEL_ID)}/converse` };
}

/** The summarizer for this summary model. */
export function turnSummarizer(model: TurnSummaryModel): TurnSummarizer {
  switch (model.kind) {
    case 'bedrock': return bedrockTurnSummarizer(model);
    case 'openai-compatible': return gatewayTurnSummarizer(model);
  }
}

const SUMMARY_PARAMETERS = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Two to five words naming the task.' },
    summary: { type: 'string', description: 'One line: what the agent did or found.' },
  },
  required: ['title', 'summary'],
};

const SUMMARY_TOOL_DESCRIPTION = "Record the task's activity log entry.";

const chatCompletion = z.object({
  choices: z.array(z.object({
    message: z.object({ tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) })).optional() }),
  })),
});
const responsesAnswer = z.object({
  output: z.array(z.object({ type: z.string(), name: z.string().optional(), arguments: z.string().optional() })),
});
const messagesAnswer = z.object({
  content: z.array(z.object({ type: z.string(), name: z.string().optional(), input: z.unknown() })),
});

type GatewayApi = 'chat-completions' | 'responses' | 'messages';

/**
 * The forced summary tool's call on each provider API, as LangChain's `init_chat_model` calls it for the Harness:
 * its path, headers and request body, and the call's input in the answer.
 */
const SUMMARY_CALL: { readonly [A in GatewayApi]: { path: string; headers: Record<string, string>; body(model: string, turn: FinishedTurn): unknown; input(answer: unknown): unknown } } = {
  'chat-completions': {
    path: '/chat/completions',
    headers: {},
    body: (model, turn) => ({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(turn) },
      ],
      max_tokens: 512,
      temperature: 0,
      tools: [{ type: 'function', function: { name: SUMMARY_TOOL, description: SUMMARY_TOOL_DESCRIPTION, parameters: SUMMARY_PARAMETERS } }],
      tool_choice: { type: 'function', function: { name: SUMMARY_TOOL } },
    }),
    input: (answer) => parsedArguments(chatCompletion.safeParse(answer).data?.choices[0]?.message.tool_calls?.find((call) => call.function.name === SUMMARY_TOOL)?.function.arguments),
  },
  responses: {
    path: '/responses',
    headers: {},
    body: (model, turn) => ({
      model,
      instructions: SYSTEM_PROMPT,
      input: [{ role: 'user', content: JSON.stringify(turn) }],
      max_output_tokens: 512,
      temperature: 0,
      tools: [{ type: 'function', name: SUMMARY_TOOL, description: SUMMARY_TOOL_DESCRIPTION, parameters: SUMMARY_PARAMETERS }],
      tool_choice: { type: 'function', name: SUMMARY_TOOL },
    }),
    input: (answer) => parsedArguments(responsesAnswer.safeParse(answer).data?.output.find((item) => item.type === 'function_call' && item.name === SUMMARY_TOOL)?.arguments),
  },
  messages: {
    path: '/v1/messages',
    headers: { 'anthropic-version': '2023-06-01' },
    body: (model, turn) => ({
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(turn) }],
      max_tokens: 512,
      temperature: 0,
      tools: [{ name: SUMMARY_TOOL, description: SUMMARY_TOOL_DESCRIPTION, input_schema: SUMMARY_PARAMETERS }],
      tool_choice: { type: 'tool', name: SUMMARY_TOOL },
    }),
    input: (answer) => messagesAnswer.safeParse(answer).data?.content.find((block) => block.type === 'tool_use' && block.name === SUMMARY_TOOL)?.input,
  },
};

/** The summary model on the model gateway, on its provider's API, answering with the same forced tool as on Bedrock. */
export function gatewayTurnSummarizer({ endpoint, model, api }: GatewaySummaryModel): TurnSummarizer {
  const call = SUMMARY_CALL[api];
  return async (turn) => {
    const response = await endpoint.fetch(call.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...call.headers },
      body: JSON.stringify(call.body(model, turn)),
    });
    if (!response.ok) throw new Error(`The summary model answered HTTP ${response.status}`);
    return summaryInput(call.input(await response.json()));
  };
}

export async function summarizePlanTurn(
  model: string,
  turn: FinishedTurn,
  relay: (body: string) => Promise<Response>,
): Promise<TurnSummary> {
  const response = await relay(JSON.stringify({
    model,
    instructions: SYSTEM_PROMPT,
    input: [{ role: 'user', content: JSON.stringify(turn) }],
    tools: [{ type: 'function', name: SUMMARY_TOOL, description: SUMMARY_TOOL_DESCRIPTION, parameters: SUMMARY_PARAMETERS }],
    tool_choice: 'auto',
    stream: true,
    store: false,
  }));
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw planSummaryError(body, `HTTP ${response.status}`);
  }
  let completed: unknown;
  const output: unknown[] = [];
  const parser = createParser({ onEvent({ data }) {
    if (data === '[DONE]') return;
    const event = fields(parsedArguments(data));
    if (event.type === 'error') throw planSummaryError(event, 'a response stream error');
    if (event.type === 'response.output_item.done') output.push(event.item);
    if (event.type === 'response.completed') completed = event.response;
  } });
  parser.feed(await response.text());
  if (completed === undefined) throw new Error('The plan summary response stream ended before completion');
  return summaryInput(SUMMARY_CALL.responses.input({ output }) ?? SUMMARY_CALL.responses.input(completed));
}

function planSummaryError(body: unknown, fallback: string): Error {
  const error = fields(fields(body).error);
  if (error.type === 'plan_usage' && typeof error.message === 'string' && error.message.trim()) {
    return new Error(error.message);
  }
  return new Error(`The plan summary model answered ${fallback}`);
}

function parsedArguments(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The summary model on Bedrock, signed by the Chat Service's AWS credentials. */
export function bedrockTurnSummarizer({ region, url }: BedrockSummaryModel): TurnSummarizer {
  return async (turn) => {
    const response = await awsFetch('bedrock', region, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: JSON.stringify(turn) }] }],
        inferenceConfig: { maxTokens: 512, temperature: 0 },
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: SUMMARY_TOOL,
                description: SUMMARY_TOOL_DESCRIPTION,
                inputSchema: { json: SUMMARY_PARAMETERS },
              },
            },
          ],
          toolChoice: { tool: { name: SUMMARY_TOOL } },
        },
      }),
    });
    if (!response.ok) throw new Error(`The summary model answered HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    try {
      return summaryFrom(body);
    } catch (error) {
      reportRejectedSummary(response, url, bytes, body);
      throw error;
    }
  };
}

const object = z.record(z.string(), z.unknown());
const stopReason = z.enum(['max_tokens', 'tool_use', 'end_turn']);
const tokenCount = z.number().int().nonnegative();
const fields = (value: unknown) => object.safeParse(value).data ?? {};
const valueType = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const nonempty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

/** Failure-only metadata: no prompt, title, summary, arbitrary model strings or header dump. */
function reportRejectedSummary(response: Response, url: string, bytes: Uint8Array, body: unknown): void {
  const root = fields(body);
  const content = fields(fields(root.output).message).content;
  const tool = Array.isArray(content) ? content.map(fields).find((block) => fields(block.toolUse).name === SUMMARY_TOOL)?.toolUse : undefined;
  const input = fields(fields(tool).input);
  const usage = fields(root.usage);
  const model = /\/model\/([^/]+)\/converse$/.exec(new URL(url).pathname)?.[1];
  const requestId = response.headers.get('x-amzn-requestid');
  console.error('Turn summary response rejected [DEBUG-3779]', {
    modelId: model === undefined ? null : decodeURIComponent(model),
    requestId: requestId !== null && /^[a-zA-Z0-9-]{1,128}$/.test(requestId) ? requestId : null,
    rawResponseSHA256: createHash('sha256').update(bytes).digest('hex'),
    stopReason: stopReason.safeParse(root.stopReason).data ?? null,
    summaryToolPresent: tool !== undefined, toolInputType: valueType(fields(tool).input),
    titleType: valueType(input.title), titleNonempty: nonempty(input.title),
    summaryType: valueType(input.summary), summaryNonempty: nonempty(input.summary),
    usage: {
      inputTokens: tokenCount.safeParse(usage.inputTokens).data ?? null,
      outputTokens: tokenCount.safeParse(usage.outputTokens).data ?? null,
      totalTokens: tokenCount.safeParse(usage.totalTokens).data ?? null,
    },
  });
}

function summaryFrom(body: unknown): TurnSummary {
  const content = (body as { output?: { message?: { content?: unknown } } } | null)?.output?.message?.content;
  const input = Array.isArray(content)
    ? (content as { toolUse?: { name?: unknown; input?: unknown } }[]).find(({ toolUse }) => toolUse?.name === SUMMARY_TOOL)
        ?.toolUse?.input
    : undefined;
  return summaryInput(input);
}

function summaryInput(input: unknown): TurnSummary {
  const { title, summary } = (input ?? {}) as { title?: unknown; summary?: unknown };
  if (typeof title !== 'string' || !title.trim() || typeof summary !== 'string' || !summary.trim()) {
    throw new Error('The summary model answered without a title and summary');
  }
  return { title: title.trim(), summary: summary.trim() };
}

const firstLine = (text: string) => text.trim().replace(/\n[\s\S]*/, '');

/** The Turn-summary alarm's metric filter matches this literal. */
const TURN_SUMMARY_FAILED = 'Turn summary failed';

/**
 * The Sessions whose Turn summary is still being saved: it runs on after the Turn's stream closed.
 * Each save is its own entry, so two Turns of one Session count twice.
 */
const unsaved = new Set<{ sessionId: string }>();

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A Turn finishing now, as the Activity lists it without a summary: the first line of its
 * request, and the first line of the run error it failed with, if it failed.
 */
export function turnActivity(request: string, failed?: string): TurnActivity {
  return {
    request: firstLine(request),
    completedAt: new Date().toISOString(),
    ...(failed === undefined ? {} : { failed: firstLine(failed) }),
  };
}

/**
 * Save a finished Turn as the Activity lists it: its request's first line and when it finished,
 * with its summary. A failed summary saves the Turn without one, failed on why, then
 * raises the Turn-summary alarm and propagates, as does a failed save. A deleted Session keeps nothing.
 */
export async function recordTurnSummary(
  summarize: TurnSummarizer,
  save: (finished: TurnActivity) => Promise<void>,
  sessionId: string,
  turn: FinishedTurn,
): Promise<void> {
  const finished = turnActivity(turn.request);
  const saving = { sessionId };
  const saveActivity = async (activity: TurnActivity) => {
    try {
      await save(activity);
    } catch (error) {
      if (!(error instanceof SessionDeletedError)) throw error;
      console.info(`Turn summary discarded for deleted Session session_id=${sessionId}`);
    }
  };
  unsaved.add(saving);
  try {
    const summary = await summarize(turn).catch(async (error: unknown) => {
      await saveActivity({ ...finished, failed: firstLine(`The Turn summary could not be made: ${message(error)}`) });
      throw error;
    });
    await saveActivity({ ...finished, summary });
  } catch (error) {
    console.error(`${TURN_SUMMARY_FAILED} session_id=${sessionId}`, error);
    throw new Error(`The Turn summary could not be saved: ${message(error)}`, { cause: error });
  } finally {
    unsaved.delete(saving);
  }
}

/** Raise the Turn-summary alarm for each summary a stopping Chat Service has not saved yet. */
export function reportUnsavedTurnSummaries(): void {
  for (const { sessionId } of unsaved) {
    console.error(`${TURN_SUMMARY_FAILED} session_id=${sessionId}`, new Error('The Chat Service stopped before the Turn summary was saved'));
  }
}
