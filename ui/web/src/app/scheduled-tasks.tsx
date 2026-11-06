"use client";

import { Swap, Collapse, Presence, presenceMotion, CollapseItem, CollapseList } from "./collapse";


import { m as motionElement } from "framer-motion";

import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { ListRow, ListRowDetail, ListRowIcon, ListRowText, ListRowTitle } from "../components/ui/list-row";
import { Sheet } from "../components/ui/sheet";
import { StatusPill } from "../components/ui/status-pill";
import { fetchAgentModels, ModelCatalogError, type AgentModel } from "./conversations";
import { LoadingSkeleton } from "./load-state";
import { fromExpression, listing, runs, stopInstant, summary, toExpression, unitOf, type Cadence, type Ending } from "./schedule";
import { listTasks, sendTask, type ScheduledTask, type TaskChanges } from "./scheduled-task";
import { afterRuns } from "./scheduled-task-draft";
import { ScheduledTaskSheet } from "./scheduled-task-sheet";

const MotionButton = motionElement.create(Button);

/** The agent's proposal, including obsolete count fields retained in saved chats. */
export type ScheduledTaskProposal = { title: string; prompt: string; timezone?: string | null; starts?: string | null; ends?: string | null; count?: number | null } & (Cadence | { schedule: string });

function byFrequency(tasks: ScheduledTask[]): { label: string; tasks: ScheduledTask[] }[] {
  const groups = new Map<string, ScheduledTask[]>();
  for (const task of tasks) {
    const { label } = listing(task.schedule);
    groups.set(label, [...(groups.get(label) ?? []), task]);
  }
  return [...groups].map(([label, grouped]) => ({ label, tasks: grouped }));
}

function proposalSummary(schedule: string, timezone: string, endDate: string | undefined, count: number | null | undefined, startDate?: string): string {
  const now = Date.now();
  const cadence = fromExpression(schedule);
  const first = cadence === null || cadence.frequency === "once" ? undefined : runs(cadence, now, 2, timezone)["every" in cadence ? 1 : 0];
  // A field sent as null is unused, as the Harness reads it.
  const counted = count == null ? undefined : afterRuns(count, 0, cadence, first, timezone);
  const stop = endDate === undefined ? undefined : Date.parse(endDate);
  const ending: Ending = stop !== undefined && (counted?.last === undefined || stop < counted.last)
    ? { kind: "on", at: stop } : counted ?? { kind: "never" };
  const words = summary(schedule, timezone, first, ending, now, startDate === undefined ? undefined : Date.parse(startDate));
  return counted !== undefined && counted.last === undefined && stop !== undefined ? `${words}, up to ${counted.runs} ${unitOf("run", counted.runs)}` : words;
}

