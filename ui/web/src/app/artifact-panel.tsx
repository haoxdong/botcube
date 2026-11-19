"use client";

import { contentToText, type AbstractAgent } from "@ag-ui/client";
import { useRenderTool } from "@copilotkit/react-core/v2";
import { AnimatePresence, domAnimation, LazyMotion, m as motionElement, useIsPresent } from "motion/react";
import { Maximize2Icon, Minimize2Icon, PanelLeftIcon, PanelRightIcon, XIcon } from "lucide-react";
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch,
  type ComponentProps, type ReactNode, type SetStateAction,
} from "react";
import { usePanelRef } from "react-resizable-panels";
import { z } from "zod";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable";
import { Sheet } from "../components/ui/sheet";
import { agentFiles } from "./agent-files";
import { Refusal, useExports } from "./artifact-exports";
import { readBytes, readFile } from "./artifact-files";
import { newestInFiles, useNewestInFiles } from "./artifact-newest";
import { ArtifactFace } from "./artifact-face";
import { AnswerCards, Published, publishedOf } from "./artifact-published";
import { useArtifactRequest, type ArtifactRequest } from "./artifact-request";
import { TYPES } from "./artifact-types";
import type { ArtifactEdit, ViewerProps } from "./artifact-viewer";
import { withStorage } from "./main-chat-copy";
import { Layout } from "./collapse";
import { motionTokens } from "./motion-tokens";
import { useIsPhone } from "./phone-query";

/** The harness `Artifact` tool's arguments (botcube_harness_deepagents/artifact.py). */
const ArtifactCall = z.object({
  action: z.string().optional(),
  file_path: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
});

const OPEN_SIZE = "50%";

type Opened = { id: string; full: boolean };
type Open = Dispatch<SetStateAction<Opened | null>>;
type Shown = { artifact: Published; full: boolean };
const Panel = createContext<{
  shown: Shown | null;
  open: Open;
  /** A published version, from a card or the agent's publish, so the panel and every card of its Artifact open the newest. */
  seen: (artifact: Published) => void;
  /** Why Files couldn't give an opened Artifact's newest version, by its id. */
  failures: Readonly<Record<string, string | undefined>>;
} | null>(null);

