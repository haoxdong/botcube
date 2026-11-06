"use client";

import { m as motionElement } from "framer-motion";
import { Presence, presenceMotion, Collapse, Swap } from "./collapse";

import { webUiPlugin } from "@cartridge-ui";
import { ChevronDown } from "lucide-react";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { StatusPill } from "../components/ui/status-pill";
import type { AgentModel } from "./conversations";
import { DAY_NAMES, WEEKDAYS, clock, dayName, dayTime, stopInstant, unitOf, wallWords, zoneName, type Weekday } from "./schedule";
import { RUN_STATUS, type ScheduledTask, type TaskChanges } from "./scheduled-task";
import { ownWords, pickedSchedule, draftOf, endingOf, edited, modelChoices, countedWall, type Repeat, type Frequency, type Ends, type Draft } from "./scheduled-task-draft";

const MotionButton = motionElement.create(Button);

function Detail({ term, title, children, ...row }: { term: string; title?: string; children: ReactNode } & ComponentProps<"div">) {
  return (
    <div {...row} className="settings-row">
      <dt>{term}</dt>
      <dd title={title}>{children}</dd>
    </div>
  );
}

const MotionDetail = motionElement.create(Detail);

function nextRun(task: ScheduledTask): ReactNode {
  if (task.ended) return <Detail term="Next run">Ended</Detail>;
  if (task.paused) return <Detail term="Next run">Paused</Detail>;
  if (task.nextRunUnknown !== undefined) return <Detail term="Next run" title={task.nextRunUnknown}>Unknown</Detail>;
  return task.nextRun === undefined ? null : <Detail term="Next run">{dayTime(task.nextRun, task.timezone)}</Detail>;
}

function TaskDetails({ task, models, modelsFailed, runsOn }: {
  task: ScheduledTask;
  models: AgentModel[] | null;
  modelsFailed: boolean;
  runsOn: string | undefined;
}) {
  const model = runsOn ?? "";
  const draft = draftOf(task, model);
  const made = pickedSchedule(draft.repeat, draft.starts, task.timezone);
  const ending = "why" in made ? undefined : endingOf(draft, task, made.cadence, Date.parse(made.start));
  const next = nextRun(task);
  const last = task.lastRun;
  const [more, setMore] = useState(false);
  return (
    <>
      <dl className="settings-group">
        {repeatRows(draft.repeat, draft.starts, task.timezone).map(([term, words]) => (
          <Detail key={term} term={term}>
            {words}
          </Detail>
        ))}
      </dl>
      <Presence>{(next || last) && (
        <motionElement.dl {...presenceMotion} className="settings-group">
          {next}
          <Presence>{last && (
            <MotionDetail {...presenceMotion} term="Last run">
              <StatusPill tone={RUN_STATUS[last.status].tone}>{RUN_STATUS[last.status].label}</StatusPill>
              {dayTime(last.at, task.timezone)}
            </MotionDetail>
          )}</Presence>
        </motionElement.dl>
      )}</Presence>
      <More open={more} onToggle={() => setMore(!more)}>
        <dl className="settings-group">
          <Presence>{draft.repeat.frequency !== "once" && (
            <>
              <MotionDetail {...presenceMotion} key="starts" term="Starts">{whenWords(draft.starts, task.timezone, false)}</MotionDetail>
              {/* A stop time in the past reads as its time: Next run alone says Ended. */}
              <MotionDetail {...presenceMotion} key="ends" term="Ends">{endsWords(draft.ends, countedWall(ending, task.timezone), task.timezone)}</MotionDetail>
            </>
          )}</Presence>
          {/* Edit's select names the model while the catalog loads; the sheet says only that it loads. */}
          <Detail term="Model">
            {models === null && !modelsFailed ? "Loading…" : modelChoices(task, models, modelsFailed, runsOn).find(({ value }) => value === model)?.label}
          </Detail>
        </dl>
      </More>
    </>
  );
}

function More({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <>
      <button type="button" className="settings-more" aria-expanded={open} onClick={onToggle}>
        More
        <ChevronDown size={16} aria-hidden />
      </button>
      <Collapse open={open}>{children}</Collapse>
    </>
  );
}

