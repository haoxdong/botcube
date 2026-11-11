"use client";

import { contentToText, type AbstractAgent } from "@ag-ui/client";
import { useRenderTool } from "@copilotkit/react-core/v2";
import { m as motionElement } from "framer-motion";
import { AppWindowIcon, Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch,
  type ReactNode, type SetStateAction,
} from "react";
import { Allow, parse as parsePartial } from "partial-json";
import { usePanelRef } from "react-resizable-panels";
import { z } from "zod";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable";
import { Sheet } from "../components/ui/sheet";
import { agentFiles } from "./agent-files";
import { Refusal, useExports } from "./artifact-exports";
import { readBytes, readFile } from "./artifact-files";
import { newestInFiles, useNewestInFiles } from "./artifact-newest";
import { deckFiles, deckOf, DeckFrame, sourceOf } from "./artifact-slides";
import { TYPES, writtenType } from "./artifact-types";
import type { ArtifactEdit, ArtifactType, ViewerProps } from "./artifact-viewer";
import { Presence, presenceMotion } from "./collapse";
import { reason } from "./composer-files";
import { useIsPhone } from "./phone-query";

/** The harness `Artifact` tool's arguments (botcube_harness_deepagents/artifact.py). */
const ArtifactCall = z.object({
  action: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
});

const Published = z.object({
  id: z.string(),
  type: z.enum(["slides", "doc", "sheet", "email"]).nullable(),
  title: z.string(),
  description: z.string(),
  version: z.number(),
  path: z.string(),
  author: z.enum(["agent", "user"]).optional(),
});
type Published = z.infer<typeof Published>;

/** deepagents' `write_file` and `edit_file` arguments, as far as the panel reads them. */
const FileCall = z.object({ file_path: z.string().optional(), content: z.string().optional() });

/** What deepagents' file tools answer when the file is written; anything else (an error, a stopped call) is not. */
const WRITTEN = /^Updated file /;
const EDITED = /^Successfully replaced /;

/** A Source as the agent last wrote it, `complete` once its file is; or why the panel couldn't read it after an edit. */
type Source = { path: string } & ({ text: string; complete: boolean } | { error: string });

const OPEN_SIZE = "50%";

/**
 * The Artifact the panel shows, by its id (its Source's Files path). The panel shows the newest version the chat has
 * seen published; one a write opened previews the Source instead until a version newer than `over` is published.
 */
type Opened = { id: string; full: boolean; over?: number };
type Open = Dispatch<SetStateAction<Opened | null>>;
/** What the panel draws: an Artifact Version, which runs, or a Source the agent is writing, which previews. */
type Shown = ({ artifact: Published } | { source: string }) & { full: boolean };
const Panel = createContext<{
  shown: Shown | null;
  open: Open;
  /** A published version, from a card or the agent's publish, so the panel and every card of its Artifact open the newest. */
  seen: (artifact: Published) => void;
  sources: ReadonlyMap<string, Source>;
  /** Why Files couldn't give an opened Artifact's newest version, by its id. */
  failures: Readonly<Record<string, string | undefined>>;
} | null>(null);

function usePanel() {
  const panel = useContext(Panel);
  if (panel === null) throw new Error("An Artifact card needs the ArtifactLayout around the chat");
  return panel;
}

/** A refused publish's result is the tool's error text, never JSON; a JSON result that is no Artifact throws. */
export function publishedOf(result: string): Published | null {
  let json: unknown;
  try {
    json = JSON.parse(result);
  } catch {
    return null;
  }
  return Published.parse(json);
}

/** A read or list answers JSON; anything else is the tool's error text. */
function isJson(result: string) {
  try {
    JSON.parse(result);
    return true;
  } catch {
    return false;
  }
}

/** A call without an action publishes. */
const publishes = (args: string) => (ArtifactCall.parse(JSON.parse(args)).action ?? "publish") === "publish";

const typeOf = (type: Published["type"]) => TYPES[type ?? "page"];

// A Source becomes an Artifact only on the publish that follows its write, and a preview runs no scripts.
const previewed = (path: string) => deckOf(path) !== null || writtenType(path) !== undefined;

/** A Source being written: a deck's by its files, a one-file Source by its path. */
const sourceType = (path: string, sources: ReadonlyMap<string, Source>): ArtifactType =>
  deckFiles(path, sources.values()) !== null ? TYPES.slides : writtenType(path) ?? TYPES.page;

