import {
  RiBookOpenLine, RiBrain2Line, RiCalendarLine, RiChat4Line, RiCloseCircleLine, RiFileTextLine, RiFolderLine, RiGlobalLine,
  RiListUnordered, RiPencilLine, RiRobot2Line, RiSearchLine, RiShutDownLine, RiTerminalLine, RiToolsLine,
} from "@remixicon/react";
import { UNANSWERED_CALL } from "botcube-ui-web/interrupted-call";

/** Each Worklog step's Remix icon, stock and whole: every one draws at one size, so they share Remix's even weight. */
export const ICONS = {
  ran: RiTerminalLine,
  read: RiBookOpenLine,
  edited: RiPencilLine,
  listed: RiFolderLine,
  searched: RiSearchLine,
  web: RiGlobalLine,
  helper: RiRobot2Line,
  plan: RiListUnordered,
  schedule: RiCalendarLine,
  artifact: RiFileTextLine,
  tool: RiToolsLine,
  thought: RiBrain2Line,
  start: RiShutDownLine,
  answer: RiChat4Line,
  failed: RiCloseCircleLine,
};

export type StepIcon = keyof typeof ICONS;

/**
 * How each tool the harness offers reads: its name in its sheet's title, its verb done and running ("Ran", not
 * `execute`), its icon, and whether its argument is words rather than code, which its sheet shows in sans. Any other
 * tool reads by its name.
 */
const TOOLS: Record<string, { title: string; done: string; running: string; icon: StepIcon; prose?: true }> = {
  execute: { title: "Terminal", done: "Ran", running: "Running", icon: "ran" },
  read_file: { title: "Read file", done: "Read", running: "Reading", icon: "read" },
  write_file: { title: "Write file", done: "Wrote", running: "Writing", icon: "edited" },
  edit_file: { title: "Edit file", done: "Edited", running: "Editing", icon: "edited" },
  ls: { title: "List files", done: "Listed", running: "Listing", icon: "listed" },
  glob: { title: "Find files", done: "Found files", running: "Finding files", icon: "searched" },
  grep: { title: "Search files", done: "Searched files", running: "Searching files", icon: "searched" },
  web_search: { title: "Web search", done: "Searched the web", running: "Searching the web", icon: "web", prose: true },
  task: { title: "Helper", done: "Asked a helper", running: "Asking a helper", icon: "helper", prose: true },
  write_todos: { title: "Plan", done: "Updated plan", running: "Updating plan", icon: "plan", prose: true },
  Artifact: { title: "Artifact", done: "Artifact", running: "Artifact", icon: "artifact" },
  propose_scheduled_task: { title: "Schedule", done: "Proposed a schedule", running: "Proposing a schedule", icon: "schedule", prose: true },
};

/** The one argument that says what a call did: the command, the path, the plan's current item, the helper's brief. */
export function argumentOf(name: string, params: Record<string, unknown> | undefined): string | undefined {
  if (name === "write_todos" && Array.isArray(params?.todos)) {
    const todos = params.todos as { content?: string; status?: string }[];
    const now = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
    const done = todos.filter((t) => t.status === "completed").length;
    return `${done}/${todos.length} done${now?.content ? ` · ${now.content}` : ""}`;
  }
  for (const key of ["command", "file_path", "path", "description"]) {
    const value = params?.[key];
    if (typeof value === "string") return value;
  }
  return Object.values(params ?? {}).find((value): value is string => typeof value === "string");
}

export function lookOf(name: string) {
  const said = name.replace(/_/g, " ");
  return TOOLS[name] ?? { title: said.charAt(0).toUpperCase() + said.slice(1), done: said, running: said, icon: "tool" as const };
}

export function showsProposalCard(result: string | undefined): boolean {
  return result === undefined || (!result.startsWith("Error invoking tool 'propose_scheduled_task'") && !UNANSWERED_CALL.test(result));
}
