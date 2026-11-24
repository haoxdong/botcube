"use client";

import { Arrives, Fades, Fold } from "./motion";

import { ChevronDown } from "lucide-react";
import { useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "../components/pill-button";
import { Badge } from "../components/ui/badge";
import type { AgentModel } from "./conversations";
import { DAY_NAMES, WEEKDAYS, clock, dayName, dayTime, stopInstant, unitOf, wallWords, zoneName, type Weekday } from "./schedule";
import { RUN_STATUS, type ScheduledTask, type TaskChanges } from "./scheduled-task";
import { ownWords, pickedSchedule, draftOf, endingOf, edited, modelChoices, countedWall, type Repeat, type Frequency, type Ends, type Draft } from "./scheduled-task-draft";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button as StockButton } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

function Detail({ term, title, children, ...row }: { term: string; title?: string; children: ReactNode } & ComponentProps<"div">) {
  return (
    <div {...row} className="settings-row">
      <dt>{term}</dt>
      <dd title={title}>{children}</dd>
    </div>
  );
}

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
      <Fades>{(next || last) && (
        <dl className="settings-group">
          {next}
          <Fades>{last && (
            <Detail term="Last run">
              <Badge variant={RUN_STATUS[last.status].variant}>{RUN_STATUS[last.status].label}</Badge>
              {dayTime(last.at, task.timezone)}
            </Detail>
          )}</Fades>
        </dl>
      )}</Fades>
      <More open={more} onToggle={() => setMore(!more)}>
        <dl className="settings-group">
          <Fades>{draft.repeat.frequency !== "once" && (
            <>
              <Detail key="starts" term="Starts">{whenWords(draft.starts, task.timezone, false)}</Detail>
              {/* A stop time in the past reads as its time: Next run alone says Ended. */}
              <Detail key="ends" term="Ends">{endsWords(draft.ends, countedWall(ending, task.timezone), task.timezone)}</Detail>
            </>
          )}</Fades>
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
    <Fold open={open} onOpenChange={onToggle} trigger={<CollapsibleTrigger render={<StockButton type="button" variant="ghost" className="settings-more" />}>More<ChevronDown size={16} aria-hidden /></CollapsibleTrigger>}>
      {children}
    </Fold>
  );
}

const FREQUENCY_NAMES: Record<Frequency, string> = {
  interval: "Interval", daily: "Daily", weekdays: "Weekdays", weekly: "Weekly", once: "Once", custom: "Custom",
};

type Choice = { value: string; label: string; disabled?: boolean };

function SelectRow({ label, value, disabled, onChange, choices }: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  choices: Choice[];
}) {
  const id = useId();
  return (
    <Field orientation="horizontal" className="settings-row">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <span className="settings-select">
        <Select value={value} disabled={disabled} onValueChange={(chosen: string | null) => { if (chosen !== null) onChange(chosen); }}>
          <SelectTrigger id={id}>{choices.find((choice) => choice.value === value)?.label}</SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice.value} value={choice.value} label={choice.label} disabled={choice.disabled}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
    </Field>
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
  const id = useId();
  return (
    <Field orientation="horizontal" className="settings-row settings-when">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <span className="settings-select" aria-hidden>
        <span>{whenWords(value, timezone, time)}</span>
        <ChevronDown size={16} />
      </span>
      <Input
        id={id}
        className="settings-picker"
        type={time ? "time" : "datetime-local"}
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
    </Field>
  );
}

function RepeatRow({ value, disabled, onChange }: { value: Repeat; disabled: boolean; onChange: (value: Repeat) => void }) {
  return (
    <SelectRow
      label="Repeat"
      value={value.frequency}
      disabled={disabled}
      onChange={(frequency) => onChange({ ...value, frequency: frequency as Frequency })}
      choices={Object.entries(FREQUENCY_NAMES)
        .filter(([frequency]) => frequency !== "custom" || value.own)
        .map(([frequency, name]) => ({ value: frequency, label: name }))}
    />
  );
}