const kindOf = (artifact: Published) =>
  `${typeOf(artifact.type).label} · version ${artifact.version}${artifact.author === "user" ? " · saved by you" : ""}`;

const titleOf = (shown: Shown) => "artifact" in shown ? shown.artifact.title : shown.source.slice(shown.source.lastIndexOf("/") + 1);

/** A version's Artifact is its Source's path. */
const pathOf = (shown: Shown) => "source" in shown ? shown.source : shown.artifact.id;

const sourceIn = (shown: Shown, sources: ReadonlyMap<string, Source>) => "source" in shown ? sources.get(shown.source) : undefined;

/** `newest` is the newest version of the opened Artifact the chat has seen published. */
function shownOf(opened: Opened | null, newest: Published | undefined): Shown | null {
  if (opened === null) return null;
  const { id, full, over } = opened;
  if (over !== undefined && (newest?.version ?? 0) <= over) return { source: id, full };
  return newest === undefined ? null : { artifact: newest, full };
}

/** An Artifact's newest version in Files. */
const newestOf = (known: Published) => newestInFiles(known, typeOf(known.type).stored, readFile);

function useKept(shown: Shown | null) {
  const [kept, keep] = useState(shown);
  if (shown !== null && shown !== kept) keep(shown);
  return kept;
}

export function ArtifactLayout({ agent, children }: { agent: AbstractAgent; children: ReactNode }) {
  const [opened, open] = useState<Opened | null>(null);
  const [newest, setNewest] = useState<Readonly<Record<string, Published>>>({});
  const seen = useCallback((artifact: Published) => setNewest((known) =>
    (known[artifact.id]?.version ?? 0) >= artifact.version ? known : { ...known, [artifact.id]: artifact }), []);
  const artifact = opened === null ? undefined : newest[opened.id];
  const shown = useMemo(() => shownOf(opened, artifact), [opened, artifact]);
  const kept = useKept(shown);
  const phone = useIsPhone();
  const sources = useAgentSources(agent, { shown, newest, open, seen, phone });
  const failures = useNewestInFiles(opened?.id, artifact, newestOf, seen);
  useRenderTool({
    name: "Artifact",
    parameters: ArtifactCall,
    render: ({ status, parameters, result }) => {
      const done = status === "complete";
      if (parameters.action === "list" || parameters.action === "read") {
        if (done && !isJson(result)) return <p role="alert" className="artifact-refused">{result}</p>;
        const named = parameters.url ?? parameters.file_path;
        if (parameters.action === "list") return <p className="artifact-status">{done ? "Listed Artifacts" : "Listing Artifacts…"}</p>;
        return <p className="artifact-status">{done ? `Read ${named}` : `Reading ${named}…`}</p>;
      }
      return done ? <ArtifactResult result={result} /> : (
        <p className="artifact-status">Publishing {parameters.title ?? parameters.file_path ?? "a page"}…</p>
      );
    },
  }, []);
  const panel = { shown, open, seen, sources, failures };
  // A phone and a desktop lay the chat out differently, so turning across the breakpoint with an Artifact open
  // remounts the chat: rare, and the chat reloads its messages as it would on opening.
  if (phone) {
    return (
      <Panel.Provider value={panel}>
        {children}
        {kept && (
          <Sheet open={shown !== null} onClose={() => open(null)} title={titleOf(kept)} container={null} className="artifact-sheet">
            <ArtifactView key={pathOf(kept)} shown={kept} heading={<span className="sent-file-kind"><Kind shown={kept} /></span>} />
          </Sheet>
        )}
      </Panel.Provider>
    );
  }
  return (
    <Panel.Provider value={panel}>
      <ArtifactSplit shown={shown} close={() => open(null)}>{children}</ArtifactSplit>
    </Panel.Provider>
  );
}

type Following = {
  shown: Shown | null;
  newest: Readonly<Record<string, Published>>;
  open: Open;
  seen: (artifact: Published) => void;
  phone: boolean;
};

/**
 * The Sources the agent writes, from its runs' events as they stream; a reopened chat's finished writes are messages,
 * not events, so they change nothing. A write's first characters open its Source beside the chat on desktop when
 * nothing is open (on a phone it would cover the chat). A publish is `seen` as its Artifact's newest version, which
 * the panel then shows in place of its Source or an earlier version; nothing else replaces what is open.
 */
