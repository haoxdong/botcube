"use client";

import { contentToText, type AbstractAgent } from "@ag-ui/client";
import { useRenderTool } from "@copilotkit/react-core/v2";
import { AnimatePresence, domAnimation, LazyMotion, m as motionElement, useIsPresent } from "motion/react";
import { ChevronDownIcon, Maximize2Icon, Minimize2Icon, PanelLeftIcon, PanelRightIcon, XIcon } from "lucide-react";
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch,
  type ComponentProps, type ReactNode, type SetStateAction,
} from "react";
import { usePanelRef } from "react-resizable-panels";
import { z } from "zod";

import { webUiPlugin } from "@bot-ui";

import { listFiles } from "../computer/files-service";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable";
import { Sheet } from "../components/ui/sheet";
import { chatServiceUrl } from "../plugin/chat-service-url";
import { agentFiles } from "./agent-files";
import { Refusal, useExports } from "./artifact-exports";
import { readBytes, readFile } from "./artifact-files";
import { newestInFiles, useNewestInFiles } from "./artifact-newest";
import { ArtifactFace } from "./artifact-face";
import { agoOf, byDay, historyOf, timeOf, type HistoryVersion } from "./artifact-history";
import { AnswerCards, Published, publishedOf } from "./artifact-published";
import { useArtifactRequest, type ArtifactRequest } from "./artifact-request";
import { TYPES } from "./artifact-types";
import type { ArtifactEdit, ViewerProps } from "./artifact-viewer";
import { withStorage } from "./main-chat-copy";
import { Fade, Layout, Swap } from "./collapse";
import { motionTokens } from "./motion-tokens";
import type { AgentProfileData } from "./agent-profile";
import { Avatar } from "./avatar";
import { reason } from "./composer-files";
import { useIsPhone } from "./phone-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

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
  /** The agent as a version's author: its name, and its picture or emoji when it has one. */
  agent: { name: string; picture?: string | undefined; avatar?: string | undefined };
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

export function ArtifactLayout({ agent, profile = null, children, header, accountId = "", request }: { agent: AbstractAgent; profile?: AgentProfileData | null; children: ReactNode; header?: ReactNode; accountId?: string | undefined; request?: ArtifactRequest | undefined }) {
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
  const author = { name: profile?.name ?? webUiPlugin.config.agentName, picture: profile?.picture ?? undefined, avatar: profile?.avatar };
  const panel = { agent: author, shown, open, seen, failures };
  return (
    <Panel.Provider value={panel}>
      <ArtifactSplit phone={phone} accountId={accountId} shown={phone ? null : shown} close={() => open(null)}><div className="artifact-chat-column">{header}{children}</div></ArtifactSplit>
      {/* Mounted closed before the first open, so Base UI plays its starting style instead of painting the Sheet in place. */}
      {phone && (
        <Sheet open={shown !== null} onClose={() => open(null)} title={kept && titleOf(kept)} container={null} className="artifact-sheet">
          <SheetView shown={kept} />
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

/** The phone Sheet's body. Nothing is kept before the first open, while Base UI hasn't mounted the Sheet's popup. */
function SheetView({ shown }: { shown: Shown | null }) {
  if (shown === null) return null;
  return <ArtifactView key={pathOf(shown)} shown={shown} heading={<History shown={shown} />} />;
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
  const { menu, failure: exportFailure, shows } = useExports(type.exports, { title, frame, read: readFile, readBytes, newest: shown.artifact });
  return (
    <section aria-label={title} className="artifact-panel" data-full={full || undefined}>
      <header className="artifact-panel-head">
        {heading}
        <span className="artifact-panel-actions">
          {menu}
          {controls}
        </span>
      </header>
      <Refusal message={failure ?? null} />
      {exportFailure}
      <ShownFrame shown={shown} frame={frame} shows={shows} />
    </section>
  );
}

function DesktopHeading({ shown }: { shown: Shown }) {
  return (
    <span className="sent-file-text">
      <span className="sent-file-name">{titleOf(shown)}</span>
      <History shown={shown} />
    </span>
  );
}

/** Every stored version of the shown Artifact, newest first, from Files; or why Files couldn't list them. */
function useHistory({ id, version }: Published) {
  const [history, setHistory] = useState<{ of: string; versions: HistoryVersion[] } | { of: string; failure: string }>();
  const of = `${id} ${version}`;
  useEffect(() => {
    let current = true;
    listFiles({ chatServiceUrl: chatServiceUrl() }).then((files) => historyOf(id, version, files, readFile)).then(
      (versions) => current && setHistory({ of, versions }),
      (error: unknown) => current && setHistory({ of, failure: `Couldn't list the versions: ${reason(error)}` }),
    );
    return () => {
      current = false;
    };
  }, [id, version, of]);
  return history?.of === of ? history : undefined;
}

/** The panel head's subtitle: who saved the newest version and when; it opens every version, grouped by day. */
function History({ shown }: { shown: Shown }) {
  const { agent } = usePanel();
  const { artifact } = shown;
  const history = useHistory(artifact);
  const phone = useIsPhone();
  const versions = history && "versions" in history ? history.versions : [];
  const now = new Date();
  const newest = versions[0];
  const when = newest?.version === artifact.version ? ` ${agoOf(newest.at, now)}` : "";
  const failure = history && "failure" in history ? history.failure : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="secondary" size="xs" className="artifact-history self-center font-normal text-muted-foreground" />}>
        Edited by {artifact.author === "user" ? "you" : agent.name}{when}<ChevronDownIcon data-icon="inline-end" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={phone ? "start" : "center"} className="artifact-history-menu w-auto min-w-72">
        <Fade open={failure !== null} className="artifact-history-failure"><DropdownMenuLabel role="alert">{failure}</DropdownMenuLabel></Fade>
        {byDay(versions, now).map(({ day, versions: inDay }) => (
          <DropdownMenuGroup key={day}>
            <DropdownMenuLabel>{day}</DropdownMenuLabel>
            {inDay.map(({ version, author, at }) => (
              <DropdownMenuItem key={version} className="gap-2.5">
                <Avatar size={32} agent={author !== "user"} picture={author === "user" ? undefined : agent.picture} emoji={author === "user" ? undefined : agent.avatar} />
                <span className="flex flex-col">
                  <span>{author === "user" ? "You" : agent.name}</span>
                  <span className="text-xs text-muted-foreground">Version {version} · {timeOf(at)}</span>
                </span>
                <Swap state={version === artifact.version ? "current" : "earlier"} className="ml-auto flex">{version === artifact.version && <Badge variant="outline">Current</Badge>}</Swap>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
      <Button type="button" variant="ghost" size="icon-lg" aria-label={move} title={move} onClick={switchSide}><SideIcon aria-hidden /></Button>
      <Button type="button" variant="ghost" size="icon-lg" aria-label={label} title={label} onClick={() => open((current) => current && { ...current, full: !full })}>
        <FullIcon aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="icon-lg" aria-label="Close" title="Close" onClick={() => open(null)}><XIcon aria-hidden /></Button>
    </>
  );
}

function ShownFrame({ shown, frame, shows }: { shown: Shown } & Pick<ViewerProps, "frame" | "shows">) {
  const { seen } = usePanel();
  const save = useCallback(async (edit: ArtifactEdit) => seen(Published.parse(await agentFiles.saveArtifact(edit))), [seen]);
  const { Viewer } = typeOf(shown.artifact.type);
  return <Viewer key={shown.artifact.id} artifact={shown.artifact} read={readFile} readBytes={readBytes} save={save} frame={frame} shows={shows} />;
}