function EveryRow({ value, disabled, onChange }: { value: Repeat; disabled: boolean; onChange: (value: Repeat) => void }) {
  const id = useId();
  return (
    <Field orientation="horizontal" className="settings-row">
      <FieldLabel htmlFor={id}>Every</FieldLabel>
      <span className="settings-every">
        <Input
          id={id}
          inputMode="numeric"
          disabled={disabled}
          value={value.every}
          // As wide as its digits, plus the stock field's 10px padding and 1px border each side.
          style={{ width: `calc(${Math.max(value.every.length, 1) + 0.5}ch + 22px)` }}
          onChange={(event) => onChange({ ...value, every: event.target.value.replace(/\D/g, "") })}
        />
        <span>{unitOf("minute", Number(value.every))}</span>
      </span>
    </Field>
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
  const focusPicker = useRef(false);
  const on = endsOn(value, counted);
  const never: Ends = { choice: "never", on: "", count: null };
  const id = useId();
  return (
    <Field orientation="horizontal" className={direct ? "settings-row settings-ends settings-ends-direct" : "settings-row settings-ends"}>
      <FieldLabel htmlFor={id}>Ends</FieldLabel>
      <span className="settings-select">
        {/* The row's value is no choice, so picking either one, even On a date… again, is a change. */}
        <Select
          value={null}
          disabled={disabled}
          onValueChange={(chosen: string | null) => {
            const input = picker.current;
            if (chosen === "never") onChange(never);
            else if (chosen === "on" && input !== null) {
              // lib.dom gives every input showPicker, which Safari before 16.4 lacks.
              if (typeof (input as { showPicker?: unknown }).showPicker === "function") input.showPicker();
              else {
                setDirect(true);
                focusPicker.current = true;
                input.click();
              }
            }
          }}
        >
          <SelectTrigger id={id}>{endsWords(value, counted, timezone)}</SelectTrigger>
          {/* Once the menu shuts, focus goes where On a date… sent it: the picker, where it couldn't open. */}
          <SelectContent
            finalFocus={() => {
              if (!focusPicker.current) return true;
              focusPicker.current = false;
              return picker.current;
            }}
          >
            <SelectItem value="never">Never</SelectItem>
            <SelectItem value="on">On a date…</SelectItem>
          </SelectContent>
        </Select>
      </span>
      <Input
        className="settings-picker"
        ref={picker}
        type="datetime-local"
        aria-label="End date"
        tabIndex={-1}
        disabled={disabled}
        value={on}
        onChange={(event) => onChange(event.target.value ? { choice: "on", on: event.target.value, count: null } : never)}
      />
    </Field>
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
  const timed = ["daily", "weekdays", "weekly", "once"].includes(frequency);
  return (
    <div className="scheduled-sheet-body scheduled-edit">
      <Input aria-label="Title" placeholder="Title" disabled={saving} value={draft.title} onChange={(event) => set({ title: event.target.value })} />
      <Textarea
        aria-label="Prompt"
        placeholder="Instructions…"
        rows={4}
        disabled={saving}
        value={draft.prompt}
        onChange={(event) => set({ prompt: event.target.value })}
      />
      <div className="settings-group">
        <RepeatRow value={draft.repeat} disabled={saving} onChange={(repeat) => set({ repeat })} />
        <Fold open={frequency === "interval"}><EveryRow value={draft.repeat} disabled={saving} onChange={(repeat) => set({ repeat })} /></Fold>
        <Fold open={frequency === "weekly"}>
          <SelectRow label="Day" value={draft.repeat.day} disabled={saving} onChange={(day) => set({ repeat: { ...draft.repeat, day: day as Weekday } })}
            choices={WEEKDAYS.map((day, index) => ({ value: day, label: DAY_NAMES[index] ?? day }))} />
        </Fold>
        <Fold open={timed}><WhenRow label="Time" time={frequency !== "once"} value={draft.starts} timezone={task.timezone} disabled={saving} onChange={(starts) => set({ starts })} /></Fold>
        <Fades>{frequency === "custom" && (
          <div className="settings-row">
            <span>Schedule</span>
            <span>{ownWords(draft.repeat.own, draft.starts)}</span>
          </div>
        )}</Fades>
      </div>
      <More open={draft.more} onToggle={() => set({ more: !draft.more })}>
        <div className="settings-group">
          <Fold open={frequency !== "once"}>
            <WhenRow label="Starts" value={draft.starts} timezone={task.timezone} disabled={saving} onChange={(starts) => set({ starts })} />
            <EndsRow value={draft.ends} counted={countedWall("ending" in save ? save.ending : undefined, task.timezone)} timezone={task.timezone} disabled={saving} onChange={(ends) => set({ ends })} />
          </Fold>
          <SelectRow label="Model" value={draft.model} disabled={saving || models === null} onChange={(model) => set({ model })}
            choices={modelChoices(task, models, modelsFailed, runsOn)} />
        </div>
      </More>
      <Fades>{"why" in save && (
        <p className="scheduled-task-hint" role="status">
          {save.why}
        </p>
      )}</Fades>
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
  /** The account's models, the default first; null until they load; only the bot's, or null, when the catalog failed. */
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
  const [asking, setAsking] = useState(false);
  // The model its runs use: the one it names, else the account's default; unknown until the models load.
  const runsOn = modelsFailed ? task.model : models === null ? undefined : (task.model ?? models[0]?.key);

  return (
    <Arrives state={editing ? "edit" : "view"}>
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
            <div className="scheduled-sheet-actions">
              <Fades>{task.sideChat && <Button onClick={onOpenChat}>Open chat</Button>}</Fades>
              <Fades>{!task.ended && <Button onClick={() => void onChange({ paused: !task.paused })}>{task.paused ? "Resume" : "Pause"}</Button>}</Fades>
              <Button disabled={runsOn === undefined && !modelsFailed} onClick={() => onEditing(true)}>Edit</Button>
              <AlertDialog open={asking} onOpenChange={setAsking}>
                <AlertDialogTrigger render={<Button variant="destructive" />}>Delete</AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {task.title}?</AlertDialogTitle>
                    <AlertDialogDescription>It won&apos;t run again.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => { setAsking(false); onDelete(); }}>Delete task</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </div>
      )}
    </Arrives>
  );
}
