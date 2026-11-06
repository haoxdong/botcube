import { throwIfRefused } from "./refusal";

/**
 * A scheduled run as the Chat Service posts it to the Main Chat, stored with its message's `metadata`: the task's
 * title, when the run started, how it ended, and its answer or why not. Its request is `messageId` in `sideChat`;
 * a run that never reached its Side Chat, skipped or failed before it, has neither.
 */
export interface ScheduledRun {
  sideChat?: string;
  messageId?: string;
  title: string;
  ranAt: string;
  status: "done" | "failed" | "sign-in" | "skipped";
  text: string;
}

export const RUN_STATUS: Record<ScheduledRun["status"], { label: string; tone: "neutral" | "blue" | "danger" }> = {
  done: { label: "Done", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
  "sign-in": { label: "Needs sign-in", tone: "blue" },
  skipped: { label: "Skipped", tone: "neutral" },
};

/** A task the agent runs on its schedule, as the Chat Service's `/scheduled-tasks` lists it. */
export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  /** The Scheduler expression it runs on. */
  schedule: string;
  timezone: string;
  /** The model its runs use; absent, they use the account's default, the first of its models. */
  model?: string;
  /** Its first run, an ISO instant; absent for a one-off, whose schedule says when, and a schedule the Chat Service can't read. */
  startDate?: string;
  /** The stop time, an ISO instant, after which the task no longer runs. */
  endDate?: string;
  /** How many runs it makes before it leaves the account. */
  maxRuns?: number;
  /** How many of those runs it has made. */
  runsMade?: number;
  paused: boolean;
  /** The tool call ID of the proposal the task was confirmed from. */
  proposalId: string;
  /** When it next runs; absent while paused, and once it has ended. */
  nextRun?: string;
  /** Why its next run is unknown: the Chat Service cannot read its stored schedule. Absent while paused. */
  nextRunUnknown?: string;
  /** Past its stop time, or with no run left before it: it no longer runs, and can't resume until Edit moves the time. */
  ended: boolean;
  /** The Side Chat its runs post into, once a run has reached it; null before. */
  sideChat: string | null;
  /** How its latest run ended; absent before its first run. */
  lastRun?: { at: string; status: "done" | "failed" | "sign-in" };
}

async function answered<T>(response: Response, failure: string): Promise<T> {
  await throwIfRefused(response, failure);
  return (await response.json()) as T;
}

export async function listTasks(chatServiceUrl: string): Promise<ScheduledTask[]> {
  const response = await fetch(`${chatServiceUrl}/scheduled-tasks`, { credentials: "include", cache: "no-store" });
  return (await answered<{ tasks: ScheduledTask[] }>(response, "Scheduled tasks failed")).tasks;
}

export async function sendTask(chatServiceUrl: string, path: string, method: string, body: object, failure: string) {
  const response = await fetch(`${chatServiceUrl}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return answered<ScheduledTask>(response, failure);
}

/** A change to a task: its fields, with a start, a stop time or a count of runs cleared with null. */
export type TaskChanges = Partial<Omit<ScheduledTask, "startDate" | "endDate" | "maxRuns">> & {
  startDate?: string | null;
  endDate?: string | null;
  maxRuns?: number | null;
};