export function ScheduledTaskProposalCard({
  chatServiceUrl,
  proposalId,
  proposal,
  result,
}: {
  chatServiceUrl: string;
  proposalId: string;
  proposal: ScheduledTaskProposal;
  result: unknown;
}) {
  const [state, setState] = useState<"proposed" | "busy" | "scheduled">("busy");
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => {
      listTasks(chatServiceUrl).then(
        (tasks) => setState(tasks.some((task) => task.proposalId === proposalId) ? "scheduled" : "proposed"),
        (failure: Error) => {
          setError(failure.message);
          setState("proposed");
        },
      );
    },
    // Stryker disable next-line ArrayDeclaration: a card's Chat Service URL and proposal never change, so it checks once
    [chatServiceUrl, proposalId],
  );

  const timezone = proposal.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let schedule: string | null = null;
  let startDate: string | undefined;
  let endDate: string | undefined;
  let unscheduled: string | null = null;
  let model: string | undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    schedule = "schedule" in proposal ? proposal.schedule : toExpression(proposal);
    if (result !== "Proposed. Nothing is scheduled until the user confirms it in the chat.") {
      const provenance: unknown = typeof result === "string" ? JSON.parse(result) : result;
      if (typeof provenance !== "object" || provenance === null || !("model" in provenance) || typeof provenance.model !== "string" || !provenance.model.trim()) {
        throw new Error("The proposing Turn has no model key");
      }
      model = provenance.model;
    }
    // A field sent as null is unused, as the Harness reads it.
    if (proposal.starts != null) startDate = stopInstant(proposal.starts, timezone);
    if (proposal.ends != null) endDate = stopInstant(proposal.ends, timezone);
  } catch (failure) {
    schedule = null;
    unscheduled = `This proposal has no schedule: ${(failure as Error).message}`;
  }

  const confirm = async (schedule: string) => {
    setState("busy");
    setError(null);
    try {
      if (proposal.count != null) throw new Error('This proposal uses a run count. Ask the agent for start and end times.');
      const { title, prompt } = proposal;
      const task = { title, prompt, schedule, timezone, ...(model === undefined ? {} : { model }), ...(startDate === undefined ? {} : { startDate }), ...(endDate === undefined ? {} : { endDate }), proposalId };
      await sendTask(chatServiceUrl, "/scheduled-tasks", "POST", task, "Scheduling failed");
      setState("scheduled");
    } catch (failure) {
      setError((failure as Error).message);
      setState("proposed");
    }
  };

  return (
    <div className="scheduled-proposal">
      <p className="scheduled-task-title">{proposal.title}</p>
      <p className="scheduled-task-prompt">{proposal.prompt}</p>
      <Swap state={schedule ?? "invalid"}>{schedule === null ? (
        <motionElement.p {...presenceMotion} key="0" className="agent-profile-error">{unscheduled}</motionElement.p>
      ) : (
        <>
          <motionElement.p {...presenceMotion} key="1" className="scheduled-task-schedule">{proposalSummary(schedule, timezone, endDate, proposal.count, startDate)}</motionElement.p>
          <Swap state={`${state === "scheduled"}:${passed(schedule, timezone)}`}>{state === "scheduled" ? (
            <motionElement.p {...presenceMotion} key="0" className="scheduled-proposal-done">Scheduled. Manage it in the Scheduled tab.</motionElement.p>
          ) : passed(schedule, timezone) ? (
            // A one-off task leaves the account once it has run: its card offers no second run.
            <motionElement.p {...presenceMotion} key="1" className="scheduled-proposal-done">Its time has passed.</motionElement.p>
          ) : (
            <MotionButton {...presenceMotion} key="2" variant="primary" className="scheduled-proposal-confirm" disabled={state === "busy"} onClick={() => void confirm(schedule)}>
              Confirm
            </MotionButton>
          )}</Swap>
        </>
      )}</Swap>
      <Presence>{error && <motionElement.p {...presenceMotion} className="agent-profile-error">{error}</motionElement.p>}</Presence>
    </div>
  );
}

function passed(schedule: string, timezone: string): boolean {
  const cadence = fromExpression(schedule);
  return cadence?.frequency === "once" && Date.parse(stopInstant(`${cadence.date}T${cadence.time}`, timezone)) <= Date.now();
}

function TaskStatus({ task }: { task: ScheduledTask }) {
  if (task.ended) return <StatusPill>Ended</StatusPill>;
  return task.paused ? <StatusPill>Paused</StatusPill> : null;
}

function ScheduledTaskRow({ task, onOpen }: { task: ScheduledTask; onOpen: () => void }) {
  const { time } = listing(task.schedule);
  return (
    <CollapseItem as="li">
      <ListRow
        render={<button type="button" aria-haspopup="dialog" onClick={onOpen} />}
        className={task.paused || task.ended ? "scheduled-task scheduled-task-paused" : "scheduled-task"}
      >
        <ListRowIcon>
          <CalendarClock size={20} />
        </ListRowIcon>
        <ListRowText className="scheduled-task-text">
          <span className="scheduled-task-heading">
            <ListRowTitle className="scheduled-task-title">{task.title}</ListRowTitle>
            <TaskStatus task={task} />
          </span>
          <ListRowDetail className="scheduled-task-detail">{time === undefined ? task.prompt : `${time} · ${task.prompt}`}</ListRowDetail>
        </ListRowText>
      </ListRow>
    </CollapseItem>
  );
}

