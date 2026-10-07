import { awsFetch } from './aws.js';
import { type TurnActivity, type TurnSummary } from './session-metadata.js';

/** A finished Turn as the summary model reads it: the user's request and the agent's last answer. */
export interface FinishedTurn {
  request: string;
  answer: string;
}

export type TurnSummarizer = (turn: FinishedTurn) => Promise<TurnSummary>;

/** Where the summary model is called: its Bedrock Converse URL, signed for this region. */
export interface TurnSummaryModel {
  region: string;
  url: string;
}

/** The model Turn summaries run on; the production stack's Bedrock grant (`TURN_SUMMARY_MODEL`) names it too. */
const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const SUMMARY_TOOL = 'turn_summary';

const SYSTEM_PROMPT = `You write the activity log entry for one task an AI agent finished for its user.
You are given, as JSON, the user's request and the agent's last answer.
Answer with the ${SUMMARY_TOOL} tool: a title of two to five words naming the task, and a one-line summary, in the past tense, of what the agent did or found.`;

export function turnSummaryModelFromEnv(env: NodeJS.ProcessEnv, region: string): TurnSummaryModel {
  const endpoint = (env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME || `https://bedrock-runtime.${region}.amazonaws.com`).replace(/\/+$/, '');
  return { region, url: `${endpoint}/model/${encodeURIComponent(env.BOTCUBE_TURN_SUMMARY_MODEL || MODEL_ID)}/converse` };
}

/** The summary model on Bedrock, signed by the Chat Service's AWS credentials. */
export function bedrockTurnSummarizer({ region, url }: TurnSummaryModel): TurnSummarizer {
  return async (turn) => {
    const response = await awsFetch('bedrock', region, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        system: [{ text: SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: JSON.stringify(turn) }] }],
        inferenceConfig: { maxTokens: 200, temperature: 0 },
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: SUMMARY_TOOL,
                description: "Record the task's activity log entry.",
                inputSchema: {
                  json: {
                    type: 'object',
                    properties: {
                      title: { type: 'string', description: 'Two to five words naming the task.' },
                      summary: { type: 'string', description: 'One line: what the agent did or found.' },
                    },
                    required: ['title', 'summary'],
                  },
                },
              },
            },
          ],
          toolChoice: { tool: { name: SUMMARY_TOOL } },
        },
      }),
    });
    if (!response.ok) throw new Error(`The summary model answered HTTP ${response.status}`);
    return summaryFrom(await response.json());
  };
}

function summaryFrom(body: unknown): TurnSummary {
  const content = (body as { output?: { message?: { content?: unknown } } } | null)?.output?.message?.content;
  const input = Array.isArray(content)
    ? (content as { toolUse?: { name?: unknown; input?: unknown } }[]).find(({ toolUse }) => toolUse?.name === SUMMARY_TOOL)
        ?.toolUse?.input
    : undefined;
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
  unsaved.add(saving);
  try {
    const summary = await summarize(turn).catch(async (error: unknown) => {
      await save({ ...finished, failed: firstLine(`The Turn summary could not be made: ${message(error)}`) });
      throw error;
    });
    await save({ ...finished, summary });
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

