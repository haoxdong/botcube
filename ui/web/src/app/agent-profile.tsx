"use client";

import { m as motionElement } from "framer-motion";
import { Presence, presenceMotion, Swap } from "./collapse";

import { Check, ChevronLeft, Clock, Fingerprint, Heart, IdCard, List, MessageSquare, Monitor, Pencil, ShieldCheck, X, Zap, type LucideIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState, type ComponentType, type FormEvent, type ReactNode, type Ref } from "react";

import type { AgentProfileTab } from "../cartridge/index.js";
import { Button } from "../components/ui/button";
import { Field } from "../components/ui/field";
import { Avatar } from "./avatar";
import { LoadFailed, LoadingSkeleton, useLoad, type LoadState } from "./load-state";
import { PictureField } from "./picture-field";
import { throwIfRefused } from "./refusal";

const MotionButton = motionElement.create(Button);
const MotionField = motionElement.create(Field);
const ScheduledPanel = lazy(() => import("./scheduled-tasks").then(({ ScheduledPanel }) => ({ default: ScheduledPanel })));
const ActivityPanel = lazy(() => import("./agent-activity").then(({ ActivityPanel }) => ({ default: ActivityPanel })));

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

export async function loadAgentProfile({ chatServiceUrl }: { chatServiceUrl: string }): Promise<AgentProfileData> {
  const response = await fetch(`${chatServiceUrl}/agent`, { credentials: "include", cache: "no-store" });
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

const send = (url: string, method: string, body?: unknown) =>
  fetch(url, {
    method,
    credentials: "include",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

async function editMemoryLine(chatServiceUrl: string, line: MemoryLine) {
  const response = await send(`${chatServiceUrl}/agent/memory/${encodeURIComponent(line.id)}`, "PUT", { text: line.text });
  if (response.status === 404) throw new MemoryLineRemovedError();
  if (!response.ok) throw new Error(`Saving Memory failed: ${response.status}`);
}

async function addMemoryLine(chatServiceUrl: string, text: string): Promise<MemoryLine> {
  const response = await send(`${chatServiceUrl}/agent/memory`, "POST", { text });
  await throwIfRefused(response, "Saving Memory failed");
  return ((await response.json()) as { line: MemoryLine }).line;
}

async function deleteMemoryLine(chatServiceUrl: string, id: string) {
  const response = await send(`${chatServiceUrl}/agent/memory/${encodeURIComponent(id)}`, "DELETE");
  if (!response.ok) throw new Error(`Deleting a Memory line failed: ${response.status}`);
}

async function saveDocument(chatServiceUrl: string, document: "identity" | "soul", body: unknown, label: string) {
  const response = await send(`${chatServiceUrl}/agent/${document}`, "PUT", body);
  if (!response.ok) throw new Error(`Saving ${label} failed: ${response.status}`);
}

/** Keeps this picture as the agent's, or clears it with null; a refusal names the Chat Service's reason. */
async function savePicture(chatServiceUrl: string, picture: string | null) {
  const response = await (picture === null
    ? send(`${chatServiceUrl}/agent/picture`, "DELETE")
    : send(`${chatServiceUrl}/agent/picture`, "PUT", { picture }));
  await throwIfRefused(response, "Saving the picture failed");
}

const ABOUT_USE =
  "The agent reads it at the start of every message and uses your edits from your next message on. " +
  "It may change this file itself, and tells you in the chat when it does.";

/** The agent's files: Identity opens from the avatar's pencil, Soul and Memory from the Personalization tab. */
type AgentFile = "Identity" | "Soul" | "Memory";

/** What each file is and how the agent uses it, shown above the file. */
const ABOUT: Record<AgentFile, string> = {
  Identity: `Who your agent is to you: its name, character, vibe, and avatar (an emoji, or blank for the default avatar). ${ABOUT_USE}`,
  Soul:
    `The values and habits your agent keeps in every chat. ${ABOUT_USE} ` +
    "Soul shapes only its manner: its rules for grounding answers and running commands live in its skills, which Soul cannot change.",
  Memory:
    "What your agent has learned about you and keeps from chat to chat, one memory per line. " +
    "The agent reads it once when a chat starts. Chats already open, including your Main chat, keep what they read. " +
    "Side chats you start later get your edits, but a memory the agent saved less than 15 minutes ago keeps its old text until then. " +
    "To fix or remove a fact, edit or delete every line that holds it.",
};

/** Each file's tint (a CSS class) and icon, on its card in the Personalization tab and its page's header tile. */
const FILE_LOOK: Record<AgentFile, { tint: string; Icon: LucideIcon }> = {
  Identity: { tint: "agent-file-tint-identity", Icon: IdCard },
  Soul: { tint: "agent-file-tint-soul", Icon: Heart },
  Memory: { tint: "agent-file-tint-memory", Icon: MessageSquare },
};

const IDENTITY_FIELDS = ["name", "character", "vibe", "avatar"] as const;
const fieldLabel = (field: (typeof IDENTITY_FIELDS)[number]) => field.charAt(0).toUpperCase() + field.slice(1);

/** Runs one change to a file, saying whether it worked. */
type RunChange = (change: () => Promise<void>) => Promise<boolean>;

function useChanges(before = () => {}, after = () => {}) {
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run: RunChange = async (change) => {
    before();
    setError(null);
    try {
      await change();
      after();
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    }
  };
  const alert = error && (
    <p className="agent-profile-error" role="alert">
      {error}
    </p>
  );
  return { setError, active, run, alert };
}

/** What every open file gets from the Personalization tab. */
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
  | { kind: "editing"; onSave: () => Promise<unknown>; onCancel: () => void; busy?: boolean };

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
  actions,
}: {
  file: AgentFile;
  saved: boolean;
  onBack: () => void;
  mode: FileMode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const formId = useId();
  const { tint, Icon } = FILE_LOOK[file];
  return (
    <article className={`agent-file ${tint}`} aria-label={file}>
      <header className="agent-file-header">
        <Button type="button" className="agent-file-back" aria-label="Back" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden />
        </Button>
        <span className="agent-file-icon">
          <Icon aria-hidden="true" />
        </span>
        <h3>{file}</h3>
        <Presence>{saved && (
          <motionElement.p {...presenceMotion} className="agent-file-saved" role="status">
            <Check aria-hidden="true" />
            Saved
          </motionElement.p>
        )}</Presence>
        {actions}
        <Presence>{mode.kind === "editable" && (
          <MotionButton {...presenceMotion} type="button" aria-label={`Edit ${file}`} onClick={mode.onEdit}>
            Edit
          </MotionButton>
        )}</Presence>
        <Presence>{mode.kind === "editing" && (
          <>
            <MotionButton {...presenceMotion} key="0" type="button" aria-label={`Cancel editing ${file}`} disabled={mode.busy} onClick={mode.onCancel}>
              Cancel
            </MotionButton>
            <MotionButton {...presenceMotion} key="1" type="submit" form={formId} variant="primary" disabled={mode.busy} aria-label={`Save ${file}`}>
              Save
            </MotionButton>
          </>
        )}</Presence>
      </header>
      <section className="agent-file-about" aria-label={`About ${file}`}>
        <p>{ABOUT[file]}</p>
      </section>
      <Presence>{mode.kind === "editing" ? (
        <motionElement.form {...presenceMotion}
          id={formId}
          className="agent-file-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void mode.onSave();
          }}
        >
          {children}
        </motionElement.form>
      ) : (
        children
      )}</Presence>
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

/** Agent Identity, always editing: it opens from the avatar's pencil, and Cancel, Back or a save closes it. */
function IdentityFile({
  identity,
  picture,
  onSave,
  onError,
  onClose,
  run,
}: {
  identity: AgentIdentityData;
  picture: string | null;
  /** Saves the fields, and the picture unless it is undefined for unchanged. */
  onSave: (identity: AgentIdentityData, picture: string | null | undefined) => Promise<void>;
  onError: (message: string) => void;
  onClose: () => void;
  run: RunChange;
}) {
  const [draft, setDraft] = useState<IdentityDraft>({ identity, picture });
  const save = async () => {
    if (await run(() => onSave(draft.identity, draft.picture === picture ? undefined : draft.picture))) onClose();
  };
  return (
    <FileDocument file="Identity" saved={false} onBack={onClose} mode={{ kind: "editing", onSave: save, onCancel: onClose }}>
      <PictureField
        picture={draft.picture ?? undefined}
        emoji={draft.identity.avatar}
        name={draft.identity.name}
        agent
        noun="picture"
        size={80}
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
      <Presence>{draft === null ? (
        <motionElement.div {...presenceMotion} key="0" className="agent-file-group agent-file-text">{soul}</motionElement.div>
      ) : (
        <MotionField {...presenceMotion} key="1" label="Soul">
          <textarea rows={12} value={draft} onChange={(event) => setDraft(event.target.value)} />
        </MotionField>
      )}</Presence>
    </FileDocument>
  );
}

function MemoryFile({
  lines,
  pending,
  onSave,
  onAdd,
  onBack,
  run,
  onModeChange,
  saved,
}: FileProps & {
  lines: MemoryLine[];
  pending: MemoryLine[];
  /** Deletes the lines with the `deleted` ids, then saves the `edited` lines. */
  onSave: (deleted: string[], edited: MemoryLine[]) => Promise<void>;
  onAdd: (text: string) => Promise<void>;
  onBack: () => void;
}) {
  const [addition, setAddition] = useState<{ text: string; saving: boolean } | null>(null);
  const adding = useRef(false);
  const add = async () => {
    if (!addition || adding.current || !addition.text.trim()) return;
    adding.current = true;
    setAddition({ ...addition, saving: true });
    const ok = await run(() => onAdd(addition.text.trim()));
    adding.current = false;
    setAddition(ok ? null : { ...addition, saving: false });
  };
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
  const mode: FileMode = addition
    ? { kind: "editing", onSave: add, onCancel: () => { setAddition(null); onModeChange(); }, busy: addition.saving }
    : draft
    ? { kind: "editing", onSave: save, onCancel: cancel }
    : lines.some((line) => !line.id.startsWith("pending:"))
      ? { kind: "editable", onEdit: () => edit(lines) }
      : { kind: "read-only" };
  return (
    <FileDocument file="Memory" saved={saved} onBack={onBack} mode={mode}
      actions={draft === null && addition === null && (
        <Button type="button" aria-label="Add Memory" onClick={() => { onModeChange(); setAddition({ text: "", saving: false }); }}>
          Add
        </Button>
      )}
    >
      <Presence>{addition && (
        <MotionField {...presenceMotion} label="New Memory">
          <input autoFocus required value={addition.text} disabled={addition.saving}
            onChange={(event) => setAddition({ ...addition, text: event.target.value })} />
        </MotionField>
      )}</Presence>
      <Presence>{draft === null && lines.length === 0 && <motionElement.p {...presenceMotion} className="agent-profile-empty">No memories yet.</motionElement.p>}</Presence>
      <Presence>{draft === null && lines.length > 0 && (
        <motionElement.ol {...presenceMotion} className="agent-file-group">
          {lines.map((line) => (
            <li key={line.id} className="agent-file-row">
              {line.text}
            </li>
          ))}
        </motionElement.ol>
      )}</Presence>
      <Presence>{draft && (
        <motionElement.ol {...presenceMotion} className="agent-memory">
          {draft.map((line, index) => (
            <li key={line.id} className="agent-memory-line">
              <input
                aria-label={`Memory line ${index + 1}`}
                value={line.text}
                disabled={line.id.startsWith("pending:")}
                title={line.id.startsWith("pending:") ? "Available to edit after Memory extraction" : undefined}
                onChange={(event) =>
                  setDraft(draft.map((other) => (other.id === line.id ? { ...other, text: event.target.value } : other)))
                }
              />
              <Button
                type="button"
                variant="destructive"
                aria-label={`Delete Memory line ${index + 1}`}
                disabled={line.id.startsWith("pending:")}
                onClick={() => setDraft(draft.filter((other) => other.id !== line.id))}
              >
                Delete
              </Button>
            </li>
          ))}
        </motionElement.ol>
      )}</Presence>
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
  return (
    <Swap state={state.status}>
      {state.status === "loaded" ? children(state.value) : (
        <FileDocument file={file} saved={false} onBack={onBack} mode={{ kind: "read-only" }}>
          <Swap state={state.status}>{state.status === "loading" ? <LoadingSkeleton label={file} /> : <LoadFailed error={state.error} onRetry={retry} />}</Swap>
        </FileDocument>
      )}
    </Swap>
  );
}

/** Agent Identity's load, which the profile's header and its editor share. */
type IdentityLoad = ReturnType<typeof useLoad<AgentIdentityData>>;

function loadIdentity(chatServiceUrl: string) {
  return loadDocument(chatServiceUrl, "identity", "Identity") as Promise<AgentIdentityData>;
}

/** Agent Identity's editor, opened from the avatar's pencil in place of the tab the user was on, which closing returns to. */
function IdentityEditor({
  chatServiceUrl,
  identityFile,
  picture,
  onSaved,
  isAccountCurrent,
  onClose,
}: {
  chatServiceUrl: string;
  identityFile: IdentityLoad;
  /** The agent's picture, from the profile that `onSaved` reloads. */
  picture: string | null;
  onSaved: () => void;
  isAccountCurrent?: (() => boolean) | undefined;
  onClose: () => void;
}) {
  const { setError, active, run, alert } = useChanges();
  const save = async (identity: AgentIdentityData, changedPicture: string | null | undefined) => {
    await saveDocument(chatServiceUrl, "identity", identity, "Identity");
    if (!active.current) throw new Error("Saving Identity cancelled: its editor closed.");
    if (isAccountCurrent?.() === false) throw new Error("Saving Identity cancelled: its account changed or is switching.");
    identityFile.update(() => identity);
    try {
      if (changedPicture !== undefined) await savePicture(chatServiceUrl, changedPicture);
    } finally {
      onSaved();
    }
  };
  return (
    <div className="agent-files">
      {alert}
      <LoadedFile file="Identity" load={identityFile} onBack={onClose}>
        {(identity) => <IdentityFile identity={identity} picture={picture} onSave={save} onError={setError} onClose={onClose} run={run} />}
      </LoadedFile>
    </div>
  );
}

/** The line under each card's title, on what its file holds. */
const CARD_HINT = { Soul: "Values and habits", Memory: "What it knows" } as const;

/** How much a card's file holds once it loads: Soul's lines, Memory's memories; until then nothing. */
function count(file: "Soul" | "Memory", soul: LoadState<string>, memory: LoadState<MemoryLine[]>): string {
  if (file === "Soul") {
    if (soul.status !== "loaded") return "";
    const lines = soul.value.split("\n").filter((line) => line.trim() !== "").length;
    return lines === 0 ? "Empty" : `${lines} ${lines === 1 ? "line" : "lines"}`;
  }
  if (memory.status !== "loaded") return "";
  const memories = memory.value.length;
  return memories === 0 ? "No memories yet" : `${memories} ${memories === 1 ? "memory" : "memories"}`;
}

/**
 * The Personalization tab: Soul and Memory as side-by-side cards (Muse Fig 16), each opening its file as a read-only document with Edit;
 * each file loads on its own, so one that fails says why without hiding the other, and they reload whenever `revision` changes.
 */
function PersonalizationPanel({ chatServiceUrl, revision, onSaved }: { chatServiceUrl: string; revision: number; onSaved: () => void }) {
  const key = `${chatServiceUrl} ${revision}`;
  const soulFile = useLoad(async () => ((await loadDocument(chatServiceUrl, "soul", "Soul")) as { content: string }).content, key);
  const memoryFile = useLoad(async () => ((await loadDocument(chatServiceUrl, "memory", "Memory")) as { lines: MemoryLine[] }).lines, key);
  const [open, setOpen] = useState<"Soul" | "Memory" | null>(null);
  const [saved, setSaved] = useState(false);
  const [memoryRecovery, setMemoryRecovery] = useState<{ key: string; lines: MemoryLine[] } | null>(null);
  const memoryEditor = useRef(0);
  const reset = () => {
    memoryEditor.current += 1;
    setMemoryRecovery(null);
    setSaved(false);
  };
  const { setError, active, run, alert } = useChanges(reset, () => setSaved(true));
  const clear = () => {
    reset();
    setError(null);
  };
  const show = (file: "Soul" | "Memory" | null) => {
    clear();
    setOpen(file);
  };
  const saveSoul = async (soul: string) => {
    await saveDocument(chatServiceUrl, "soul", { content: soul }, "Soul");
    soulFile.update(() => soul);
    onSaved();
  };
  const addMemory = async (text: string) => {
    const editor = memoryEditor.current;
    const line = await addMemoryLine(chatServiceUrl, text);
    if (active.current && editor === memoryEditor.current) memoryFile.update((current) => [line, ...current]);
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
  const openFile = (file: "Soul" | "Memory") =>
    file === "Soul" ? (
      <LoadedFile file={file} load={soulFile} onBack={fileProps.onBack}>
        {(soul) => <SoulFile soul={soul} onSave={saveSoul} {...fileProps} />}
      </LoadedFile>
    ) : (
      <LoadedFile file={file} load={memoryFile} onBack={fileProps.onBack}>
        {(lines) => <MemoryFile lines={lines} pending={memoryRecovery?.key === key ? memoryRecovery.lines : []} onAdd={addMemory} onSave={saveMemory} {...fileProps} />}
      </LoadedFile>
    );

  return (
    <div className="agent-files">
      {alert}
      <Presence>{open ? (
        openFile(open)
      ) : (
        <motionElement.div {...presenceMotion} className="agent-file-cards">
          {(["Soul", "Memory"] as const).map((file) => {
            const { tint, Icon } = FILE_LOOK[file];
            return (
              <button key={file} type="button" className={`agent-file-card ${tint}`} aria-label={`Open ${file}`} onClick={() => show(file)}>
                <span className="agent-file-card-title">{file}</span>
                <span className="agent-file-card-hint">{CARD_HINT[file]}</span>
                <span className="agent-file-card-count">{count(file, soulFile.state, memoryFile.state)}</span>
                <Icon className="agent-file-card-icon" fill="currentColor" aria-hidden="true" />
              </button>
            );
          })}
        </motionElement.div>
      )}</Presence>
    </div>
  );
}

/** The tabs in order, each shown as its icon. */
const TABS: readonly (readonly [AgentProfileTab, LucideIcon])[] = [
  ["Activity", List],
  ["Sign-ins", ShieldCheck],
  ["Computer", Monitor],
  ["Scheduled", Clock],
  ["Personalization", Fingerprint],
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
  onOpenChat,
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
  /** Bumped when the agent edits its files, so the header and Personalization tab reload them. */
  revision: number;
  /** Called after the user saves Agent Identity or Soul. */
  onSaved: () => void;
  /** Opens a scheduled task's Side Chat from its sheet. */
  onOpenChat: (id: string, title: string) => void;
  isAccountCurrent?: (() => boolean) | undefined;
  tabs?: Partial<Record<AgentProfileTab, ComponentType>> | undefined;
  /** The sheet, whose width a phone's swipe measures as the chat slides off it. */
  ref?: Ref<HTMLDivElement> | undefined;
}) {
  // A bot with an Agent Computer opens on it; one without, on its Activity. Each opening starts there again.
  const firstTab: AgentProfileTab = computer === undefined ? "Activity" : "Computer";
  const [tab, setTab] = useState<AgentProfileTab>(firstTab);
  // The avatar's pencil opens Agent Identity's editor in the tab's place; closing it shows the tab again.
  const [editing, setEditing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTab(firstTab);
      setEditing(false);
    }
  }
  const identityFile = useLoad(() => loadIdentity(chatServiceUrl), `${chatServiceUrl} ${revision}`);
  const character = identityFile.state.status === "loaded" ? identityFile.state.value.character.trim() : "";
  const editor = editing && profile !== null;
  const keptComputer = computer !== undefined && tab === "Computer" && !editor;
  const builtIn: Partial<Record<AgentProfileTab, ReactNode>> = {
    Activity: <Suspense fallback={<LoadingSkeleton label="Activity" />}><ActivityPanel chatServiceUrl={chatServiceUrl} /></Suspense>,
    Scheduled: <Suspense fallback={<LoadingSkeleton label="Scheduled tasks" />}><ScheduledPanel chatServiceUrl={chatServiceUrl} onOpenChat={onOpenChat} /></Suspense>,
    Personalization: <PersonalizationPanel chatServiceUrl={chatServiceUrl} revision={revision} onSaved={onSaved} />,
  };
  const panel = (name: AgentProfileTab) => {
    const Panel = tabs[name];
    return builtIn[name] ?? (Panel ? <Panel /> : <p className="agent-profile-empty">Nothing here yet.</p>);
  };

  return (
    <div ref={ref} className="agent-profile" role="dialog" aria-label="Agent profile" hidden={!open}>
      <div className="agent-profile-header">
        <div className="agent-profile-identity">
          <button className="header-btn agent-profile-close" onClick={onClose} aria-label="Close agent profile">
            <X size={20} aria-hidden />
          </button>
          <Presence>
            {profile && <motionElement.div {...presenceMotion} key="avatar" className="agent-profile-avatar">
              <Avatar picture={profile.picture ?? undefined} emoji={profile.avatar} name={profile.name} agent size={96} />
              <button className="agent-profile-edit" onClick={() => setEditing(true)} aria-label="Edit agent"><Pencil size={16} aria-hidden /></button>
            </motionElement.div>}
            {profile && <motionElement.h2 {...presenceMotion} key="name" className="agent-profile-name">{profile.name}</motionElement.h2>}
            {profile && character && <motionElement.p {...presenceMotion} key="character" className="agent-profile-character">{character}</motionElement.p>}
            {profile && <motionElement.p {...presenceMotion} key="status" className={`agent-profile-status agent-profile-status-${profile.status}`}>
              <Zap size={14} aria-hidden />{profile.status === "online" ? "Connected" : "Not connected"}
            </motionElement.p>}
          </Presence>
        </div>
        <Presence>{error && <motionElement.p {...presenceMotion} className="agent-profile-error">{error}</motionElement.p>}</Presence>
      </div>
      <div className="agent-profile-tabs" role="tablist">
        {TABS.map(([name, Icon]) => (
          <button
            key={name}
            role="tab"
            aria-selected={name === tab && !editor}
            aria-label={name}
            title={name}
            className="agent-profile-tab"
            onClick={() => {
              setTab(name);
              setEditing(false);
            }}
          >
            <Icon size={20} aria-hidden />
          </button>
        ))}
      </div>
      <div className="agent-profile-panel" role="tabpanel" aria-label="Computer" hidden={!keptComputer}>
        {computer?.(open && keptComputer)}
      </div>
      <Presence>{open && editor && (
        <motionElement.div {...presenceMotion} className="agent-profile-panel">
          <IdentityEditor
            chatServiceUrl={chatServiceUrl}
            identityFile={identityFile}
            picture={profile.picture}
            onSaved={onSaved}
            isAccountCurrent={isAccountCurrent}
            onClose={() => setEditing(false)}
          />
        </motionElement.div>
      )}</Presence>
      {/* The other tabs load afresh each time they show. */}
      <Presence>{open && !editor && !keptComputer && (
        <motionElement.div {...presenceMotion} className="agent-profile-panel" role="tabpanel" aria-label={tab}>
          {panel(tab)}
        </motionElement.div>
      )}</Presence>
    </div>
  );
}
