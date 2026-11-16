import { BotIcon, CalendarClockIcon, FilePenLineIcon, FileTextIcon, FolderSearchIcon, GlobeIcon, ListChecksIcon, SearchIcon, SquareTerminalIcon, WrenchIcon, type LucideIcon } from "lucide-react";
import { UNANSWERED_CALL } from "botcube-ui-web/interrupted-call";

/**
 * How each tool the harness offers reads: its name in its sheet's title, its verb done and running ("Ran", not
 * `execute`), its icon, and whether its argument is words rather than code, which reads in sans. Any other tool reads
 * by its name.
 */
const TOOLS: Record<string, { title: string; done: string; running: string; icon: LucideIcon; prose?: true }> = {
  execute: { title: "Terminal", done: "Ran", running: "Running", icon: SquareTerminalIcon },
  read_file: { title: "Read file", done: "Read", running: "Reading", icon: FileTextIcon },
  write_file: { title: "Write file", done: "Wrote", running: "Writing", icon: FilePenLineIcon },
  edit_file: { title: "Edit file", done: "Edited", running: "Editing", icon: FilePenLineIcon },
  ls: { title: "List files", done: "Listed", running: "Listing", icon: FolderSearchIcon },
  glob: { title: "Find files", done: "Found files", running: "Finding files", icon: FolderSearchIcon },
  grep: { title: "Search files", done: "Searched files", running: "Searching files", icon: SearchIcon },
  web_search: { title: "Web search", done: "Searched the web", running: "Searching the web", icon: GlobeIcon, prose: true },
  task: { title: "Helper", done: "Asked a helper", running: "Asking a helper", icon: BotIcon, prose: true },
  write_todos: { title: "Plan", done: "Updated plan", running: "Updating plan", icon: ListChecksIcon, prose: true },
  Artifact: { title: "Artifact", done: "Artifact", running: "Artifact", icon: FileTextIcon },
  propose_scheduled_task: { title: "Schedule", done: "Proposed a schedule", running: "Proposing a schedule", icon: CalendarClockIcon, prose: true },
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
  return TOOLS[name] ?? { title: said.charAt(0).toUpperCase() + said.slice(1), done: said, running: said, icon: WrenchIcon };
}

export function showsProposalCard(result: string | undefined): boolean {
  return result === undefined || (!result.startsWith("Error invoking tool 'propose_scheduled_task'") && !UNANSWERED_CALL.test(result));
}