function useAgentSources(agent: AbstractAgent, following: Following) {
  const [sources, setSources] = useState<ReadonlyMap<string, Source>>(new Map());
  const latest = useRef(following);
  latest.current = following;
  const { open, seen } = following;
  useEffect(() => {
    const calls = new Map<string, { name: string; args?: string; path?: string | undefined; content?: string | undefined; streamed?: true }>();
    const keep = (source: Source) => setSources((current) => new Map(current).set(source.path, source));
    // AG-UI fixes a run's subscribers when the run starts, so this one sees whole runs.
    return agent.subscribe({
      onToolCallStartEvent: ({ event }) => {
        calls.set(event.toolCallId, { name: event.toolCallName });
      },
      // AG-UI's `partialToolCallArgs` is never the parsed arguments: it is untruncate-json's repaired text, or {} where
      // that package's CommonJS default export fails to load as ESM.
      onToolCallArgsEvent: ({ event, toolCallBuffer }) => {
        const call = calls.get(event.toolCallId);
        const args = toolCallBuffer + event.delta;
        if (call?.name === "Artifact") call.args = args;
        if (call?.name !== "write_file" && call?.name !== "edit_file") return;
        // A path counts once it is whole: "/q3.htm" is on its way to "/q3.html".
        const { file_path: path } = FileCall.parse(parsePartial(args, Allow.OBJ));
        const { content } = FileCall.parse(parsePartial(args));
        Object.assign(call, { path, content });
        if (call.name !== "write_file" || path === undefined || content === undefined || !previewed(path)) return;
        keep({ path, text: content, complete: false });
        const { phone, newest } = latest.current;
        if (call.streamed === undefined && !phone) {
          const id = sourceOf(path);
          const over = newest[id]?.version ?? 0;
          open((current) => current ?? { id, full: false, over });
        }
        call.streamed = true;
      },
      onToolCallResultEvent: ({ event }) => {
        const call = calls.get(event.toolCallId);
        calls.delete(event.toolCallId);
        if (call === undefined) return;
        const result = contentToText(event.content);
        if (call.name === "Artifact") {
          // A read or a list answers JSON too, but it publishes nothing.
          const artifact = publishes(call.args ?? "{}") ? publishedOf(result) : null;
          if (artifact !== null) seen(artifact);
          return;
        }
        const { name, path, content } = call;
        if (path === undefined || !previewed(path)) return;
        if (name === "write_file" && content !== undefined && WRITTEN.test(result)) keep({ path, text: content, complete: true });
        const shownNow = latest.current.shown;
        if (name === "edit_file" && EDITED.test(result) && shownNow !== null && "source" in shownNow && shownNow.source === sourceOf(path)) {
          readFile(path).then(
            (text) => keep({ path, text, complete: true }),
            (error: unknown) => keep({ path, error: `Couldn't show the edit to ${path}: ${reason(error)}` }),
          );
        }
      },
    }).unsubscribe;
  }, [agent, open, seen]);
  return sources;
}