const FREQUENCY_NAMES: Record<Frequency, string> = {
  interval: "Interval", daily: "Daily", weekdays: "Weekdays", weekly: "Weekly", once: "Once", custom: "Custom",
};

function SelectRow({ label, value, disabled, onChange, children }: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="settings-row">
      <span>{label}</span>
      <span className="settings-select">
        <select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>
          {children}
        </select>
        <ChevronDown size={16} aria-hidden />
      </span>
    </label>
  );
}

function whenWords(value: string, timezone: string, time: boolean): string {
  try {
    if (!time) return wallWords(value, timezone);
    const at = Date.parse(stopInstant(value, timezone));
    return `${clock(value.slice(11))} ${zoneName(timezone, at)}`;
  } catch {
    return "Choose";
  }
}

function WhenRow({ label, value, time = false, timezone, disabled, onChange }: {
  label: string;
  value: string;
  time?: boolean;
  timezone: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="settings-row settings-when">
      <span>{label}</span>
      <span className="settings-select" aria-hidden>
        <span>{whenWords(value, timezone, time)}</span>
        <ChevronDown size={16} />
      </span>
      <input
        type={time ? "time" : "datetime-local"}
        aria-label={label}
        disabled={disabled}
        value={time ? value.slice(11) : value}
        // A desktop browser opens its picker only from its own calendar icon, hidden here, unless asked; Safari before 16.4 can't be.
        onClick={(event) => {
          if ("showPicker" in event.currentTarget) event.currentTarget.showPicker();
        }}
        onChange={({ target }) => {
          if (!time) onChange(target.value);
          else if (target.value) onChange(`${value.slice(0, 10)}T${target.value}`);
        }}
      />
    </div>
  );
}

function RepeatRow({ value, disabled, onChange }: { value: Repeat; disabled: boolean; onChange: (value: Repeat) => void }) {
  return (
    <SelectRow label="Repeat" value={value.frequency} disabled={disabled} onChange={(frequency) => onChange({ ...value, frequency: frequency as Frequency })}>
      {Object.entries(FREQUENCY_NAMES)
        .filter(([frequency]) => frequency !== "custom" || value.own)
        .map(([frequency, name]) => (
          <option key={frequency} value={frequency}>
            {name}
          </option>
        ))}
    </SelectRow>
  );
}

function EveryRow({ value, disabled, onChange }: { value: Repeat; disabled: boolean; onChange: (value: Repeat) => void }) {
  return (
    <label className="settings-row">
      <span>Every</span>
      <span className="settings-every">
        <input
          aria-label="Every"
          inputMode="numeric"
          disabled={disabled}
          value={value.every}
          style={{ width: `${Math.max(value.every.length, 1) + 0.5}ch` }}
          onChange={(event) => onChange({ ...value, every: event.target.value.replace(/\D/g, "") })}
        />
        <span>{unitOf("minute", Number(value.every))}</span>
      </span>
    </label>
  );
}

function repeatRows(repeat: Repeat, starts: string, timezone: string): [string, string][] {
  const head: [string, string] = ["Repeat", FREQUENCY_NAMES[repeat.frequency]];
  switch (repeat.frequency) {
    case "interval":
      return [head, ["Every", `${repeat.every} ${unitOf("minute", Number(repeat.every))}`]];
    case "weekly":
      return [head, ["Day", dayName(repeat.day)], ["Time", whenWords(starts, timezone, true)]];
    case "daily":
    case "weekdays":
      return [head, ["Time", whenWords(starts, timezone, true)]];
    case "once":
      return [head, ["Time", whenWords(starts, timezone, false)]];
    case "custom":
      return [head, ["Schedule", ownWords(repeat.own, starts)]];
  }
}

function endsOn(value: Ends, counted: string | undefined): string {
  return value.choice === "on" ? (counted ?? value.on) : "";
}

function endsWords(value: Ends, counted: string | undefined, timezone: string): string {
  const on = endsOn(value, counted);
  if (on) return wallWords(on, timezone);
  return value.choice === "on" && value.count !== null ? `After ${value.count} ${unitOf("run", value.count)}` : "Never";
}

