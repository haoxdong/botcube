"use client";

import { m as motionElement } from "framer-motion";
import { useEffect, useRef, useState, type RefObject } from "react";

import type { PreviewProps, ViewerProps, Writes } from "./artifact-viewer";
import { Presence, presenceMotion } from "./collapse";
import { reason } from "./composer-files";

/** A Source previews at most this often: four renders a second. */
const PREVIEW_MS = 250;

const SANDBOX_PAGE = "/artifact-sandbox/";
const SANDBOX = "allow-scripts allow-modals";

/** The untyped Artifact's Viewer: the version's page from Files, which runs. */
export function VersionFrame({ artifact, read, frame, shows }: ViewerProps) {
  const [page, setPage] = useState<{ html: string } | { error: string } | null>(null);
  useEffect(() => shows({ version: artifact, unsaved: false }), [artifact, shows]);
  useEffect(() => {
    let current = true;
    setPage(null);
    read(artifact.path).then(
      (html) => current && setPage({ html }),
      (error: unknown) => current && setPage({ error: reason(error) }),
    );
    return () => {
      current = false;
    };
  }, [artifact.path, read]);
  const failure = page !== null && "error" in page ? page.error : null;
  return (
    <>
      <Presence>{failure !== null && (
        <motionElement.p {...presenceMotion} role="alert" className="artifact-refused">Couldn&apos;t open {artifact.title}: {failure}</motionElement.p>
      )}</Presence>
      {/* A fresh frame per version: the panel keeps this Viewer mounted across versions, and a page never inherits one. */}
      <SandboxFrame key={artifact.path} title={artifact.title} html={page !== null && "html" in page ? page.html : null} runs frame={frame} />
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

/** A page the agent is writing, previewed without its scripts. */
function PagePreview({ title, text, frame }: PreviewProps) {
  return <SandboxFrame title={title} html={text} runs={false} frame={frame} />;
}

/** Any HTML file the agent writes previews as a page; a deck's slides preview as their deck first. */
export const PAGE_WRITES: Writes = { matches: (path) => /\.html?$/i.test(path), Preview: PagePreview };
