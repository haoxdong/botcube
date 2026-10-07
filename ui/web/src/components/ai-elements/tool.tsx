"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  CircleXIcon,
  ClockIcon,
  FileTextIcon,
  FolderOpenIcon,
  ListTodoIcon,
  PencilIcon,
  TerminalIcon,
  UserIcon,
  SettingsIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { CodeBlock } from "./code-block";

export const Tool = (props: ComponentProps<typeof Collapsible>) => (
  <Collapsible
    className="group not-prose mb-px w-full rounded-md opacity-60 transition-opacity hover:opacity-100"
    {...props}
  />
);

export type ToolState = "input-streaming" | "input-available" | "output-available" | "output-error" | "stopped";

const toolIcons: Record<string, ReactNode> = {
  execute: <TerminalIcon className="size-4 text-muted-foreground" />,
  read_file: <FileTextIcon className="size-4 text-muted-foreground" />,
  read: <FileTextIcon className="size-4 text-muted-foreground" />,
  write_file: <PencilIcon className="size-4 text-muted-foreground" />,
  write: <PencilIcon className="size-4 text-muted-foreground" />,
  ls: <FolderOpenIcon className="size-4 text-muted-foreground" />,
  list_directory: <FolderOpenIcon className="size-4 text-muted-foreground" />,
  delegate_to_subagent: <UserIcon className="size-4 text-muted-foreground" />,
  delegate: <UserIcon className="size-4 text-muted-foreground" />,
  task: <ListTodoIcon className="size-4 text-muted-foreground" />,
};

const Badge = ({ children }: { children: ReactNode }) => (
  <span
    data-slot="badge"
    className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2 text-label font-medium whitespace-nowrap text-secondary-foreground [&>svg]:size-3!"
  >
    {children}
  </span>
);

const statusBadges: Record<ToolState, ReactNode> = {
  stopped: <Badge><CircleXIcon className="size-4" />Stopped</Badge>,
  "input-streaming": (
    <Badge>
      <CircleIcon className="size-4" />
      Pending
    </Badge>
  ),
  "input-available": (
    <Badge>
      <ClockIcon className="size-4 animate-pulse" />
      Running
    </Badge>
  ),
  // Completed: just a small checkmark, no badge text
  "output-available": <CheckCircleIcon className="size-3.5 shrink-0 text-(--color-success)" />,
  "output-error": <CircleXIcon className="size-3.5 shrink-0 text-destructive" />,
};

export const ToolHeader = ({
  title,
  description,
  state,
}: {
  title: string;
  description?: string | undefined;
  state: ToolState;
}) => (
  <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 rounded-md px-3 py-1">
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0">
        {toolIcons[title.replace(/\s.*/s, '')] ?? <SettingsIcon className="size-4 text-muted-foreground" />}
      </span>
      <span className="shrink-0 font-medium text-detail">{title}</span>
      {description && (
        <span className="truncate text-detail text-muted-foreground">{description}</span>
      )}
      <span className="ml-auto flex shrink-0">{statusBadges[state]}</span>
    </div>
    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-open:rotate-180" />
  </CollapsibleTrigger>
);

export const ToolContent = (props: ComponentProps<typeof CollapsibleContent>) => (
  <CollapsibleContent
    className="space-y-1.5 py-2 text-popover-foreground outline-none"
    {...props}
  />
);

export const ToolOutput = ({ output }: { output: string }) => {
  if (!output) {
    return null;
  }

  return (
    <div>
      <div className="overflow-x-auto rounded bg-secondary px-2 py-1 font-mono [&_table]:w-full [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_pre]:!rounded-none [&_pre]:!border-none [&>div]:!border-none [&>div]:!bg-transparent [&>div]:!rounded-none text-foreground">
        <CodeBlock code={output} />
      </div>
    </div>
  );
};
