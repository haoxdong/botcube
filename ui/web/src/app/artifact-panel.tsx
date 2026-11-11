"use client";

import { contentToText, type AbstractAgent } from "@ag-ui/client";
import { useRenderTool } from "@copilotkit/react-core/v2";
import { m as motionElement } from "framer-motion";
import { AppWindowIcon, Maximize2Icon, Minimize2Icon, PrinterIcon, XIcon } from "lucide-react";
import {
  createContext, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction,
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

/** A card's Artifact Version, which runs, or a Source the agent is writing, by its Files path, which previews. */
type Opened = ({ artifact: Published } | { source: string }) & { full: boolean };
type Open = Dispatch<SetStateAction<Opened | null>>;
const Panel = createContext<{ opened: Opened | null; open: Open; sources: ReadonlyMap<string, Source> } | null>(null);

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

const kindOf = (artifact: Published) => `Page · version ${artifact.version}`;

const titleOf = (opened: Opened) => "artifact" in opened ? opened.artifact.title : opened.source.slice(opened.source.lastIndexOf("/") + 1);

/** A version's Artifact is its Source's path. */
const pathOf = (opened: Opened) => "source" in opened ? opened.source : opened.artifact.id;

const sourceIn = (opened: Opened, sources: ReadonlyMap<string, Source>) => "source" in opened ? sources.get(opened.source) : undefined;

async function readFile(path: string): Promise<string> {
  const response = await fetch(await agentFiles.url(path));
  if (!response.ok) throw new Error(`Files answered ${response.status}`);
  return response.text();
}

function useKept(opened: Opened | null) {
  const [kept, keep] = useState(opened);
  if (opened !== null && opened !== kept) keep(opened);
  return kept;
}

export function ArtifactLayout({ agent, children }: { agent: AbstractAgent; children: ReactNode }) {
  const [opened, open] = useState<Opened | null>(null);
  const kept = useKept(opened);
  const phone = useIsPhone();
  const sources = useAgentSources(agent, opened, open, phone);
  useRenderTool({
    name: "Artifact",
    parameters: ArtifactCall,
    render: ({ status, parameters, result }) =>
      status === "complete" ? <ArtifactResult result={result} /> : (
        <p className="artifact-status">Publishing {parameters.title ?? parameters.file_path ?? "a page"}…</p>
      ),
  }, []);
  // A phone and a desktop lay the chat out differently, so turning across the breakpoint with an Artifact open
  // remounts the chat: rare, and the chat reloads its messages as it would on opening.
  if (phone) {
    return (
      <Panel.Provider value={{ opened, open, sources }}>
        {children}
        {kept && (
          <Sheet open={opened !== null} onClose={() => open(null)} title={titleOf(kept)} container={null} className="artifact-sheet">
            <ArtifactView opened={kept} />
          </Sheet>
        )}
      </Panel.Provider>
    );
  }
  return (
    <Panel.Provider value={{ opened, open, sources }}>
      <ArtifactSplit opened={opened} close={() => open(null)}>{children}</ArtifactSplit>
    </Panel.Provider>
  );
}

/**
 * The Sources the agent writes, from its runs' events as they stream; a reopened chat's finished writes are messages,
 * not events, so they change nothing. A write's first characters open its Source beside the chat on desktop when
 * nothing is open (on a phone it would cover the chat). A publish opens its new version in place of its Source or an
 * earlier version; nothing else replaces what is open.
 */
function useAgentSources(agent: AbstractAgent, opened: Opened | null, open: Open, phone: boolean) {
  const [sources, setSources] = useState<ReadonlyMap<string, Source>>(new Map());
  const shown = useRef(opened);
  shown.current = opened;
  const onPhone = useRef(phone);
  onPhone.current = phone;
  useEffect(() => {
    const calls = new Map<string, { name: string; path?: string | undefined; content?: string | undefined; streamed?: true }>();
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
        if (call?.name !== "write_file" && call?.name !== "edit_file") return;
        const args = toolCallBuffer + event.delta;
        // A path counts once it is whole: "/q3.htm" is on its way to "/q3.html".
        const { file_path: path } = FileCall.parse(parsePartial(args, Allow.OBJ));
        const { content } = FileCall.parse(parsePartial(args));
        Object.assign(call, { path, content });
        if (call.name !== "write_file" || path === undefined || content === undefined || !PREVIEWED.test(path)) return;
        keep({ path, html: content, complete: false });
        if (call.streamed === undefined && !onPhone.current) open((current) => current ?? { source: path, full: false });
        call.streamed = true;
      },
      onToolCallResultEvent: ({ event }) => {
        const call = calls.get(event.toolCallId);
        calls.delete(event.toolCallId);
        if (call === undefined) return;
        const result = contentToText(event.content);
        if (call.name === "Artifact") {
          const artifact = publishedOf(result);
          if (artifact !== null) open((current) => current !== null && pathOf(current) === artifact.id ? { artifact, full: current.full } : current);
          return;
        }
        const { name, path, content } = call;
        if (path === undefined || !PREVIEWED.test(path)) return;
        if (name === "write_file" && content !== undefined && WRITTEN.test(result)) keep({ path, html: content, complete: true });
        const previewed = shown.current;
        if (name === "edit_file" && EDITED.test(result) && previewed !== null && "source" in previewed && previewed.source === path) {
          readFile(path).then(
            (html) => keep({ path, html, complete: true }),
            (error: unknown) => keep({ path, error: `Couldn't show the edit to ${path}: ${reason(error)}` }),
          );
        }
      },
    }).unsubscribe;
  }, [agent, open]);
  return sources;
}

