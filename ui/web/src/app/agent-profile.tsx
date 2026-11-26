"use client";

import { Arriving, Fades, useAfterMove } from "./motion";

import { Check, ChevronLeft, Clock, Fingerprint, Heart, IdCard, MessageSquare, Monitor, Pencil, ShieldCheck, X, Zap, type LucideIcon } from "lucide-react";
import { lazy, memo, Suspense, useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";

import type { AgentProfileTab } from "../plugin/index.js";
import type { SignInsControl } from "../plugin/types";
import { SignInsTab } from "./sign-ins";
import { Button } from "../components/pill-button";
import { Empty, EmptyDescription } from "../components/ui/empty";
import { Field, FieldLabel } from "../components/ui/field";
import { AlertLine } from "./alert-line";
import { Avatar } from "./avatar";
import { LoadFailed, LoadingSkeleton, useLoad, type LoadState } from "./load-state";
import { PictureField } from "./picture-field";
import { throwIfRefused } from "./refusal";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button as StockButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item } from "@/components/ui/item";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ScheduledPanel = lazy(() => import("./scheduled-tasks").then(({ ScheduledPanel }) => ({ default: ScheduledPanel })));

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

type TextDocument = { content: string };
type AgentFiles = { Identity: AgentIdentityData; Soul: TextDocument; Memory: TextDocument };
type AgentFile = keyof AgentFiles;
type TextFileName = Exclude<AgentFile, "Identity">;

const FILE_PATH = { Identity: "agent/identity", Soul: "agent/soul", Memory: "files/written-memory" } as const;

async function loadAgentFile<File extends AgentFile>(chatServiceUrl: string, file: File): Promise<AgentFiles[File]> {
  const response = await fetch(`${chatServiceUrl}/${FILE_PATH[file]}`, { credentials: "include", cache: "no-store" });
  if (!response.ok) {
    console.error(new Error(`Loading ${file} failed: ${response.status}`));
    throw new Error(`${file} could not be loaded.`);
  }
  return response.json();
}

