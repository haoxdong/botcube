import { createHash } from 'node:crypto';
import type { DeploymentConfig } from 'botcube-deployment-config';
import type { ModelsWire } from 'botcube-deployment-config/blocks';
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

/** Where the summary model is called on Bedrock: its Converse URL, signed for this region. */
export interface BedrockSummaryModel {
  kind: 'bedrock';
  region: string;
  url: string;
}

/** The summary model on an OpenAI-compatible Endpoint (the Deployment Config's `models` section, ADR 0091). */
export interface OpenAICompatibleSummaryModel {
  kind: 'openai-compatible';
  endpoint: Endpoint;
  model: string;
  /** The OpenAI API the Endpoint is called over. */
  wire: ModelsWire;
}

/** Where the summary model is called. */
export type TurnSummaryModel = BedrockSummaryModel | OpenAICompatibleSummaryModel;

/** The model Turn summaries run on; the production stack's Bedrock grant (`TURN_SUMMARY_MODEL`) names it too. */
const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const SUMMARY_TOOL = 'turn_summary';

const SYSTEM_PROMPT = `You write the activity log entry for one task an AI agent finished for its user.
You are given, as JSON, the user's request and the agent's last answer.
Answer with the ${SUMMARY_TOOL} tool: a title of two to five words naming the task, and a one-line summary, in the past tense, of what the agent did or found.`;

/**
 * The summary model the Deployment Config's `models` section names: the `turnSummaryModel` on its OpenAI-compatible
 * Endpoint, else Bedrock's in this region.
 */
export function turnSummaryModel(models: DeploymentConfig['models'], env: NodeJS.ProcessEnv, region: string): TurnSummaryModel {
  if (models.kind === 'openai-compatible') {
    return { kind: 'openai-compatible', endpoint: endpoint('models', models, env), model: models.turnSummaryModel, wire: models.wire };
  }
  const bedrock = (env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME || `https://bedrock-runtime.${region}.amazonaws.com`).replace(/\/+$/, '');
  return { kind: 'bedrock', region, url: `${bedrock}/model/${encodeURIComponent(MODEL_ID)}/converse` };
}

/** The summarizer for this summary model. */
export function turnSummarizer(model: TurnSummaryModel): TurnSummarizer {
  switch (model.kind) {
    case 'bedrock': return bedrockTurnSummarizer(model);
    case 'openai-compatible': return openAICompatibleTurnSummarizer(model);
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

/** The forced summary tool's call on each wire: its path and request body, and the call's arguments in the answer. */
const SUMMARY_CALL: { readonly [W in ModelsWire]: { path: string; body(model: string, turn: FinishedTurn): unknown; arguments(answer: unknown): string | undefined } } = {
  'chat-completions': {
    path: '/chat/completions',
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
    arguments: (answer) => chatCompletion.safeParse(answer).data?.choices[0]?.message.tool_calls?.find((call) => call.function.name === SUMMARY_TOOL)?.function.arguments,
  },
  responses: {
    path: '/responses',
    body: (model, turn) => ({
      model,
      instructions: SYSTEM_PROMPT,
      input: [{ role: 'user', content: JSON.stringify(turn) }],
      max_output_tokens: 512,
      temperature: 0,
      tools: [{ type: 'function', name: SUMMARY_TOOL, description: SUMMARY_TOOL_DESCRIPTION, parameters: SUMMARY_PARAMETERS }],
      tool_choice: { type: 'function', name: SUMMARY_TOOL },
    }),
    arguments: (answer) => responsesAnswer.safeParse(answer).data?.output.find((item) => item.type === 'function_call' && item.name === SUMMARY_TOOL)?.arguments,
  },
};

/** The summary model on an OpenAI-compatible endpoint, over its wire, answering with the same forced tool as on Bedrock. */
export function openAICompatibleTurnSummarizer({ endpoint, model, wire }: OpenAICompatibleSummaryModel): TurnSummarizer {
  const call = SUMMARY_CALL[wire];
  return async (turn) => {
    const response = await endpoint.fetch(call.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(call.body(model, turn)),
    });
    if (!response.ok) throw new Error(`The summary model answered HTTP ${response.status}`);
    const args = call.arguments(await response.json());
    return summaryInput(args === undefined ? undefined : parsedArguments(args));
  };
}

function parsedArguments(text: string): unknown {
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
