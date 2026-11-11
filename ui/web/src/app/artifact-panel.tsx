"use client";

import { useRenderTool } from "@copilotkit/react-core/v2";
import { m as motionElement } from "framer-motion";
import { AppWindowIcon, Maximize2Icon, Minimize2Icon, PrinterIcon, XIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
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

const SANDBOX_PAGE = "/artifact-sandbox/";
const SANDBOX = "allow-scripts allow-modals";
const OPEN_SIZE = "50%";

type Opened = { artifact: Published; full: boolean };
const Panel = createContext<{ opened: Opened | null; open: (opened: Opened | null) => void } | null>(null);

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

function useKept(opened: Opened | null) {
  const [kept, keep] = useState(opened);
  if (opened !== null && opened !== kept) keep(opened);
  return kept;
}

export function ArtifactLayout({ children }: { children: ReactNode }) {
  const [opened, open] = useState<Opened | null>(null);
  const kept = useKept(opened);
  const phone = useIsPhone();
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
      <Panel.Provider value={{ opened, open }}>
        {children}
        {kept && (
          <Sheet open={opened !== null} onClose={() => open(null)} title={kept.artifact.title} container={null} className="artifact-sheet">
            <ArtifactView opened={kept} />
          </Sheet>
        )}
      </Panel.Provider>
    );
  }
  return (
    <Panel.Provider value={{ opened, open }}>
      <ArtifactSplit opened={opened} close={() => open(null)}>{children}</ArtifactSplit>
    </Panel.Provider>
  );
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
          <motionElement.div {...presenceMotion} layout={false} key={opened.artifact.path} className="artifact-side">
            <ArtifactView opened={opened} heading={<DesktopHeading artifact={opened.artifact} />} controls={<DesktopControls opened={opened} />} />
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
    <button type="button" className="sent-file artifact-card" data-open={opened?.artifact.path === artifact.path || undefined}
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
  const { artifact, full } = opened;
  const frame = useRef<HTMLIFrameElement>(null);
  // The frame prints its own page: the app cannot reach into a frame of another origin.
  const print = () => frame.current?.contentWindow?.postMessage({ type: "artifact-print" }, "*");
  return (
    <section aria-label={artifact.title} className="artifact-panel" data-full={full || undefined}>
      <header className="artifact-panel-head">
        {heading}
        <span className="artifact-panel-actions">
          <button type="button" className="header-btn" aria-label="Download as PDF" title="Download as PDF" onClick={print}><PrinterIcon aria-hidden /></button>
          {controls}
        </span>
      </header>
      <ArtifactFrame key={artifact.path} artifact={artifact} frame={frame} />
    </section>
  );
}

function DesktopHeading({ artifact }: { artifact: Published }) {
  return (
    <span className="sent-file-text">
      <span className="sent-file-name">{artifact.title}</span>
      <span className="sent-file-kind">{kindOf(artifact)}</span>
    </span>
  );
}

function DesktopControls({ opened }: { opened: Opened }) {
  const { open } = usePanel();
  const { artifact, full } = opened;
  const label = full ? "Exit full screen" : "Full screen";
  const FullIcon = full ? Minimize2Icon : Maximize2Icon;
  return (
    <>
      <button type="button" className="header-btn" aria-label={label} title={label} onClick={() => open({ artifact, full: !full })}>
        <FullIcon aria-hidden />
      </button>
      <button type="button" className="header-btn" aria-label="Close" title="Close" onClick={() => open(null)}><XIcon aria-hidden /></button>
    </>
  );
}

function ArtifactFrame({ artifact, frame }: { artifact: Published; frame: RefObject<HTMLIFrameElement | null> }) {
  const [page, setPage] = useState<{ html: string } | { error: string } | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let current = true;
    agentFiles.url(artifact.path)
      .then((url) => fetch(url))
      .then((response) => {
        if (!response.ok) throw new Error(`Files answered ${response.status}`);
        return response.text();
      })
      .then((html) => current && setPage({ html }), (error: unknown) => current && setPage({ error: reason(error) }));
    return () => {
      current = false;
    };
  }, [artifact.path]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data?.type === "artifact-sandbox-ready") setReady(true);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [frame]);
  useEffect(() => {
    if (ready && page !== null && "html" in page) frame.current?.contentWindow?.postMessage({ type: "artifact-page", html: page.html }, "*");
  }, [ready, page, frame]);
  const failure = page !== null && "error" in page ? page.error : null;
  return (
    <>
      <Presence>{failure !== null && (
        <motionElement.p {...presenceMotion} role="alert" className="artifact-refused">Couldn&apos;t open {artifact.title}: {failure}</motionElement.p>
      )}</Presence>
      <iframe ref={frame} title={artifact.title} sandbox={SANDBOX} src={SANDBOX_PAGE} className="artifact-frame" />
    </>
  );
}