function EndsRow({ value, counted, timezone, disabled, onChange }: {
  value: Ends;
  /** A counted task's last run (YYYY-MM-DDTHH:MM), where its schedule says. */
  counted: string | undefined;
  timezone: string;
  disabled: boolean;
  onChange: (value: Ends) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  // Where the browser can't open a picker when asked (Safari before 16.4), the picker takes the row's taps instead.
  const [direct, setDirect] = useState(false);
  const on = endsOn(value, counted);
  const never: Ends = { choice: "never", on: "", count: null };
  return (
    <div className={direct ? "settings-row settings-ends settings-ends-direct" : "settings-row settings-ends"}>
      <span>Ends</span>
      <span className="settings-select">
        {/* The row's value is a hidden choice, so picking either option, even On a date… again, is a change. */}
        <select
          aria-label="Ends"
          disabled={disabled}
          value=""
          onChange={(event) => {
            const input = picker.current;
            if (event.target.value === "never") onChange(never);
            else if (input !== null) {
              // lib.dom gives every input showPicker, which Safari before 16.4 lacks.
              if (typeof (input as { showPicker?: unknown }).showPicker === "function") input.showPicker();
              else {
                setDirect(true);
                input.focus();
                input.click();
              }
            }
          }}
        >
          <option value="" hidden>
            {endsWords(value, counted, timezone)}
          </option>
          <option value="never">Never</option>
          <option value="on">On a date…</option>
        </select>
        <ChevronDown size={16} aria-hidden />
      </span>
      <input
        ref={picker}
        type="datetime-local"
        aria-label="End date"
        tabIndex={-1}
        disabled={disabled}
        value={on}
        onChange={(event) => onChange(event.target.value ? { choice: "on", on: event.target.value, count: null } : never)}
      />
    </div>
  );
}

function TaskEditForm({ task, models, modelsFailed, runsOn, notices, onChange, onDone }: {
  task: ScheduledTask;
  models: AgentModel[] | null;
  modelsFailed: boolean;
  /** The model its runs use; unknown while the catalog failed and it names none. */
  runsOn: string | undefined;
  notices: ReactNode;
  onChange: (changes: TaskChanges) => Promise<boolean>;
  onDone: () => void;
}) {
  const model = runsOn ?? "";
  const [draft, setDraft] = useState(() => draftOf(task, model));
  const [saving, setSaving] = useState(false);
  const set = (changes: Partial<Draft>) => setDraft({ ...draft, ...changes });
  const save = edited(draft, task, model);
  const { frequency } = draft.repeat;
  return (
    <div className="scheduled-sheet-body scheduled-edit">
      <input className="settings-text" aria-label="Title" placeholder="Title" disabled={saving} value={draft.title} onChange={(event) => set({ title: event.target.value })} />
      <textarea
        className="settings-text"
        aria-label="Prompt"
        placeholder="Instructions…"
        rows={4}
        disabled={saving}
        value={draft.prompt}
        onChange={(event) => set({ prompt: event.target.value })}
      />
      <div className="settings-group">
        <RepeatRow value={draft.repeat} disabled={saving} onChange={(repeat) => set({ repeat })} />
        <Collapse open={frequency === "interval"}><EveryRow value={draft.repeat} disabled={saving} onChange={(repeat) => set({ repeat })} /></Collapse>
        <Collapse open={frequency === "weekly"}>
          <SelectRow label="Day" value={draft.repeat.day} disabled={saving} onChange={(day) => set({ repeat: { ...draft.repeat, day: day as Weekday } })}>
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={day}>
                {DAY_NAMES[index]}
              </option>
            ))}
          </SelectRow>
        </Collapse>
        <Collapse open={["daily", "weekdays", "weekly", "once"].includes(frequency)}><WhenRow label="Time" time={frequency !== "once"} value={draft.starts} timezone={task.timezone} disabled={saving} onChange={(starts) => set({ starts })} /></Collapse>
        <Presence>{frequency === "custom" && (
          <motionElement.div {...presenceMotion} className="settings-row">
            <span>Schedule</span>
            <span>{ownWords(draft.repeat.own, draft.starts)}</span>
          </motionElement.div>
        )}</Presence>
      </div>
      <More open={draft.more} onToggle={() => set({ more: !draft.more })}>
        <div className="settings-group">
          <Collapse open={frequency !== "once"}>
            <>
              <WhenRow label="Starts" value={draft.starts} timezone={task.timezone} disabled={saving} onChange={(starts) => set({ starts })} />
              <EndsRow value={draft.ends} counted={countedWall("ending" in save ? save.ending : undefined, task.timezone)} timezone={task.timezone} disabled={saving} onChange={(ends) => set({ ends })} />
            </>
          </Collapse>
          <SelectRow label="Model" value={draft.model} disabled={saving || models === null} onChange={(model) => set({ model })}>
            {modelChoices(task, models, modelsFailed, runsOn, webUiPlugin.config.pickerModelFamilies).map((choice) => (
              <option key={choice.value} value={choice.value} disabled={choice.disabled}>
                {choice.label}
              </option>
            ))}
          </SelectRow>
        </div>
      </More>
      <Presence>{"why" in save && (
        <motionElement.p {...presenceMotion} className="scheduled-task-hint" role="status">
          {save.why}
        </motionElement.p>
      )}</Presence>
      {notices}
      <div className="scheduled-edit-actions">
        <Button disabled={saving} onClick={onDone}>Cancel</Button>
        <Button
          variant="primary"
          disabled={saving || "why" in save}
          onClick={async () => {
            if ("why" in save) return;
            setSaving(true);
            const saved = await onChange(save.changes);
            setSaving(false);
            if (saved) onDone();
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

export function ScheduledTaskSheet({
  task,
  editing,
  onEditing,
  models,
  modelsFailed,
  notices,
  onChange,
  onDelete,
  onOpenChat,
}: {
  task: ScheduledTask;
  /** Showing the Edit form, which the sheet's title names Edit task. */
  editing: boolean;
  onEditing: (editing: boolean) => void;
  /** The account's models, the default first; null until they load; only the Cartridge's, or null, when the catalog failed. */
  models: AgentModel[] | null;
  /** The account's catalog failed (`notices` say why): the task stays editable on the model it names. */
  modelsFailed: boolean;
  /** Why a change or the model catalog failed. */
  notices: ReactNode;
  onChange: (changes: TaskChanges) => Promise<boolean>;
  onDelete: () => void;
  /** Opens the task's Side Chat, whose ID is the task's. */
  onOpenChat: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The model its runs use: the one it names, else the account's default; unknown until the models load.
  const runsOn = modelsFailed ? task.model : models === null ? undefined : (task.model ?? models[0]?.key);

  return (
    <Swap state={editing ? "edit" : "view"}>
      {editing ? (
        <TaskEditForm
          task={task}
          models={models}
          modelsFailed={modelsFailed}
          runsOn={runsOn}
          notices={notices}
          onChange={onChange}
          onDone={() => onEditing(false)}
        />
      ) : (
        <div className="scheduled-sheet-body">
          <p className="scheduled-task-prompt">{task.prompt}</p>
          <TaskDetails task={task} models={models} modelsFailed={modelsFailed} runsOn={runsOn} />
          {notices}
          <div>
            <Collapse open={confirmingDelete} appear={false}>
              <div className="scheduled-sheet-actions">
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirmingDelete(false);
                    onDelete();
                  }}
                >
                  Delete task
                </Button>
                <Button onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              </div>
            </Collapse>
            <Collapse open={!confirmingDelete} appear={false}>
              <div className="scheduled-sheet-actions">
                <Presence>{task.sideChat && <MotionButton {...presenceMotion} onClick={onOpenChat}>Open chat</MotionButton>}</Presence>
                <Presence>{!task.ended && <MotionButton {...presenceMotion} onClick={() => void onChange({ paused: !task.paused })}>{task.paused ? "Resume" : "Pause"}</MotionButton>}</Presence>
                <Button disabled={runsOn === undefined && !modelsFailed} onClick={() => onEditing(true)}>
                  Edit
                </Button>
                <Button variant="destructive" onClick={() => setConfirmingDelete(true)}>
                  Delete
                </Button>
              </div>
            </Collapse>
          </div>
        </div>
      )}
    </Swap>
  );
}
