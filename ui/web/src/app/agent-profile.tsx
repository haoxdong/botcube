"use client";

import { Check, ChevronLeft, Clock, Command, Fingerprint, Heart, IdCard, List, MessageSquare, Monitor, Pencil, ShieldCheck, TriangleAlert, X, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentType, type FormEvent, type ReactNode, type Ref } from "react";

import type { AgentProfileTab } from "../cartridge/index.js";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { FileCard } from "../components/ui/file-card";
import { ListRow, ListRowDetail, ListRowIcon, ListRowText, ListRowTitle } from "../components/ui/list-row";
import { Avatar } from "./avatar";
import { endMoment, startMoment } from "./latency";
import { Loaded, LoadFailed, LoadingSkeleton, useLoad, type LoadState } from "./load-state";
import { PictureField } from "./picture-field";
import { throwIfRefused } from "./refusal";
import { ScheduledPanel } from "./scheduled-tasks";

/** The agent as the Chat Service's `GET /agent` describes it. */
export interface AgentProfileData {
  name: string;
  /** An emoji, or empty for the name's initial. */
  avatar: string;
  /** The uploaded picture as a `data:` URL, which wins over the emoji or initial; null without one. */
  picture: string | null;
  status: "online" | "offline";
}

/** The account's Agent Identity, as `GET /agent/identity` answers it. */
interface AgentIdentityData {
  name: string;
  character: string;
  vibe: string;
  avatar: string;
}

/** The CUSTOM event a Turn streams when the agent edits its Agent Identity or Soul. */
export const AGENT_DOCUMENT_EDITED = "botcube:agent-document-edited";