const send = (url: string, method: string, body?: unknown) =>
  fetch(url, {
    method,
    credentials: "include",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

async function saveAgentFile<File extends AgentFile>(chatServiceUrl: string, file: File, body: AgentFiles[File]) {
  await throwIfRefused(await send(`${chatServiceUrl}/${FILE_PATH[file]}`, "PUT", body), `Couldn't save ${file}.`, " ");
}

async function forgetExtractedMemory(chatServiceUrl: string) {
  await throwIfRefused(await send(`${chatServiceUrl}/agent/extracted-memory/forget`, "POST"), "Forgetting failed");
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

/** What each file is and how the agent uses it, shown above the file. */
const ABOUT: Record<AgentFile, string> = {
  Identity: `Who your agent is to you: its name, character, vibe, and avatar (an emoji, or blank for the default avatar). ${ABOUT_USE}`,
  Soul:
    `The values and habits your agent keeps in every chat. ${ABOUT_USE} ` +
    "Soul shapes only its manner: its rules for grounding answers and running commands live in its skills, which Soul cannot change.",
  Memory:
    "What your agent keeps about you, saved as memories/AGENTS.md in your Files. " +
    "It reads the file when a chat starts, so Side chats you start later get your edits.",
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

function useChanges() {
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run: RunChange = async (change) => {
    setError(null);
    try {
      await change();
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    }
  };
  const alert = error && (
    <AlertLine className="agent-profile-error">{error}</AlertLine>
  );
  return { setError, active, run, alert };
}

/** What an open file's header offers: nothing to change, Edit, or, while editing, Cancel and Save. */
type FileMode =
  | { kind: "read-only" }
  | { kind: "editable"; disabled: boolean; onEdit: () => void }
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
  alert,
  children,
}: {
  file: AgentFile;
  saved: boolean;
  onBack: () => void;
  mode: FileMode;
  alert?: ReactNode;
  children: ReactNode;
}) {
  const formId = useId();
  const { tint, Icon } = FILE_LOOK[file];
  return (
    <article className={`agent-file ${tint}`} aria-label={file}>
      <header className="agent-file-header">
        <Button type="button" size="icon" aria-label="Back" onClick={onBack}>
          <ChevronLeft aria-hidden />
        </Button>
        <span className="agent-file-icon">
          <Icon aria-hidden="true" />
        </span>
        <h3>{file}</h3>
        <Fades>{saved && (
          <p className="agent-file-saved" role="status">
            <Check aria-hidden="true" />
            Saved
          </p>
        )}</Fades>
        <Fades>{mode.kind === "editable" && (
          <Button type="button" aria-label={`Edit ${file}`} disabled={mode.disabled} onClick={mode.onEdit}>
            Edit
          </Button>
        )}</Fades>
        <Fades>{mode.kind === "editing" && (
          <>
            <Button key="0" type="button" aria-label={`Cancel editing ${file}`} onClick={mode.onCancel}>
              Cancel
            </Button>
            <Button key="1" type="submit" form={formId} variant="primary" aria-label={`Save ${file}`}>
              Save
            </Button>
          </>
        )}</Fades>
      </header>
      {alert}
      <section className="agent-file-about" aria-label={`About ${file}`}>
        <p>{ABOUT[file]}</p>
      </section>
      <Fades>{mode.kind === "editing" ? (
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
      )}</Fades>
    </article>
  );
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
  alert,
}: {
  identity: AgentIdentityData;
  picture: string | null;
  /** Saves the fields, and the picture unless it is undefined for unchanged. */
  onSave: (identity: AgentIdentityData, picture: string | null | undefined) => Promise<void>;
  onError: (message: string) => void;
  onClose: () => void;
  run: RunChange;
  alert: ReactNode;
}) {
  const id = useId();
  const [draft, setDraft] = useState<IdentityDraft>({ identity, picture });
  const save = async () => {
    if (await run(() => onSave(draft.identity, draft.picture === picture ? undefined : draft.picture))) onClose();
  };
  return (
    <FileDocument file="Identity" alert={alert} saved={false} onBack={onClose} mode={{ kind: "editing", onSave: save, onCancel: onClose }}>
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
        <Field key={field}>
          <FieldLabel htmlFor={`${id}-${field}`}>{fieldLabel(field)}</FieldLabel>
          <Input
            id={`${id}-${field}`}
            value={draft.identity[field]}
            onChange={(event) => setDraft({ ...draft, identity: { ...draft.identity, [field]: event.target.value } })}
          />
        </Field>
      ))}
    </FileDocument>
  );
}

/** What became of the last Forget: nothing yet, sending, started, or failed (the reason goes to the console, not the User). */
type Forgetting = { kind: "idle" | "sending" | "started" | "failed" };

