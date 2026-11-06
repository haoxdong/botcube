"use client";

import { m as motionElement } from "framer-motion";
import { Presence, presenceMotion } from "./collapse";

import { Command, TriangleAlert } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { ListRow, ListRowDetail, ListRowIcon, ListRowText, ListRowTitle } from "../components/ui/list-row";
import { endMoment, startMoment } from "./latency";
import { Loaded, useLoad } from "./load-state";
import { throwIfRefused } from "./refusal";

const MotionCommand = motionElement.create(Command);
const MotionTriangleAlert = motionElement.create(TriangleAlert);
const MotionListRowDetail = motionElement.create(ListRowDetail);

/**
 * One answered Turn, as the Chat Service's `GET /activity` lists it, most recent first: what the
 * agent did, or, for a Turn with no stored summary, only its request's first line as `summary`;
 * a Turn that ended in a run error carries that error's first line as `failed`.
 */
interface ActivityTask {
  title?: string;
  summary: string;
  failed?: string;
  completedAt: string;
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const DAY_WITH_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** The day heading of a task's finish time: Today, Yesterday, or the date. */
function dayHeading(finished: Date, now: Date): string {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (finished.toDateString() === now.toDateString()) return "Today";
  if (finished.toDateString() === yesterday.toDateString()) return "Yesterday";
  return (finished.getFullYear() === now.getFullYear() ? DAY_FORMAT : DAY_WITH_YEAR_FORMAT).format(finished);
}

/** The tasks under their day headings, in the order listed. */
function byDay(tasks: ActivityTask[], now: Date): { day: string; tasks: ActivityTask[] }[] {
  const days: { date: string; day: string; tasks: ActivityTask[] }[] = [];
  for (const task of tasks) {
    const finished = new Date(task.completedAt);
    const last = days.at(-1);
    if (last?.date === finished.toDateString()) last.tasks.push(task);
    else days.push({ date: finished.toDateString(), day: dayHeading(finished, now), tasks: [task] });
  }
  return days;
}

async function loadActivity(chatServiceUrl: string): Promise<ActivityTask[]> {
  const response = await fetch(`${chatServiceUrl}/activity`, { credentials: "include", cache: "no-store" });
  await throwIfRefused(response, "Activity failed");
  return ((await response.json()) as { tasks: ActivityTask[] }).tasks;
}

/** The Activity tab: what the agent did and when, loaded each time it opens. */
export function ActivityPanel({ chatServiceUrl }: { chatServiceUrl: string }) {
  // Opening the tab mounts the panel.
  useState(() => startMoment("activity"));
  const { state, retry } = useLoad(() => loadActivity(chatServiceUrl), chatServiceUrl);
  return (
    <Loaded state={state} label="Activity" onRetry={retry}>
      {(tasks) => <ActivityList key={chatServiceUrl} tasks={tasks} />}
    </Loaded>
  );
}

const ACTIVITY_PAGE_SIZE = 30;

/** The loaded Activity: the tasks under their day headings, a page at a time, or that there are none. */
function ActivityList({ tasks }: { tasks: ActivityTask[] }) {
  useEffect(() => endMoment("activity"), []);
  const [shown, setShown] = useState(ACTIVITY_PAGE_SIZE);
  const pageEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const marker = pageEnd.current;
    if (marker === null) return undefined;
    // An IntersectionObserver reports its target once as it starts observing, so this runs again for each new page.
    const observer = new IntersectionObserver(
      // The newest of the changes one callback can carry, as in the chat's earlier rows.
      (entries) => {
        if (entries.at(-1)?.isIntersecting) setShown(shown + ACTIVITY_PAGE_SIZE);
      },
      { root: marker.closest(".agent-profile-panel"), rootMargin: "0px 0px 100% 0px" },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [shown]);
  if (tasks.length === 0) return <p className="agent-profile-empty">No tasks yet.</p>;
  return (
    <div className="agent-activity">
      {byDay(tasks.slice(0, shown), new Date()).map(({ day, tasks: dayTasks }) => (
        <section key={day} aria-label={day}>
          <h3 className="agent-activity-day list-group-heading">{day}</h3>
          <ol className="agent-activity-tasks">
            {dayTasks.map((task) => <ActivityRow key={`${task.completedAt} ${task.summary}`} task={task} />)}
          </ol>
        </section>
      ))}
      <Presence>{shown < tasks.length && <motionElement.div {...presenceMotion} ref={pageEnd} />}</Presence>
    </div>
  );
}

/** One task under its day heading. */
const ActivityRow = memo(function ActivityRow({ task }: { task: ActivityTask }) {
  return (
    <ListRow className="agent-activity-task">
      <ListRowIcon failed={task.failed !== undefined}>
        <Presence>{task.failed === undefined ? <MotionCommand {...presenceMotion} key="0" size={20} /> : <MotionTriangleAlert {...presenceMotion} key="1" size={20} />}</Presence>
      </ListRowIcon>
      <ListRowText>
        <ListRowTitle className="agent-activity-title">{task.title ?? task.summary}</ListRowTitle>
        <Presence>{task.title !== undefined && <MotionListRowDetail {...presenceMotion} className="agent-activity-summary">{task.summary}</MotionListRowDetail>}</Presence>
        <Presence>{task.failed !== undefined && <motionElement.span {...presenceMotion} className="agent-activity-failed">Failed: {task.failed}</motionElement.span>}</Presence>
        <ListRowDetail className="agent-activity-time" render={<time dateTime={task.completedAt} />}>
          {TIME_FORMAT.format(new Date(task.completedAt))}
        </ListRowDetail>
      </ListRowText>
    </ListRow>
  );
});
