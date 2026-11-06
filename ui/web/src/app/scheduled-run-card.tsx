"use client";

import { m as motionElement } from "framer-motion";
import { Presence, presenceMotion } from "./collapse";

import { Clock } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { RUN_STATUS, type ScheduledRun } from "./scheduled-task";
import { StatusPill } from "../components/ui/status-pill";

const MotionButton = motionElement.create(Button);

/** A run that reached its Side Chat, so Open has somewhere to go. */
export type ReachedScheduledRun = ScheduledRun & { sideChat: string; messageId: string };

/** Opens the run's task Side Chat at the run; absent, the card has no Open. */
export const OpenScheduledRun = createContext<((run: ReachedScheduledRun) => void) | null>(null);

/** The run a Main Chat message is the card of; a plain message, as runs posted before cards, is none. */
export function scheduledRunOf(message: { metadata?: unknown }): ScheduledRun | null {
  const metadata = message.metadata as { scheduledRun?: ScheduledRun } | undefined;
  return metadata?.scheduledRun ?? null;
}

const reached = (run: ScheduledRun): run is ReachedScheduledRun => run.sideChat !== undefined && run.messageId !== undefined;

/** When the run started: its time today, else its date and time. */
function ranAt(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** A run's card in the Main Chat: the task, when it ran, how it ended, two lines of what it said, and Open. */
export function ScheduledRunCard({ run, children }: { run: ScheduledRun; children: ReactNode }) {
  const open = useContext(OpenScheduledRun);
  const { label, tone } = RUN_STATUS[run.status];
  return (
    <div className="scheduled-run">
      <div className="scheduled-run-heading">
        <Clock size={16} aria-hidden className="scheduled-run-icon" />
        <span className="scheduled-run-title">{run.title}</span>
        <StatusPill tone={tone}>{label}</StatusPill>
      </div>
      <time className="scheduled-run-time" dateTime={run.ranAt}>{ranAt(run.ranAt)}</time>
      <div className="scheduled-run-text">
        {children}
      </div>
      <Presence>{open && reached(run) && (
        <MotionButton {...presenceMotion} className="scheduled-run-open" onClick={() => open(run)}>
          Open
        </MotionButton>
      )}</Presence>
    </div>
  );
}