function ArtifactSplit({ opened, close, children }: { opened: Opened | null; close: () => void; children: ReactNode }) {
  const side = usePanelRef();
  const shown = opened !== null;
  useEffect(() => {
    const panel = side.current;
    if (panel === null) throw new Error("The Artifact panel mounted without its imperative handle");
    if (!shown) panel.collapse();
    else if (panel.isCollapsed()) panel.resize(OPEN_SIZE);
  }, [shown, side]);
  return (
    <ResizablePanelGroup orientation="horizontal" className="artifact-layout">
      <ResizablePanel id="chat" minSize="30%">{children}</ResizablePanel>
      <ResizableHandle disabled={!shown} data-closed={!shown || undefined} />
      <ResizablePanel id="artifact" panelRef={side} collapsible collapsedSize="0%" defaultSize="0%" minSize="25%"
        onResize={(size) => {
          if (shown && size.asPercentage === 0) close();
        }}>
        <Presence>{opened && (
          <motionElement.div {...presenceMotion} layout={false} key={pathOf(opened)} className="artifact-side">
            <ArtifactView opened={opened} heading={<DesktopHeading opened={opened} />} controls={<DesktopControls opened={opened} />} />
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
  const { opened, open } = usePanel();
  return (
    <button type="button" className="sent-file artifact-card" data-open={(opened !== null && "artifact" in opened && opened.artifact.path === artifact.path) || undefined}
      onClick={() => open({ artifact, full: false })}>
      <span className="file-icon"><AppWindowIcon aria-hidden /></span>
      <span className="sent-file-text">
        <span className="sent-file-name">{artifact.title}</span>
        <span className="sent-file-kind">{kindOf(artifact)}</span>
        <span className="artifact-card-description" hidden={!artifact.description}>{artifact.description}</span>
      </span>
    </button>
  );
}

function ArtifactView({ opened, heading, controls }: { opened: Opened; heading?: ReactNode; controls?: ReactNode }) {
  const { sources } = usePanel();
  const { full } = opened;
  const frame = useRef<HTMLIFrameElement>(null);
  const source = sourceIn(opened, sources);
  const title = titleOf(opened);
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
      <OpenedFrame opened={opened} source={source} title={title} frame={frame} />
    </section>
  );
}

function DesktopHeading({ opened }: { opened: Opened }) {
  const { sources } = usePanel();
  const source = sourceIn(opened, sources);
  const kind = "artifact" in opened ? kindOf(opened.artifact) : source !== undefined && "html" in source && !source.complete ? "Page · writing…" : "Page";
  return (
    <span className="sent-file-text">
      <span className="sent-file-name">{titleOf(opened)}</span>
      <span className="sent-file-kind">{kind}</span>
    </span>
  );
}

function DesktopControls({ opened }: { opened: Opened }) {
  const { open } = usePanel();
  const { full } = opened;
  const label = full ? "Exit full screen" : "Full screen";
  const FullIcon = full ? Minimize2Icon : Maximize2Icon;
  return (
    <>
      <button type="button" className="header-btn" aria-label={label} title={label} onClick={() => open({ ...opened, full: !full })}>
        <FullIcon aria-hidden />
      </button>
      <button type="button" className="header-btn" aria-label="Close" title="Close" onClick={() => open(null)}><XIcon aria-hidden /></button>
    </>
  );
}

function OpenedFrame({ opened, source, title, frame }: { opened: Opened; source: Source | undefined; title: string; frame: RefObject<HTMLIFrameElement | null> }) {
  if ("artifact" in opened) return <VersionFrame key={opened.artifact.path} artifact={opened.artifact} frame={frame} />;
  const failure = source !== undefined && "error" in source ? source.error : null;
  return (
    <>
      <Presence>{failure !== null && (
        <motionElement.p {...presenceMotion} role="alert" className="artifact-refused">{failure}</motionElement.p>
      )}</Presence>
      <SandboxFrame key={opened.source} title={title} html={source !== undefined && "html" in source ? source.html : null} runs={false} frame={frame} />
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