function ArtifactSplit({ shown, close, children }: { shown: Shown | null; close: () => void; children: ReactNode }) {
  const side = usePanelRef();
  const isOpen = shown !== null;
  useEffect(() => {
    const panel = side.current;
    if (panel === null) throw new Error("The Artifact panel mounted without its imperative handle");
    if (!isOpen) panel.collapse();
    else if (panel.isCollapsed()) panel.resize(OPEN_SIZE);
  }, [isOpen, side]);
  return (
    <ResizablePanelGroup orientation="horizontal" className="artifact-layout">
      <ResizablePanel id="chat" minSize="30%">{children}</ResizablePanel>
      <ResizableHandle disabled={!isOpen} data-closed={!isOpen || undefined} />
      <ResizablePanel id="artifact" panelRef={side} collapsible collapsedSize="0%" defaultSize="0%" minSize="25%"
        onResize={(size) => {
          if (isOpen && size.asPercentage === 0) close();
        }}>
        <Presence>{shown && (
          <motionElement.div {...presenceMotion} layout={false} key={pathOf(shown)} className="artifact-side">
            <ArtifactView shown={shown} heading={<DesktopHeading shown={shown} />} controls={<DesktopControls shown={shown} />} />
          </motionElement.div>
        )}</Presence>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function ArtifactResult({ result }: { result: string }) {
  const artifact = publishedOf(result);
  if (artifact === null) return <p role="alert" className="artifact-refused">{result}</p>;
  return <ArtifactCard artifact={artifact} />;
}

function ArtifactCard({ artifact }: { artifact: Published }) {
  const { shown, open, seen } = usePanel();
  useEffect(() => seen(artifact), [seen, artifact]);
  return (
    <button type="button" className="sent-file artifact-card" data-open={(shown !== null && "artifact" in shown && shown.artifact.id === artifact.id) || undefined}
      onClick={() => open({ id: artifact.id, full: false })}>
      <span className="file-icon"><AppWindowIcon aria-hidden /></span>
      <span className="sent-file-text">
        <span className="sent-file-name">{artifact.title}</span>
        <span className="sent-file-kind">{kindOf(artifact)}</span>
        <span className="artifact-card-description" hidden={!artifact.description}>{artifact.description}</span>
      </span>
    </button>
  );
}

function ArtifactView({ shown, heading, controls }: { shown: Shown; heading?: ReactNode; controls?: ReactNode }) {
  const { sources, failures } = usePanel();
  const failure = "artifact" in shown ? failures[shown.artifact.id] : undefined;
  const { full } = shown;
  const frame = useRef<HTMLIFrameElement>(null);
  const source = sourceIn(shown, sources);
  const title = titleOf(shown);
  const type = "artifact" in shown ? typeOf(shown.artifact.type) : sourceType(shown.source, sources);
  const exports = useExports(type.exports, { title, frame, read: readFile, readBytes, newest: "artifact" in shown ? shown.artifact : null });
  return (
    <section aria-label={title} className="artifact-panel" data-full={full || undefined}>
      <header className="artifact-panel-head">
        {heading}
        <span className="artifact-panel-actions">
          {exports.buttons}
          {controls}
        </span>
      </header>
      <Refusal message={failure ?? null} />
      {exports.failure}
      <ShownFrame shown={shown} source={source} title={title} frame={frame} shows={exports.shows} />
    </section>
  );
}

function DesktopHeading({ shown }: { shown: Shown }) {
  return (
    <span className="sent-file-text">
      <span className="sent-file-name">{titleOf(shown)}</span>
      <span className="sent-file-kind"><Kind shown={shown} /></span>
    </span>
  );
}

/** What the panel shows: a version by its type, or a Source by its type and whether the agent is still writing it. */
function Kind({ shown }: { shown: Shown }) {
  const { sources } = usePanel();
  const source = sourceIn(shown, sources);
  if ("artifact" in shown) return kindOf(shown.artifact);
  const deck = deckFiles(shown.source, sources.values());
  const { label } = sourceType(shown.source, sources);
  const writing = deck !== null ? deck.writing : source !== undefined && "text" in source && !source.complete;
  return writing ? `${label} · writing…` : label;
}

function DesktopControls({ shown }: { shown: Shown }) {
  const { open } = usePanel();
  const { full } = shown;
  const label = full ? "Exit full screen" : "Full screen";
  const FullIcon = full ? Minimize2Icon : Maximize2Icon;
  return (
    <>
      <button type="button" className="header-btn" aria-label={label} title={label} onClick={() => open((current) => current && { ...current, full: !full })}>
        <FullIcon aria-hidden />
      </button>
      <button type="button" className="header-btn" aria-label="Close" title="Close" onClick={() => open(null)}><XIcon aria-hidden /></button>
    </>
  );
}

function ShownFrame({ shown, source, title, frame, shows }: { shown: Shown; source: Source | undefined; title: string } & Pick<ViewerProps, "frame" | "shows">) {
  const { sources, seen } = usePanel();
  const save = useCallback(async (edit: ArtifactEdit) => seen(Published.parse(await agentFiles.saveArtifact(edit))), [seen]);
  const deck = useMemo(() => "source" in shown ? deckFiles(shown.source, sources.values()) : null, [shown, sources]);
  if ("artifact" in shown) {
    // Keyed by the Artifact, so a Viewer editing a version stays mounted when a newer one arrives.
    const { Viewer } = typeOf(shown.artifact.type);
    return <Viewer key={shown.artifact.id} artifact={shown.artifact} read={readFile} readBytes={readBytes} save={save} frame={frame} shows={shows} />;
  }
  if (deck !== null) {
    return <DeckFrame key={shown.source} title={title} folder={shown.source} files={deck.files} errors={deck.errors} runs={false} frame={frame} />;
  }
  const failure = source !== undefined && "error" in source ? source.error : null;
  const { text, complete } = source !== undefined && "text" in source ? source : { text: null, complete: false };
  const { Preview } = writtenType(shown.source)?.writes ?? TYPES.page.writes;
  return (
    <>
      <Refusal message={failure} />
      <Preview key={shown.source} title={title} text={text} complete={complete} frame={frame} />
    </>
  );
}
