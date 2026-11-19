import {
  RiBookOpenLine, RiBrain2Line, RiCalendarLine, RiChat4Line, RiCloseLine, RiFileTextLine, RiFolderLine, RiGlobalLine, RiListUnordered,
  RiPencilLine, RiRobot2Line, RiSearchLine, RiShutDownLine, RiTerminalLine, RiToolsLine, type RemixiconComponentType,
} from "@remixicon/react";
import { UNANSWERED_CALL } from "botcube-ui-web/interrupted-call";

/**
 * Each Worklog icon with its drawn ink in Remix's 24-unit box (x, y, width, height) and its optical scale. A step's icon
 * shows only its ink, at 0.6px a unit times its scale, so every drawing reads about 12px and the ✕ about 10px, and its
 * left edge and centre are the ink's own. The ink boxes are measured, not matched on path data.
 */
export const ICONS = {
  ran: { Icon: RiTerminalLine, ink: [2.51, 4.93, 18.49, 16.07], scale: 1.08 },
  read: { Icon: RiBookOpenLine, ink: [2, 3, 20, 20], scale: 1 },
  edited: { Icon: RiPencilLine, ink: [3, 2.92, 17.97, 17.97], scale: 1.11 },
  listed: { Icon: RiFolderLine, ink: [2, 3, 20, 18], scale: 1 },
  searched: { Icon: RiSearchLine, ink: [2, 2, 20.31, 20.31], scale: 1 },
  web: { Icon: RiGlobalLine, ink: [2, 2, 20, 20], scale: 1 },
  helper: { Icon: RiRobot2Line, ink: [0, 0.5, 24, 20.5], scale: 0.85 },
  plan: { Icon: RiListUnordered, ink: [3, 3.5, 18, 16.9], scale: 1.11 },
  schedule: { Icon: RiCalendarLine, ink: [2, 1, 20, 20], scale: 1 },
  artifact: { Icon: RiFileTextLine, ink: [3, 2, 18, 20], scale: 1 },
  tool: { Icon: RiToolsLine, ink: [3, 3.07, 17.29, 17.29], scale: 1.16 },
  thought: { Icon: RiBrain2Line, ink: [2, 2, 20, 20], scale: 1 },
  start: { Icon: RiShutDownLine, ink: [2, 2, 20, 20], scale: 1 },
  answer: { Icon: RiChat4Line, ink: [2, 3, 20, 19.5], scale: 1 },
  failed: { Icon: RiCloseLine, ink: [5.64, 5.64, 12.73, 12.73], scale: 1.34 },
} satisfies Record<string, { Icon: RemixiconComponentType; ink: readonly [number, number, number, number]; scale: number }>;

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
