"use client";

import { contentToText, type AbstractAgent } from "@ag-ui/client";
import { useRenderTool } from "@copilotkit/react-core/v2";
import { m as motionElement } from "framer-motion";
import { AppWindowIcon, Maximize2Icon, Minimize2Icon, PrinterIcon, XIcon } from "lucide-react";
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type RefObject,
  type SetStateAction,
} from "react";
import { Allow, parse as parsePartial } from "partial-json";
import { usePanelRef } from "react-resizable-panels";
import { z } from "zod";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable";
import { Sheet } from "../components/ui/sheet";
import { agentFiles } from "./agent-files";
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
  type: z.null(),
  title: z.string(),
  description: z.string(),
  version: z.number(),
  path: z.string(),
});
type Published = z.infer<typeof Published>;

/** deepagents' `write_file` and `edit_file` arguments, as far as the panel reads them. */
const FileCall = z.object({ file_path: z.string().optional(), content: z.string().optional() });

/** What deepagents' file tools answer when the file is written; anything else (an error, a stopped call) is not. */
const WRITTEN = /^Updated file /;
const EDITED = /^Successfully replaced /;

// Any HTML write previews: a Source becomes an Artifact only on the publish that follows its write, and a preview runs
// no scripts. Markdown joins once the panel has a viewer for it.
const PREVIEWED = /\.html?$/i;

/** A Source as the agent last wrote it, `complete` once its file is; or why the panel couldn't read it after an edit. */
type Source = { path: string } & ({ html: string; complete: boolean } | { error: string });

const PREVIEW_MS = 250;

const SANDBOX_PAGE = "/artifact-sandbox/";
const SANDBOX = "allow-scripts allow-modals";
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

const kindOf = (artifact: Published) => `Page · version ${artifact.version}`;

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

async function readFile(path: string): Promise<string> {
  const response = await fetch(await agentFiles.url(path));
  if (!response.ok) throw new Error(`Files answered ${response.status}`);
  return response.text();
}

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
  const panel = { shown, open, seen, sources };
  // A phone and a desktop lay the chat out differently, so turning across the breakpoint with an Artifact open
  // remounts the chat: rare, and the chat reloads its messages as it would on opening.
  if (phone) {
    return (
      <Panel.Provider value={panel}>
        {children}
        {kept && (
          <Sheet open={shown !== null} onClose={() => open(null)} title={titleOf(kept)} container={null} className="artifact-sheet">
            <ArtifactView shown={kept} />
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
        if (call.name !== "write_file" || path === undefined || content === undefined || !PREVIEWED.test(path)) return;
        keep({ path, html: content, complete: false });
        const { phone, newest } = latest.current;
        if (call.streamed === undefined && !phone) {
          const over = newest[path]?.version ?? 0;
          open((current) => current ?? { id: path, full: false, over });
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
        if (path === undefined || !PREVIEWED.test(path)) return;
        if (name === "write_file" && content !== undefined && WRITTEN.test(result)) keep({ path, html: content, complete: true });
        const previewed = latest.current.shown;
        if (name === "edit_file" && EDITED.test(result) && previewed !== null && "source" in previewed && previewed.source === path) {
          readFile(path).then(
            (html) => keep({ path, html, complete: true }),
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
  const { sources } = usePanel();
  const { full } = shown;
  const frame = useRef<HTMLIFrameElement>(null);
  const source = sourceIn(shown, sources);
  const title = titleOf(shown);
  // The frame prints its own page: the app cannot reach into a frame of another origin.
  const print = () => frame.current?.contentWindow?.postMessage({ type: "artifact-print" }, "*");
  return (
    <section aria-label={title} className="artifact-panel" data-full={full || undefined}>
      <header className="artifact-panel-head">
        {heading}
        <span className="artifact-panel-actions">
          <button type="button" className="header-btn" aria-label="Download as PDF" title="Download as PDF" onClick={print}><PrinterIcon aria-hidden /></button>
          {controls}
        </span>
      </header>
      <ShownFrame shown={shown} source={source} title={title} frame={frame} />
    </section>
  );
}

function DesktopHeading({ shown }: { shown: Shown }) {
  const { sources } = usePanel();
  const source = sourceIn(shown, sources);
  const kind = "artifact" in shown ? kindOf(shown.artifact) : source !== undefined && "html" in source && !source.complete ? "Page · writing…" : "Page";
  return (
    <span className="sent-file-text">
      <span className="sent-file-name">{titleOf(shown)}</span>
      <span className="sent-file-kind">{kind}</span>
    </span>
  );
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

function ShownFrame({ shown, source, title, frame }: { shown: Shown; source: Source | undefined; title: string; frame: RefObject<HTMLIFrameElement | null> }) {
  if ("artifact" in shown) return <VersionFrame key={shown.artifact.path} artifact={shown.artifact} frame={frame} />;
  const failure = source !== undefined && "error" in source ? source.error : null;
  return (
    <>
      <Presence>{failure !== null && (
        <motionElement.p {...presenceMotion} role="alert" className="artifact-refused">{failure}</motionElement.p>
      )}</Presence>
      <SandboxFrame key={shown.source} title={title} html={source !== undefined && "html" in source ? source.html : null} runs={false} frame={frame} />
    </>
  );
}

function VersionFrame({ artifact, frame }: { artifact: Published; frame: RefObject<HTMLIFrameElement | null> }) {
  const [page, setPage] = useState<{ html: string } | { error: string } | null>(null);
  useEffect(() => {
    let current = true;
    readFile(artifact.path).then(
      (html) => current && setPage({ html }),
      (error: unknown) => current && setPage({ error: reason(error) }),
    );
    return () => {
      current = false;
    };
  }, [artifact.path]);
  const failure = page !== null && "error" in page ? page.error : null;
  return (
    <>
      <Presence>{failure !== null && (
        <motionElement.p {...presenceMotion} role="alert" className="artifact-refused">Couldn&apos;t open {artifact.title}: {failure}</motionElement.p>
      )}</Presence>
      <SandboxFrame title={artifact.title} html={page !== null && "html" in page ? page.html : null} runs frame={frame} />
    </>
  );
}

/**
 * The sandbox page, sent `html` once it says it is ready. A published version `runs` with its scripts. A Source only
 * previews, without them (the sandbox draws it in a frame of its own that allows no scripts), at most four times a
 * second: only a Source that passed its publish runs.
 */
function SandboxFrame({ title, html, runs, frame }: { title: string; html: string | null; runs: boolean; frame: RefObject<HTMLIFrameElement | null> }) {
  const [ready, setReady] = useState(false);
  const rendered = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data?.type === "artifact-sandbox-ready") setReady(true);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [frame]);
  useEffect(() => {
    if (!ready || html === null) return;
    const render = () => {
      rendered.current = Date.now();
      frame.current?.contentWindow?.postMessage({ type: runs ? "artifact-page" : "artifact-preview", html }, "*");
    };
    const wait = runs ? 0 : rendered.current + PREVIEW_MS - Date.now();
    if (wait <= 0) {
      render();
      return;
    }
    const timer = setTimeout(render, wait);
    return () => clearTimeout(timer);
  }, [ready, html, runs, frame]);
  return <iframe ref={frame} title={title} sandbox={SANDBOX} src={SANDBOX_PAGE} className="artifact-frame" />;
}