export async function loadAgentProfile({
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<AgentProfileData> {
  const response = await fetchImpl(`${chatServiceUrl}/agent`, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`Agent profile failed: ${response.status}`);
  return (await response.json()) as AgentProfileData;
}

/** One line of the agent's Memory: a memory record and its text, as `GET /agent/memory` lists it. */
interface MemoryLine {
  id: string;
  text: string;
}

/** One of the agent's files, as `GET /agent/<document>` answers it; a failure names the file, its status going to the console. */
async function loadDocument(chatServiceUrl: string, document: "identity" | "soul" | "memory", file: AgentFile): Promise<unknown> {
  const response = await fetch(`${chatServiceUrl}/agent/${document}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) {
    console.error(new Error(`Loading ${file} failed: ${response.status}`));
    throw new Error(`${file} could not be loaded.`);
  }
  return response.json();
}

class MemoryLineRemovedError extends Error {
  constructor() {
    super("This Memory line was already removed.");
  }
}

async function editMemoryLine(chatServiceUrl: string, line: MemoryLine) {
  const response = await fetch(`${chatServiceUrl}/agent/memory/${encodeURIComponent(line.id)}`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: line.text }),
  });
  if (response.status === 404) throw new MemoryLineRemovedError();
  if (!response.ok) throw new Error(`Saving Memory failed: ${response.status}`);
}

async function deleteMemoryLine(chatServiceUrl: string, id: string) {
  const response = await fetch(`${chatServiceUrl}/agent/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) throw new Error(`Deleting a Memory line failed: ${response.status}`);
}

async function saveDocument(chatServiceUrl: string, document: "identity" | "soul", body: unknown, label: string) {
  const response = await fetch(`${chatServiceUrl}/agent/${document}`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Saving ${label} failed: ${response.status}`);
}

/** Keeps this picture as the agent's, or clears it with null; a refusal names the Chat Service's reason. */
async function savePicture(chatServiceUrl: string, picture: string | null) {
  const response = await fetch(
    `${chatServiceUrl}/agent/picture`,
    picture === null
      ? { method: "DELETE", credentials: "include" }
      : {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ picture }),
        },
  );
  await throwIfRefused(response, "Saving the picture failed");
}

const ABOUT_USE =
  "The agent reads it at the start of every message and uses your edits from your next message on. " +
  "It may change this file itself, and tells you in the chat when it does.";

/** The agent's files, in the order the Identity tab shows them. */
type AgentFile = "Agent Identity" | "Soul" | "Memory";
const AGENT_FILES: readonly AgentFile[] = ["Agent Identity", "Soul", "Memory"];

/** What each file is and how the agent uses it, shown above the file. */
const ABOUT: Record<AgentFile, string> = {
  "Agent Identity": `Who your agent is to you: its name, character, vibe, and avatar (an emoji, or blank for the default avatar). ${ABOUT_USE}`,
  Soul:
    `The values and habits your agent keeps in every chat. ${ABOUT_USE} ` +
    "Soul shapes only its manner: its rules for grounding answers and running commands live in its skills, which Soul cannot change.",
  Memory:
    "What your agent has learned about you and keeps from chat to chat, one memory per line. " +
    "The agent reads it at the start of every message and uses your edits from your next message on. " +
    "Edit a line to correct it, or delete it to make the agent forget it.",
};

/** The line under each file's name on its card. */
const CARD_HINT: Record<AgentFile, string> = {
  "Agent Identity": "Name, character, vibe, avatar",
  Soul: "Values and habits",
  Memory: "What it knows about you",
};

/** Each file's card: its own tint (a CSS class) and icon, as Muse's file cards have. */
const CARD_LOOK: Record<AgentFile, { tint: string; Icon: LucideIcon }> = {
  "Agent Identity": { tint: "agent-file-card-identity", Icon: IdCard },
  Soul: { tint: "agent-file-card-soul", Icon: Heart },
  Memory: { tint: "agent-file-card-memory", Icon: MessageSquare },
};

const IDENTITY_FIELDS = ["name", "character", "vibe", "avatar"] as const;
const fieldLabel = (field: (typeof IDENTITY_FIELDS)[number]) => field.charAt(0).toUpperCase() + field.slice(1);

function About({ file, children }: { file: string; children: string }) {
  return (
    <section className="agent-file-about" aria-label={`About ${file}`}>
      <h4>About this file</h4>
      <p>{children}</p>
    </section>
  );
}

/** Runs one change to a file, saying whether it worked. */
type RunChange = (change: () => Promise<void>) => Promise<boolean>;

/** What every open file gets from the Identity tab. */
interface FileProps {
  run: RunChange;
  /** Called when the file switches between reading and editing. */
  onModeChange: () => void;
  /** Whether the last change saved, shown in the file's header. */
  saved: boolean;
}

/** What an open file's header offers: nothing to change, Edit, or, while editing, Cancel and Save. */
type FileMode =
  | { kind: "read-only" }
  | { kind: "editable"; onEdit: () => void }
  | { kind: "editing"; onSave: () => Promise<unknown>; onCancel: () => void };

/**
 * An open file: its name, its "About this file" note, and its body. Editable, its header holds Edit; while editing,
 * the body is a form and Cancel and Save take Edit's place in the header, so Save stays in view (Muse Fig 20).
 */
function FileDocument({
  file,
  saved,
  onBack,
  mode,
  children,
}: {
  file: AgentFile;
  saved: boolean;
  onBack: () => void;
  mode: FileMode;
  children: ReactNode;
}) {
  const formId = useId();
  return (
    <article className="agent-file" aria-label={file}>
      <header className="agent-file-header">
        <Button type="button" className="agent-file-back" aria-label="Back to files" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden />
        </Button>
        <h3>{file}</h3>
        {saved && (
          <p className="agent-file-saved" role="status">
            <Check aria-hidden="true" />
            Saved
          </p>
        )}
        {mode.kind === "editable" && (
          <Button type="button" aria-label={`Edit ${file}`} onClick={mode.onEdit}>
            Edit
          </Button>
        )}
        {mode.kind === "editing" && (
          <>
            <Button type="button" aria-label={`Cancel editing ${file}`} onClick={mode.onCancel}>
              Cancel
            </Button>
            <Button type="submit" form={formId} variant="primary" aria-label={`Save ${file}`}>
              Save
            </Button>
          </>
        )}
      </header>
      <About file={file}>{ABOUT[file]}</About>
      {mode.kind === "editing" ? (
        <form
          id={formId}
          className="agent-file-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void mode.onSave();
          }}
        >
          {children}
        </form>
      ) : (
        children
      )}
    </article>
  );
}

/** A file's draft while it is being edited, or null while it is read-only. */
function useDraft<T>(onModeChange: () => void, initial: T | null = null) {
  const [draft, setDraft] = useState<T | null>(initial);
  const edit = (value: T) => {
    onModeChange();
    setDraft(value);
  };
  const cancel = () => {
    onModeChange();
    setDraft(null);
  };
  return { draft, setDraft, edit, cancel };
}

/** Agent Identity's draft: its fields, and the agent's picture (null for the emoji or initial). */
interface IdentityDraft {
  identity: AgentIdentityData;
  picture: string | null;
}

function IdentityFile({
  identity,
  picture,
  onSave,
  onError,
  onBack,
  run,
  onModeChange,
  saved,
}: FileProps & {
  identity: AgentIdentityData;
  picture: string | null;
  /** Saves the fields, and the picture unless it is undefined for unchanged. */
  onSave: (identity: AgentIdentityData, picture: string | null | undefined) => Promise<void>;
  onError: (message: string) => void;
  onBack: () => void;
}) {
  const { draft, setDraft, edit, cancel } = useDraft<IdentityDraft>(onModeChange);
  const save = async () => {
    if (draft && (await run(() => onSave(draft.identity, draft.picture === picture ? undefined : draft.picture)))) {
      setDraft(null);
    }
  };
  return (
    <FileDocument
      file="Agent Identity"
      saved={saved}
      onBack={onBack}
      mode={draft ? { kind: "editing", onSave: save, onCancel: cancel } : { kind: "editable", onEdit: () => edit({ identity, picture }) }}
    >
      {draft ? (
        <>
          <PictureField
            picture={draft.picture ?? undefined}
            emoji={draft.identity.avatar}
            name={draft.identity.name}
            agent
            noun="picture"
            onChange={(chosen) => setDraft({ ...draft, picture: chosen })}
            onError={onError}
          />
          {IDENTITY_FIELDS.map((field) => (
            <Field key={field} label={fieldLabel(field)}>
              <input
                value={draft.identity[field]}
                onChange={(event) => setDraft({ ...draft, identity: { ...draft.identity, [field]: event.target.value } })}
              />
            </Field>
          ))}
        </>
      ) : (
        <>
          <Avatar picture={picture ?? undefined} emoji={identity.avatar} name={identity.name} agent size={64} />
          <dl className="agent-file-fields">
            {/* With no emoji the avatar above shows the picture or the default figure, so only editing names the unset field. */}
            {IDENTITY_FIELDS.filter((field) => field !== "avatar" || identity.avatar !== "").map((field) => (
              <div key={field} className="agent-file-entry">
                <dt>{fieldLabel(field)}</dt>
                <dd>{identity[field] || <span className="agent-file-unset">Not set</span>}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </FileDocument>
  );
}

function SoulFile({
  soul,
  onSave,
  onBack,
  run,
  onModeChange,
  saved,
}: FileProps & { soul: string; onSave: (soul: string) => Promise<void>; onBack: () => void }) {
  const { draft, setDraft, edit, cancel } = useDraft<string>(onModeChange);
  const save = async () => {
    if (draft !== null && (await run(() => onSave(draft)))) setDraft(null);
  };
  return (
    <FileDocument
      file="Soul"
      saved={saved}
      onBack={onBack}
      mode={draft === null ? { kind: "editable", onEdit: () => edit(soul) } : { kind: "editing", onSave: save, onCancel: cancel }}
    >
      {draft === null ? (
        <div className="agent-file-text">{soul}</div>
      ) : (
        <Field label="Soul">
          <textarea rows={12} value={draft} onChange={(event) => setDraft(event.target.value)} />
        </Field>
      )}
    </FileDocument>
  );
}

function MemoryFile({
  lines,
  pending,
  onSave,
  onBack,
  run,
  onModeChange,
  saved,
}: FileProps & {
  lines: MemoryLine[];
  pending: MemoryLine[];
  /** Deletes the lines with the `deleted` ids, then saves the `edited` lines. */
  onSave: (deleted: string[], edited: MemoryLine[]) => Promise<void>;
  onBack: () => void;
}) {
  const pendingById = new Map(pending.map((line) => [line.id, line]));
  const { draft, setDraft, edit, cancel } = useDraft<MemoryLine[]>(
    onModeChange,
    lines.some((line) => pendingById.has(line.id)) ? lines.map((line) => pendingById.get(line.id) ?? line) : null,
  );
  const save = async () => {
    if (!draft) return;
    const kept = new Set(draft.map((line) => line.id));
    const deleted = lines.filter((line) => !kept.has(line.id)).map((line) => line.id);
    const saved = new Map(lines.map((line) => [line.id, line.text]));
    const edited = draft.filter((line) => line.text !== saved.get(line.id));
    if (await run(() => onSave(deleted, edited))) setDraft(null);
  };
  // No memories leave nothing to edit.
  const mode: FileMode = draft
    ? { kind: "editing", onSave: save, onCancel: cancel }
    : lines.length > 0
      ? { kind: "editable", onEdit: () => edit(lines) }
      : { kind: "read-only" };
  return (
    <FileDocument file="Memory" saved={saved} onBack={onBack} mode={mode}>
      {draft === null && lines.length === 0 && <p className="agent-profile-empty">No memories yet.</p>}
      {draft === null && lines.length > 0 && (
        <ol className="agent-memory">
          {lines.map((line) => (
            <li key={line.id} className="agent-memory-line">
              {line.text}
            </li>
          ))}
        </ol>
      )}
      {draft && (
        <ol className="agent-memory">
          {draft.map((line, index) => (
            <li key={line.id} className="agent-memory-line">
              <input
                aria-label={`Memory line ${index + 1}`}
                value={line.text}
                onChange={(event) =>
                  setDraft(draft.map((other) => (other.id === line.id ? { ...other, text: event.target.value } : other)))
                }
              />
              <Button
                type="button"
                variant="destructive"
                aria-label={`Delete Memory line ${index + 1}`}
                onClick={() => setDraft(draft.filter((other) => other.id !== line.id))}
              >
                Delete
              </Button>
            </li>
          ))}
        </ol>
      )}
    </FileDocument>
  );
}

/** An open file once it loads; until then its header and note over the skeleton, or why it failed with a Retry. */
function LoadedFile<T>({
  file,
  load: { state, retry },
  onBack,
  children,
}: {
  file: AgentFile;
  load: { state: LoadState<T>; retry: () => void };
  onBack: () => void;
  children: (value: T) => ReactNode;
}) {
  if (state.status === "loaded") return children(state.value);
  return (
    <FileDocument file={file} saved={false} onBack={onBack} mode={{ kind: "read-only" }}>
      {state.status === "loading" ? <LoadingSkeleton label={file} /> : <LoadFailed error={state.error} onRetry={retry} />}
    </FileDocument>
  );
}

/**
 * The Identity tab: Agent Identity, Soul, and Memory as cards. Each opens as a read-only document with Edit;
 * each file loads on its own, so one that fails says why without hiding the others, and they reload whenever `revision` changes.
 */
function IdentityPanel({
  chatServiceUrl,
  picture,
  revision,
  onSaved,
  isAccountCurrent,
}: {
  chatServiceUrl: string;
  /** The agent's picture, from the profile that `onSaved` reloads. */
  picture: string | null;
  revision: number;
  onSaved: () => void;
  isAccountCurrent?: (() => boolean) | undefined;
}) {
  const key = `${chatServiceUrl} ${revision}`;
  const identityFile = useLoad(async () => (await loadDocument(chatServiceUrl, "identity", "Agent Identity")) as AgentIdentityData, key);
  const soulFile = useLoad(async () => ((await loadDocument(chatServiceUrl, "soul", "Soul")) as { content: string }).content, key);
  const memoryFile = useLoad(async () => ((await loadDocument(chatServiceUrl, "memory", "Memory")) as { lines: MemoryLine[] }).lines, key);
  const [open, setOpen] = useState<AgentFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [memoryRecovery, setMemoryRecovery] = useState<{ key: string; lines: MemoryLine[] } | null>(null);
  const memoryEditor = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const clear = () => {
    memoryEditor.current += 1;
    setMemoryRecovery(null);
    setError(null);
    setSaved(false);
  };
  const run: RunChange = async (change) => {
    clear();
    try {
      await change();
      setSaved(true);
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    }
  };
  const show = (file: AgentFile | null) => {
    clear();
    setOpen(file);
  };
  const saveIdentity = async (identity: AgentIdentityData, changedPicture: string | null | undefined) => {
    await saveDocument(chatServiceUrl, "identity", identity, "Agent Identity");
    if (!active.current) throw new Error("Saving Agent Identity cancelled: its editor closed.");
    if (isAccountCurrent?.() === false) throw new Error("Saving Agent Identity cancelled: its account changed or is switching.");
    identityFile.update(() => identity);
    try {
      if (changedPicture !== undefined) await savePicture(chatServiceUrl, changedPicture);
    } finally {
      onSaved();
    }
  };
  const fail = (message: string) => {
    setSaved(false);
    setError(message);
  };
  const saveSoul = async (soul: string) => {
    await saveDocument(chatServiceUrl, "soul", { content: soul }, "Soul");
    soulFile.update(() => soul);
    onSaved();
  };
  const saveMemory = async (deleted: string[], edited: MemoryLine[]) => {
    const editor = memoryEditor.current;
    for (const id of deleted) {
      // eslint-disable-next-line no-await-in-loop -- one delete at a time, so a failure leaves the rest unsent
      await deleteMemoryLine(chatServiceUrl, id);
      memoryFile.update((current) => current.filter((line) => line.id !== id));
    }
    for (const [index, line] of edited.entries()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- one edit at a time, so a failure leaves the rest unsent
        await editMemoryLine(chatServiceUrl, line);
        memoryFile.update((current) => current.map((other) => (other.id === line.id ? line : other)));
      } catch (failure) {
        if (failure instanceof MemoryLineRemovedError && active.current && editor === memoryEditor.current) {
          setMemoryRecovery({ key, lines: edited.slice(index + 1) });
          memoryFile.retry();
        }
        throw failure;
      }
    }
  };

  const fileProps = { run, onModeChange: clear, saved, onBack: () => show(null) };
  const openFile = (file: AgentFile) => {
    if (file === "Agent Identity") {
      return (
        <LoadedFile file={file} load={identityFile} onBack={fileProps.onBack}>
          {(identity) => <IdentityFile identity={identity} picture={picture} onSave={saveIdentity} onError={fail} {...fileProps} />}
        </LoadedFile>
      );
    }
    if (file === "Soul") {
      return (
        <LoadedFile file={file} load={soulFile} onBack={fileProps.onBack}>
          {(soul) => <SoulFile soul={soul} onSave={saveSoul} {...fileProps} />}
        </LoadedFile>
      );
    }
    return (
      <LoadedFile file={file} load={memoryFile} onBack={fileProps.onBack}>
        {(lines) => <MemoryFile lines={lines} pending={memoryRecovery?.key === key ? memoryRecovery.lines : []} onSave={saveMemory} {...fileProps} />}
      </LoadedFile>
    );
  };

  return (
    <div className="agent-files">
      {error && (
        <p className="agent-profile-error" role="alert">
          {error}
        </p>
      )}
      {open ? (
        openFile(open)
      ) : (
        <div className="agent-file-cards">
          {AGENT_FILES.map((file) => {
            const { tint, Icon } = CARD_LOOK[file];
            return (
              <FileCard key={file} className={tint} name={file} hint={CARD_HINT[file]} Icon={Icon} aria-label={`Open ${file}`} onClick={() => show(file)} />
            );
          })}
        </div>
      )}
    </div>
  );
}

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

/** The day heading of a task's finish time: Today, Yesterday, or the date. */
function dayHeading(finished: Date, now: Date): string {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (finished.toDateString() === now.toDateString()) return "Today";
  if (finished.toDateString() === yesterday.toDateString()) return "Yesterday";
  return finished.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(finished.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** The tasks under their day headings, in the order listed. */
function byDay(tasks: ActivityTask[], now: Date): { day: string; tasks: ActivityTask[] }[] {
  const days: { day: string; tasks: ActivityTask[] }[] = [];
  for (const task of tasks) {
    const day = dayHeading(new Date(task.completedAt), now);
    const last = days.at(-1);
    if (last?.day === day) last.tasks.push(task);
    else days.push({ day, tasks: [task] });
  }
  return days;
}

async function loadActivity({
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<ActivityTask[]> {
  const response = await fetchImpl(`${chatServiceUrl}/activity`, { credentials: "include", cache: "no-store" });
  await throwIfRefused(response, "Activity failed");
  return ((await response.json()) as { tasks: ActivityTask[] }).tasks;
}

/** The Activity tab: what the agent did and when, loaded each time it opens. */
function ActivityPanel({ chatServiceUrl }: { chatServiceUrl: string }) {
  // Opening the tab mounts the panel.
  useState(() => startMoment("activity"));
  const { state, retry } = useLoad(() => loadActivity({ chatServiceUrl }), chatServiceUrl);
  return (
    <Loaded state={state} label="Activity" onRetry={retry}>
      {(tasks) => <ActivityList tasks={tasks} />}
    </Loaded>
  );
}

/** The loaded Activity: the tasks under their day headings, or that there are none. */
function ActivityList({ tasks }: { tasks: ActivityTask[] }) {
  useEffect(() => endMoment("activity"), []);
  if (tasks.length === 0) return <p className="agent-profile-empty">No tasks yet.</p>;
  return (
    <div className="agent-activity">
      {byDay(tasks, new Date()).map(({ day, tasks: dayTasks }) => (
        <section key={day} aria-label={day}>
          <h3 className="agent-activity-day list-group-heading">{day}</h3>
          <ol className="agent-activity-tasks">
            {dayTasks.map((task) => (
              <ListRow key={`${task.completedAt} ${task.summary}`} className="agent-activity-task">
                <ListRowIcon failed={task.failed !== undefined}>
                  {task.failed === undefined ? <Command size={20} /> : <TriangleAlert size={20} />}
                </ListRowIcon>
                <ListRowText>
                  <ListRowTitle className="agent-activity-title">{task.title ?? task.summary}</ListRowTitle>
                  {task.title !== undefined && <ListRowDetail className="agent-activity-summary">{task.summary}</ListRowDetail>}
                  {task.failed !== undefined && <span className="agent-activity-failed">Failed: {task.failed}</span>}
                  <ListRowDetail className="agent-activity-time" render={<time dateTime={task.completedAt} />}>
                    {new Date(task.completedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </ListRowDetail>
                </ListRowText>
              </ListRow>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** The tabs in order, each shown as its icon. */
const TABS: readonly (readonly [AgentProfileTab, LucideIcon])[] = [
  ["Activity", List],
  ["Sign-ins", ShieldCheck],
  ["Computer", Monitor],
  ["Scheduled", Clock],
  ["Identity", Fingerprint],
];

/**
 * The Agent Profile: a panel on desktop, a full-screen sheet on phones. Closed, it hides rather than unmounting, and
 * the Computer tab stays mounted under the other tabs, so its live view stays connected for the user's return.
 */
export function AgentProfile({
  open = true,
  chatServiceUrl,
  profile,
  error,
  computer,
  onClose,
  revision,
  onSaved,
  isAccountCurrent,
  tabs = {},
  ref,
}: {
  open?: boolean;
  chatServiceUrl: string;
  profile: AgentProfileData | null;
  error: string | null;
  /** The Computer tab's content, the Cartridge's Agent Computer for the open chat, told whether the tab is showing. */
  computer?: ((shown: boolean) => ReactNode) | undefined;
  onClose: () => void;
  /** Bumped when the agent edits its files, so the Identity tab reloads them. */
  revision: number;
  /** Called after the user saves Agent Identity or Soul. */
  onSaved: () => void;
  isAccountCurrent?: (() => boolean) | undefined;
  tabs?: Partial<Record<AgentProfileTab, ComponentType>> | undefined;
  /** The sheet, whose width a phone's swipe measures as the chat slides off it. */
  ref?: Ref<HTMLDivElement> | undefined;
}) {
  // A bot with an Agent Computer opens on it; one without, on its Activity. Each opening starts there again.
  const firstTab: AgentProfileTab = computer === undefined ? "Activity" : "Computer";
  const [tab, setTab] = useState<AgentProfileTab>(firstTab);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTab(firstTab);
  }
  const keptComputer = computer !== undefined && tab === "Computer";
  const builtIn: Partial<Record<AgentProfileTab, ReactNode>> = {
    Activity: <ActivityPanel chatServiceUrl={chatServiceUrl} />,
    Scheduled: <ScheduledPanel chatServiceUrl={chatServiceUrl} />,
    Identity: profile === null ? <p role="status">Loading Agent profile…</p> : (
      <IdentityPanel chatServiceUrl={chatServiceUrl} picture={profile.picture} revision={revision} onSaved={onSaved} isAccountCurrent={isAccountCurrent} />
    ),
  };
  const panel = (name: AgentProfileTab) => {
    const Panel = tabs[name];
    return builtIn[name] ?? (Panel ? <Panel /> : <p className="agent-profile-empty">Nothing here yet.</p>);
  };

  return (
    <div ref={ref} className="agent-profile" role="dialog" aria-label="Agent profile" hidden={!open}>
      <div className="agent-profile-header">
        <button className="header-btn agent-profile-close" onClick={onClose} aria-label="Close agent profile">
          <X size={20} aria-hidden />
        </button>
        {profile && (
          <>
            <div className="agent-profile-avatar">
              <Avatar picture={profile.picture ?? undefined} emoji={profile.avatar} name={profile.name} agent size={96} />
              <button className="agent-profile-edit" onClick={() => setTab("Identity")} aria-label="Edit agent">
                <Pencil size={16} aria-hidden />
              </button>
            </div>
            <h2 className="agent-profile-name">{profile.name}</h2>
            <p className={`agent-profile-status agent-profile-status-${profile.status}`}>
              <Zap size={14} aria-hidden />
              {profile.status === "online" ? "Connected" : "Not connected"}
            </p>
          </>
        )}
        {error && <p className="agent-profile-error">{error}</p>}
      </div>
      <div className="agent-profile-tabs" role="tablist">
        {TABS.map(([name, Icon]) => (
          <button
            key={name}
            role="tab"
            aria-selected={name === tab}
            aria-label={name}
            title={name}
            className="agent-profile-tab"
            onClick={() => setTab(name)}
          >
            <Icon size={20} aria-hidden />
          </button>
        ))}
      </div>
      {computer !== undefined && (
        <div className="agent-profile-panel" role="tabpanel" aria-label="Computer" hidden={!keptComputer}>
          {computer(open && keptComputer)}
        </div>
      )}
      {/* The other tabs load afresh each time they show. */}
      {open && !keptComputer && (
        <div className="agent-profile-panel" role="tabpanel" aria-label={tab}>
          {panel(tab)}
        </div>
      )}
    </div>
  );
}