function usePanel() {
  const panel = useContext(Panel);
  if (panel === null) throw new Error("An Artifact card needs the ArtifactLayout around the chat");
  return panel;
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

const kindOf = (artifact: Published) =>
  `${typeOf(artifact.type).label} · version ${artifact.version}${artifact.author === "user" ? " · saved by you" : ""}`;

const titleOf = (shown: Shown) => shown.artifact.title;
const pathOf = (shown: Shown) => shown.artifact.id;

function shownOf(opened: Opened | null, newest: Published | undefined): Shown | null {
  return opened === null || newest === undefined ? null : { artifact: newest, full: opened.full };
}

/** An Artifact's newest version in Files. */
const newestOf = (known: Published) => newestInFiles(known, typeOf(known.type).stored, readFile);

function useKept(shown: Shown | null) {
  const [kept, keep] = useState(shown);
  if (shown !== null && shown !== kept) keep(shown);
  return kept;
}

export function ArtifactLayout({ agent, children, header, accountId = "", request }: { agent: AbstractAgent; children: ReactNode; header?: ReactNode; accountId?: string | undefined; request?: ArtifactRequest | undefined }) {
  const [opened, open] = useState<Opened | null>(null);
  const [newest, setNewest] = useState<Readonly<Record<string, Published>>>({});
  const seen = useCallback((artifact: Published) => setNewest((known) =>
    (known[artifact.id]?.version ?? 0) >= artifact.version ? known : { ...known, [artifact.id]: artifact }), []);
  useArtifactRequest(request, accountId, seen, open);
  const artifact = opened === null ? undefined : newest[opened.id];
  const shown = useMemo(() => shownOf(opened, artifact), [opened, artifact]);
  const kept = useKept(shown);
  const phone = useIsPhone();
  useAgentPublications(agent, seen);
  const failures = useNewestInFiles(opened?.id, artifact, newestOf, seen);
  useRenderTool({
    name: "Artifact",
    parameters: ArtifactCall,
    render: ({ status, parameters, result }) => {
      const done = status === "complete";
      if (parameters.action === "list" || parameters.action === "read") {
        if (done && !isJson(result)) return null;
        const named = parameters.url ?? parameters.file_path;
        if (parameters.action === "list") return <p className="artifact-status">{done ? "Listed Artifacts" : "Listing Artifacts…"}</p>;
        return <p className="artifact-status">{done ? `Read ${named}` : `Reading ${named}…`}</p>;
      }
      return done ? <ArtifactResult result={result} /> : (
        <p className="artifact-status">Publishing {parameters.title ?? parameters.file_path ?? "a page"}…</p>
      );
    },
  }, []);
  const panel = { shown, open, seen, failures };
  return (
    <Panel.Provider value={panel}>
      <ArtifactSplit phone={phone} accountId={accountId} shown={phone ? null : shown} close={() => open(null)}><div className="artifact-chat-column">{header}{children}</div></ArtifactSplit>
      {phone && kept && (
        <Sheet open={shown !== null} onClose={() => open(null)} title={titleOf(kept)} container={null} className="artifact-sheet">
          <ArtifactView key={pathOf(kept)} shown={kept} heading={<span className="sent-file-kind"><Kind shown={kept} /></span>} />
        </Sheet>
      )}
    </Panel.Provider>
  );
}

function useAgentPublications(agent: AbstractAgent, seen: (artifact: Published) => void) {
  useEffect(() => {
    const calls = new Map<string, string>();
    return agent.subscribe({
      onToolCallStartEvent: ({ event }) => {
        if (event.toolCallName === "Artifact") calls.set(event.toolCallId, "");
      },
      onToolCallArgsEvent: ({ event }) => {
        const args = calls.get(event.toolCallId);
        if (args !== undefined) calls.set(event.toolCallId, args + event.delta);
      },
      onToolCallResultEvent: ({ event }) => {
        const args = calls.get(event.toolCallId);
        calls.delete(event.toolCallId);
        if (args === undefined || !publishes(args || "{}")) return;
        const artifact = publishedOf(contentToText(event.content));
        if (artifact !== null) seen(artifact);
      },
    }).unsubscribe;
  }, [agent, seen]);
}

function ArtifactSplit({ shown, close, children, accountId, phone }: { phone: boolean; shown: Shown | null; close: () => void; children: ReactNode; accountId: string }) {
  const preference = `botcube.artifact-side.${accountId}`;
  const [position, setPosition] = useState<"left" | "right">("left");
  useEffect(() => {
    setPosition(withStorage(() => localStorage.getItem(preference)) === "right" ? "right" : "left");
  }, [preference]);
  const switchSide = () => {
    const next = position === "left" ? "right" : "left";
    withStorage(() => localStorage.setItem(preference, next));
    setPosition(next);
  };
  const side = usePanelRef();
  const isOpen = shown !== null;
  const { quick } = motionTokens();
  useEffect(() => {
    const panel = side.current;
    if (panel === null) throw new Error("The Artifact panel mounted without its imperative handle");
    if (!isOpen) panel.collapse();
    else if (panel.isCollapsed()) panel.resize(OPEN_SIZE);
  }, [isOpen, side]);
  // Motion's `layout` measures on every render; the chat column glides only for the Artifact panel.
  return (
    <ResizablePanelGroup orientation="horizontal" className="artifact-layout" data-side={position} dir={position === "left" ? "rtl" : "ltr"}>
      <ResizablePanel id="chat" className="artifact-chat-panel" minSize="30%" style={{ overflow: "visible" }}><Layout className="artifact-chat-motion" layout={phone ? false : "position"} layoutDependency={`${isOpen} ${position}`} style={{ direction: "ltr" }}>{children}</Layout></ResizablePanel>
      <ResizableHandle className="resizable-handle" disabled={!isOpen} data-closed={!isOpen || undefined} />
      <ResizablePanel id="artifact" className="artifact-side-panel" style={{ overflow: "visible" }} panelRef={side} collapsible collapsedSize="0%" defaultSize="0%" minSize="25%"
        onResize={(size, _id, previous) => {
          if (isOpen && size.asPercentage === 0 && previous?.asPercentage) close();
        }}>
        <LazyMotion features={domAnimation} strict><AnimatePresence mode="popLayout" initial={false}>{shown && (
          <ArtifactSide key={pathOf(shown)} className="artifact-side" initial={quick.visualDuration === 0 ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ opacity: quick }}>
            <Layout className="artifact-view-motion" layout={shown.full ? false : "position"} {...(shown.full ? { transformTemplate: () => "none" } : {})} style={{ direction: "ltr" }}><ArtifactView shown={shown} heading={<DesktopHeading shown={shown} />} controls={<DesktopControls shown={shown} position={position} switchSide={switchSide} />} /></Layout>
          </ArtifactSide>
        )}</AnimatePresence></LazyMotion>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function ArtifactSide(props: ComponentProps<typeof motionElement.div>) {
  const present = useIsPresent();
  return <motionElement.div {...props} inert={!present} data-closing={present ? undefined : ""} />;
}

function ArtifactResult({ result }: { result: string }) {
  const cards = useContext(AnswerCards);
  const artifact = publishedOf(result);
  if (artifact === null || cards.some(({ id }) => id === artifact.id)) return null;
  return <ArtifactCard artifact={artifact} />;
}

export function ArtifactCard({ artifact }: { artifact: Published }) {
  const { shown, open, seen } = usePanel();
  useEffect(() => seen(artifact), [seen, artifact]);
  return (
    <button type="button" data-artifact-id={artifact.id} className={`sent-file artifact-card ${typeOf(artifact.type).tint}`} data-open={(shown !== null && shown.artifact.id === artifact.id) || undefined}
      onClick={() => open({ id: artifact.id, full: false })}>
      <ArtifactFace artifact={artifact} />
    </button>
  );
}

function ArtifactView({ shown, heading, controls }: { shown: Shown; heading?: ReactNode; controls?: ReactNode }) {
  const { failures } = usePanel();
  const failure = failures[shown.artifact.id];
  const { full } = shown;
  const frame = useRef<HTMLIFrameElement>(null);
  const title = titleOf(shown);
  const type = typeOf(shown.artifact.type);
  const exports = useExports(type.exports, { title, frame, read: readFile, readBytes, newest: shown.artifact });
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
      <ShownFrame shown={shown} frame={frame} shows={exports.shows} />
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

function Kind({ shown }: { shown: Shown }) {
  return kindOf(shown.artifact);
}

function DesktopControls({ shown, position, switchSide }: { shown: Shown; position: "left" | "right"; switchSide: () => void }) {
  const { open } = usePanel();
  const { full } = shown;
  const label = full ? "Exit full screen" : "Full screen";
  const FullIcon = full ? Minimize2Icon : Maximize2Icon;
  const move = position === "left" ? "Move panel to right" : "Move panel to left";
  const SideIcon = position === "left" ? PanelRightIcon : PanelLeftIcon;
  return (
    <>
      <button type="button" className="header-btn" aria-label={move} title={move} onClick={switchSide}><SideIcon aria-hidden /></button>
      <button type="button" className="header-btn" aria-label={label} title={label} onClick={() => open((current) => current && { ...current, full: !full })}>
        <FullIcon aria-hidden />
      </button>
      <button type="button" className="header-btn" aria-label="Close" title="Close" onClick={() => open(null)}><XIcon aria-hidden /></button>
    </>
  );
}

function ShownFrame({ shown, frame, shows }: { shown: Shown } & Pick<ViewerProps, "frame" | "shows">) {
  const { seen } = usePanel();
  const save = useCallback(async (edit: ArtifactEdit) => seen(Published.parse(await agentFiles.saveArtifact(edit))), [seen]);
  const { Viewer } = typeOf(shown.artifact.type);
  return <Viewer key={shown.artifact.id} artifact={shown.artifact} read={readFile} readBytes={readBytes} save={save} frame={frame} shows={shows} />;
}