/** Forget for Extracted Memory, under the Memory card: its caption's line reports how the last Forget went, so nothing moves. */
function ForgetExtractedMemory({ chatServiceUrl }: { chatServiceUrl: string }) {
  const [asking, setAsking] = useState(false);
  const [forgetting, setForgetting] = useState<Forgetting>({ kind: "idle" });
  const sending = forgetting.kind === "sending";
  const forget = async () => {
    setForgetting({ kind: "sending" });
    try {
      await forgetExtractedMemory(chatServiceUrl);
      setForgetting({ kind: "started" });
    } catch (failure) {
      console.error(failure);
      setForgetting({ kind: "failed" });
    }
    setAsking(false);
  };
  const line = forgetting.kind === "started" ? (
    <AlertLine tone="notice">Forgetting started. It can take a few minutes.</AlertLine>
  ) : forgetting.kind === "failed" ? (
    <AlertLine>Couldn't start forgetting. Try again.</AlertLine>
  ) : (
    <p className="agent-file-forget-caption">Your agent also picks up things from your chats, kept apart from this file.</p>
  );
  return (
    <section className="agent-file-forget" aria-label="Forget">
      <div className="agent-file-forget-line">{line}</div>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogTrigger render={<StockButton type="button" variant="ghost" size="sm" className="agent-file-forget-button" disabled={sending} />}>
          Forget what it picked up…
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget what your agent picked up?</AlertDialogTitle>
            <AlertDialogDescription>This deletes what your agent learned from your chats. Your Memory text stays as it is.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={sending} onClick={() => void forget()}>Forget</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function TextFile({ file, text, empty, refreshing, onSave, onBack, after }: {
  file: TextFileName;
  text: string;
  empty: string;
  refreshing: boolean;
  onSave: (text: string) => Promise<void>;
  onBack: () => void;
  after?: ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { setError, run, alert } = useChanges();
  const id = useId();
  const changeDraft = (value: string | null) => {
    setError(null);
    setSaved(false);
    setDraft(value);
  };
  const save = async () => {
    if (draft !== null && await run(() => onSave(draft))) {
      setDraft(null);
      setSaved(true);
    }
  };
  const reading = file === "Memory" && text.trim() === "" ? (
    <Empty key={text}><EmptyDescription>{empty}</EmptyDescription></Empty>
  ) : (
    <div key={text} className="agent-file-group agent-file-text">{text}</div>
  );
  return (
    <FileDocument
      file={file}
      saved={saved}
      onBack={onBack}
      alert={alert}
      mode={draft === null
        ? { kind: "editable", disabled: refreshing, onEdit: () => changeDraft(text) }
        : { kind: "editing", onSave: save, onCancel: () => changeDraft(null) }}
    >
      <Fades>{draft === null ? (
        <div key="reading" className="agent-file-reading"><Fades>{reading}</Fades></div>
      ) : (
        <Field key="editing">
          <FieldLabel htmlFor={id}>{file}</FieldLabel>
          <Textarea id={id} rows={12} value={draft} onChange={(event) => setDraft(event.target.value)} />
        </Field>
      )}</Fades>
      {draft === null && after}
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
  return state.status === "loaded" ? children(state.value) : (
    <FileDocument file={file} saved={false} onBack={onBack} mode={{ kind: "read-only" }}>
      {state.status === "loading" ? <LoadingSkeleton label={file} /> : <LoadFailed error={state.error} onRetry={retry} />}
    </FileDocument>
  );
}

/** Agent Identity's load, which the profile's header and its editor share. */
type IdentityLoad = ReturnType<typeof useLoad<AgentIdentityData>>;

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
    await saveAgentFile(chatServiceUrl, "Identity", identity);
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
      <LoadedFile file="Identity" load={identityFile} onBack={onClose}>
        {(identity) => <IdentityFile identity={identity} picture={picture} onSave={save} onError={setError} onClose={onClose} run={run} alert={alert} />}
      </LoadedFile>
    </div>
  );
}

/** Each card's line under its title, on what its file holds, and its count when the file holds nothing. */
const CARD = {
  Soul: { hint: "Values and habits", none: "Empty" },
  Memory: { hint: "What it knows", none: "No memories yet" },
} as const;

/** How many lines a card's file holds once it loads, or that it holds none; until then nothing. */
function count(file: TextFileName, state: LoadState<string>): string {
  if (state.status !== "loaded") return "";
  const lines = state.value.split("\n").filter((line) => line.trim() !== "").length;
  if (lines === 0) return CARD[file].none;
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

function PersonalizationPanel({ chatServiceUrl, revision, onSaved, memory }: { chatServiceUrl: string; revision: number; onSaved: () => void; memory: boolean }) {
  const key = `${chatServiceUrl} ${revision}`;
  const soul = useLoad(async () => (await loadAgentFile(chatServiceUrl, "Soul")).content, key);
  const writtenMemory = useLoad(async () => memory ? (await loadAgentFile(chatServiceUrl, "Memory")).content : "", `${key} ${memory}`);
  const files = { Soul: soul, Memory: writtenMemory };
  const [selected, setSelected] = useState<TextFileName | null>(null);
  const open = selected === "Memory" && !memory ? null : selected;
  const show = (file: TextFileName) => {
    if (files[file].state.status === "loaded") files[file].refresh();
    setSelected(file);
  };
  const save = async (file: TextFileName, content: string) => {
    await saveAgentFile(chatServiceUrl, file, { content });
    files[file].update(() => content);
    if (file === "Soul") onSaved();
  };
  const back = () => setSelected(null);

  return (
    <div className="agent-files">
      {open ? (
        <LoadedFile file={open} load={files[open]} onBack={back}>
          {(text) => <TextFile key={open} file={open} text={text} refreshing={files[open].refreshing} empty="No memories yet." onSave={(content) => save(open, content)} onBack={back} after={open === "Memory" ? <ForgetExtractedMemory chatServiceUrl={chatServiceUrl} /> : undefined} />}
        </LoadedFile>
      ) : (
        <div className="agent-file-cards">
          {(memory ? (["Soul", "Memory"] as const) : (["Soul"] as const)).map((file) => {
            const { tint, Icon } = FILE_LOOK[file];
            return (
              <Item key={file} render={<button type="button" />} className={`agent-file-card flex-nowrap items-stretch gap-0 ${tint}`} aria-label={`Open ${file}`} onClick={() => show(file)}>
                <span className="agent-file-card-title">{file}</span>
                <span className="agent-file-card-hint">{CARD[file].hint}</span>
                <span className="agent-file-card-count">{count(file, files[file].state)}</span>
                <Icon className="agent-file-card-icon" fill="currentColor" aria-hidden="true" />
              </Item>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The tabs in order, each shown as its icon. */
const TABS: readonly (readonly [AgentProfileTab, LucideIcon])[] = [
  ["Sign-ins", ShieldCheck],
  ["Computer", Monitor],
  ["Scheduled", Clock],
  ["Personalization", Fingerprint],
];

/**
 * The Agent Profile: a panel on desktop, a full-screen sheet on phones. Closed, it hides rather than unmounting, and
 * the Computer tab stays mounted under the other tabs, so its live view stays connected for the user's return.
 * While it stays closed it skips renders that change only its callbacks, and opens on the latest ones; new data still
 * renders, so it opens complete.
 */
function AgentProfile({
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
  signIns,
  memory = true,
  ref,
  closeRef,
}: {
  open?: boolean;
  chatServiceUrl: string;
  profile: AgentProfileData | null;
  error: string | null;
  /** The Computer tab's content, the bot's Agent Computer for the open chat, told whether the tab is showing. */
  computer?: ((shown: boolean) => ReactNode) | undefined;
  onClose: () => void;
  /** Bumped when the agent edits its files, so the header and Personalization tab reload them. */
  revision: number;
  /** Called after the user saves Agent Identity or Soul. */
  onSaved: () => void;
  /** Opens a scheduled task's Side Chat from its sheet. */
  onOpenChat: (id: string, title: string) => void;
  isAccountCurrent?: (() => boolean) | undefined;
  /** The Sign-ins tab's actions and state, from the page's sign-in provider; without them, the tab has nothing yet. */
  signIns?: SignInsControl | undefined;
  /** Whether the User keeps Written Memory (the bot settings' `writtenMemory.enabled`, and not a Guest): if not, Personalization shows only the Soul. */
  memory?: boolean | undefined;
  /** The sheet, whose width a phone's swipe measures as the chat slides off it. */
  ref?: Ref<HTMLDivElement> | undefined;
  closeRef?: Ref<HTMLButtonElement> | undefined;
}) {
  // A bot with an Agent Computer opens on it; one without, on its first tab. Each opening starts there again.
  const firstTab: AgentProfileTab = computer === undefined ? "Sign-ins" : "Computer";
  const [tab, setTab] = useState<AgentProfileTab>(firstTab);
  // The avatar's pencil opens Agent Identity's editor in the tab's place; closing it shows the tab again.
  const [editing, setEditing] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  const settled = useAfterMove(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTab(firstTab);
      setEditing(false);
    }
  }
  const identityFile = useLoad(() => loadAgentFile(chatServiceUrl, "Identity"), `${chatServiceUrl} ${revision}`);
  const character = identityFile.state.status === "loaded" ? identityFile.state.value.character.trim() : "";
  const editor = editing && profile !== null;
  const empty = <Empty><EmptyDescription>Nothing here yet.</EmptyDescription></Empty>;
  const panels: Record<AgentProfileTab, ReactNode> = {
    Computer: computer ? computer(open && tab === "Computer" && !editor) : empty,
    Scheduled: <Suspense fallback={<LoadingSkeleton label="Scheduled tasks" />}><ScheduledPanel chatServiceUrl={chatServiceUrl} onOpenChat={onOpenChat} /></Suspense>,
    Personalization: <PersonalizationPanel chatServiceUrl={chatServiceUrl} revision={revision} onSaved={onSaved} memory={memory} />,
    "Sign-ins": signIns ? <SignInsTab chatServiceUrl={chatServiceUrl} control={signIns} /> : empty,
  };

  return (
    <Arriving value={open && !settled}>
      <div ref={ref} className="agent-profile" role="dialog" aria-label="Agent profile" hidden={!open} data-settled={settled || undefined}>
        <div className="agent-profile-header">
          <div className="agent-profile-identity">
            <button ref={closeRef} className="header-btn agent-profile-close" onClick={onClose} aria-label="Close agent profile">
              <X size={20} aria-hidden />
            </button>
            <Fades>
              {profile && <Avatar key="avatar" className="agent-profile-avatar" picture={profile.picture ?? undefined} emoji={profile.avatar} name={profile.name} agent size={96}>
                <button className="agent-profile-edit" onClick={() => setEditing(true)} aria-label="Edit agent"><Pencil size={16} aria-hidden /></button>
              </Avatar>}
              {profile && <h2 key="name" className="agent-profile-name">{profile.name}</h2>}
              {profile && character && <p key="character" className="agent-profile-character">{character}</p>}
              {profile && <p key="status" className={`agent-profile-status agent-profile-status-${profile.status}`}>
                <Zap size={14} aria-hidden />{profile.status === "online" ? "Connected" : "Not connected"}
              </p>}
            </Fades>
          </div>
          <Fades>{error && <AlertLine className="agent-profile-error">{error}</AlertLine>}</Fades>
        </div>
        <Tabs
          className="contents"
          value={editor ? null : tab}
          onValueChange={(name: AgentProfileTab) => {
            setTab(name);
            setEditing(false);
          }}
        >
          <TabsList className="agent-profile-tabs" aria-label="Agent profile">
            {TABS.map(([name, Icon]) => (
              <Tooltip key={name}>
                <TooltipTrigger render={<TabsTrigger value={name} aria-label={name} className="agent-profile-tab" />}>
                  <Icon className="size-5" aria-hidden />
                </TooltipTrigger>
                <TooltipContent>{name}</TooltipContent>
              </Tooltip>
            ))}
          </TabsList>
          {open && editor && (
            <div className="agent-profile-panel">
              <IdentityEditor
                chatServiceUrl={chatServiceUrl}
                identityFile={identityFile}
                picture={profile.picture}
                onSaved={onSaved}
                isAccountCurrent={isAccountCurrent}
                onClose={() => setEditing(false)}
              />
            </div>
          )}
          {TABS.map(([name]) => {
            const keepMounted = name === "Computer";
            return (open || keepMounted) && (
              <TabsContent key={name} className="agent-profile-panel" value={name} keepMounted={keepMounted}>
                {panels[name]}
              </TabsContent>
            );
          })}
        </Tabs>
      </div>
    </Arriving>
  );
}

const DATA = ["chatServiceUrl", "profile", "error", "revision", "signIns", "memory"] as const;
const KeptAgentProfile = memo(AgentProfile, (prev, next) => prev.open === false && next.open === false && DATA.every((key) => prev[key] === next[key]));
export { KeptAgentProfile as AgentProfile };