export function ScheduledPanel({
  chatServiceUrl,
  onOpenChat,
}: {
  chatServiceUrl: string;
  /** Opens a task's Side Chat, by the task's ID and title. */
  onOpenChat: (id: string, title: string) => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [models, setModels] = useState<AgentModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The task whose sheet is open, kept while it closes so it still shows as it slides away.
  const [sheet, setSheet] = useState<{ task: ScheduledTask; open: boolean; editing: boolean } | null>(null);
  const [profile, setProfile] = useState<HTMLElement | null>(null);
  const panelRef = useCallback((node: HTMLElement | null) => setProfile(node?.closest<HTMLElement>(".agent-profile") ?? null), []);

  useEffect(
    () => {
      listTasks(chatServiceUrl).then(setTasks, (failure: Error) => setError(failure.message));
      fetchAgentModels({ chatServiceUrl }).then(setModels, (failure: Error) => {
        setModelsError(failure.message);
        if (failure instanceof ModelCatalogError) setModels(failure.cartridgeModels);
      });
    },
    // Stryker disable next-line ArrayDeclaration: the Chat Service URL never changes, so any list loads once per open
    [chatServiceUrl],
  );

  const change = async (id: string, changes: TaskChanges) => {
    setError(null);
    try {
      const updated = await sendTask(chatServiceUrl, `/scheduled-tasks/${id}`, "PATCH", changes, "Scheduled task change failed");
      setTasks((current) => (current ?? []).map((task) => (task.id === id ? updated : task)));
      setSheet((current) => (current?.task.id === id ? { ...current, task: updated } : current));
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    }
  };

  const remove = async ({ id, title }: ScheduledTask) => {
    setError(null);
    const failed = (why: string, cause?: unknown) => {
      console.error(new Error(`Deleting ${title} failed: ${why}`, cause === undefined ? undefined : { cause }));
      setError(`Couldn't delete ${title}. Try again.`);
    };
    let response: Response;
    try {
      response = await fetch(`${chatServiceUrl}/scheduled-tasks/${id}`, { method: "DELETE", credentials: "include" });
    } catch (failure) {
      failed((failure as Error).message, failure);
      return;
    }
    if (!response.ok) {
      failed(String(response.status));
      if (response.status !== 404) return;
    }
    setTasks((current) => (current ?? []).filter((task) => task.id !== id));
    setSheet((current) => (current?.task.id === id ? { ...current, open: false } : current));
  };

  const notices = (
    <>
      <Presence>{error && <motionElement.p {...presenceMotion} className="agent-profile-error">{error}</motionElement.p>}</Presence>
      <Presence>{modelsError && <motionElement.p {...presenceMotion} className="agent-profile-error">{modelsError}</motionElement.p>}</Presence>
    </>
  );
  const groups = byFrequency(tasks ?? []);
  return (
    <div className="scheduled" ref={panelRef}>
      {!sheet?.open && notices}
      <Collapse open={tasks === null && error === null} appear={false}><LoadingSkeleton label="Scheduled tasks" /></Collapse>
      <Presence>{tasks?.length === 0 && <motionElement.p {...presenceMotion} className="agent-profile-empty">No scheduled tasks yet.</motionElement.p>}</Presence>
      <Presence>{tasks !== null && (
        <motionElement.div {...presenceMotion} className="scheduled-tasks">
          <CollapseList>
            {groups.map(({ label, tasks: grouped }) => (
              <CollapseItem key={label}>
                <section aria-label={label}>
                  <h3 className="list-group-heading">{label}</h3>
                  <ul className="scheduled-task-list">
                    <CollapseList>
                      {grouped.map((task) => (
                        <ScheduledTaskRow
                          key={task.id}
                          task={task}
                          onOpen={() => {
                            setError(null);
                            setSheet({ task, open: true, editing: false });
                          }}
                        />
                      ))}
                    </CollapseList>
                  </ul>
                </section>
              </CollapseItem>
            ))}
          </CollapseList>
        </motionElement.div>
      )}</Presence>
      {/* Mounted closed, so that opening is a change it rises for, as it slides away on closing. */}
      <Sheet
        open={sheet?.open ?? false}
        onClose={() => setSheet((current) => current && { ...current, open: false })}
        title={sheet === null ? "" : sheet.editing ? "Edit task" : sheet.task.title}
        container={profile}
        className="scheduled-sheet"
      >
        <Swap state={sheet?.task.id ?? "none"}>{sheet && (
          <ScheduledTaskSheet
            key={sheet.task.id}
            task={sheet.task}
            editing={sheet.editing}
            onEditing={(editing) => setSheet((current) => current && { ...current, editing })}
            models={models}
            modelsFailed={modelsError !== null}
            notices={notices}
            onChange={(changes) => change(sheet.task.id, changes)}
            onDelete={() => void remove(sheet.task)}
            onOpenChat={() => { if (sheet.task.sideChat !== null) onOpenChat(sheet.task.sideChat, sheet.task.title); }}
          />
        )}</Swap>
      </Sheet>
    </div>
  );
}
