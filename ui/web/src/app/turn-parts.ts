import { publishedOf, type Published } from "./artifact-published";
import { showsProposalCard } from "./worklog-tools";

/**
 * A chat message as a Worklog reads it. A replayed agent, reasoning or tool message carries `started_at` and `ended_at`
 * in its metadata, in epoch ms; a user message, and one recorded before the stamps, has none.
 */
export type TurnMessage = {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: readonly { id: string; function: { name: string; arguments?: string } }[] | undefined;
  toolCallId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

/** The call whose card waits on the user: it shows beside the answer, never folded away. */
export const PROPOSAL = "propose_scheduled_task";

type Call = NonNullable<TurnMessage["toolCalls"]>[number];

const text = (message: TurnMessage) => (typeof message.content === "string" ? message.content.trim() : "");
const contentOf = (result: TurnMessage | undefined) => (typeof result?.content === "string" ? result.content : undefined);

/** An Artifact call publishes unless it lists or reads; a call whose arguments are still streaming publishes. */
function publishes(call: Call): boolean {
  try {
    const { action } = JSON.parse(call.function.arguments || "{}") as { action?: unknown };
    return action === undefined || action === "publish";
  } catch {
    return true;
  }
}

/**
 * A Turn's Artifact publishes: `shown` holds each call that shows as a card (pending or published), `published` each
 * published call's Artifact. A refused publish, a list and a read are neither: the Worklog keeps them.
 */
function publishesIn(turn: readonly TurnMessage[]): { shown: Set<string>; published: Map<string, Published> } {
  const shown = new Set<string>();
  const published = new Map<string, Published>();
  for (const call of turn.flatMap((m) => m.toolCalls ?? [])) {
    if (call.function.name !== "Artifact" || !publishes(call)) continue;
    const result = turn.find((m) => m.role === "tool" && m.toolCallId === call.id);
    const content = contentOf(result);
    const artifact = content === undefined ? null : publishedOf(content);
    if (result === undefined || artifact !== null) shown.add(call.id);
    if (artifact !== null) published.set(call.id, artifact);
  }
  return { shown, published };
}

/**
 * Once a Turn's answer shows, the Artifacts it published move into the answer's bubble as cards, once each. A message
 * that only publishes moves with them (`moved`, with its results); one that also says or does something else, or
 * whose publish was refused, folds into the Worklog (`folded`), its published results with it.
 */
function intoAnswer(turn: readonly TurnMessage[], published: ReadonlyMap<string, Published>): { moved: Set<string>; folded: Set<string>; cards: Published[] } {
  const moved = new Set<string>();
  const folded = new Set<string>();
  const cards = new Map<string, Published>();
  for (const m of turn) {
    const calls = m.toolCalls ?? [];
    if (!calls.some(({ id }) => published.has(id))) continue;
    const into = text(m) === "" && calls.every(({ id }) => published.has(id)) ? moved : folded;
    into.add(m.id);
    for (const { id } of calls) {
      const artifact = published.get(id);
      if (artifact === undefined) continue;
      cards.set(artifact.id, artifact);
      const result = turn.find((other) => other.toolCallId === id);
      if (result !== undefined) into.add(result.id);
    }
  }
  return { moved, folded, cards: [...cards.values()] };
}

export type Part = "question" | "work" | "shown" | "card";

/** A Turn's answers: its texts after its last tool call, else its last text that calls no tool. */
function answersOf(turn: readonly TurnMessage[]): TurnMessage[] {
  const texts = turn.filter((m) => m.role === "assistant" && text(m) !== "" && !m.toolCalls?.length);
  const afterCalls = turn.slice(turn.findLastIndex((m) => m.toolCalls?.length) + 1).filter((m) => texts.includes(m));
  return afterCalls.length > 0 ? afterCalls : texts.slice(-1);
}

/** The calls whose cards show beside the answer: a proposed schedule with its result, and an Artifact publish. */
function shownCallsOf(turn: readonly TurnMessage[], artifacts: ReadonlySet<string>): Set<string> {
  const shown = new Set(artifacts);
  for (const call of turn.flatMap((m) => m.toolCalls ?? [])) {
    if (call.function.name !== PROPOSAL) continue;
    const result = turn.find((other) => other.toolCallId === call.id);
    if (result !== undefined && showsProposalCard(contentOf(result))) shown.add(call.id);
  }
  return shown;
}

/**
 * Each message's part in its Turn, and the Artifacts each answer shows. The answers are the Turn's texts after its last
 * tool call, each its own bubble; a text before a call is a note, unless no text follows the last call: then the Turn's
 * last text that calls no tool is its answer. While the last Turn runs they show only while its latest message is one: a
 * note reads as an answer until its tool call arrives. A proposed schedule and its result show too. An Artifact the
 * Turn published shows as a card: in its last answer's bubble once that answer shows, on its own
 * until then. A refused publish, a list and a read are work: the agent recovers from them, and the Worklog keeps them.
 * A scheduled run's card, which the Chat Service posts to the Main Chat with no question before it, is no Turn's work:
 * it ends the Turn before it and shows on its own.
 */
export function partsOf(messages: readonly TurnMessage[], isRunning: boolean): { parts: Map<string, Part>; cards: Map<string, Published[]> } {
  const parts = new Map<string, Part>();
  const cards = new Map<string, Published[]>();
  let turn: TurnMessage[] = [];
  const close = (last: boolean) => {
    const answers = answersOf(turn);
    const answered = !(last && isRunning) || answers.at(-1) === turn.at(-1);
    const artifacts = publishesIn(turn);
    const shownCalls = shownCallsOf(turn, artifacts.shown);
    const answer = answered ? answers.at(-1) : undefined;
    const { moved, folded, cards: answerCards } = answer === undefined ? { moved: new Set<string>(), folded: new Set<string>(), cards: [] } : intoAnswer(turn, artifacts.published);
    for (const m of turn) {
      const shown = (answered && answers.includes(m)) || (m.toolCalls?.some(({ id }) => shownCalls.has(id)) ?? false) || shownCalls.has(m.toolCallId ?? "");
      parts.set(m.id, moved.has(m.id) ? "card" : shown && !folded.has(m.id) ? "shown" : "work");
    }
    if (answer !== undefined && answerCards.length > 0) cards.set(answer.id, answerCards);
    turn = [];
  };
  for (const message of messages) {
    if (message.role === "user") {
      close(false);
      parts.set(message.id, "question");
    } else if (message.metadata?.scheduledRun !== undefined) {
      close(false);
      parts.set(message.id, "shown");
    } else turn.push(message);
  }
  close(true);
  return { parts, cards };
}
