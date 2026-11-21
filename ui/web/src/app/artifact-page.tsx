"use client";

import { m as motionElement } from "motion/react";
import { useEffect, useRef, useState, type RefObject } from "react";

import type { ViewerProps } from "./artifact-viewer";
import { Presence, presenceMotion } from "./collapse";
import { reason } from "./composer-files";

const SANDBOX_PAGE = "/artifact-sandbox/index.html";
const SANDBOX = "allow-scripts allow-modals";

/** The untyped Artifact's Viewer: the version's page from Files, which runs. */
export function VersionFrame({ artifact, read, frame, shows }: ViewerProps) {
  const position = useRef({ left: 0, top: 0 });
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data?.type === "artifact-scroll" && typeof event.data.left === "number" && typeof event.data.top === "number") {
        position.current = { left: event.data.left, top: event.data.top };
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [frame]);
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
      <SandboxFrame key={artifact.path} position={position} title={artifact.title} html={page !== null && "html" in page ? page.html : null} frame={frame} />
    </>
  );
}

/** The sandbox page, sent the published version's `html`, which runs with its scripts, once it says it is ready. */
function SandboxFrame({ title, html, frame, position }: { title: string; html: string | null; frame: RefObject<HTMLIFrameElement | null>; position?: RefObject<{ left: number; top: number }> }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && event.data?.type === "artifact-sandbox-ready") setReady(true);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [frame]);
  useEffect(() => {
    if (!ready || html === null) return;
    frame.current?.contentWindow?.postMessage({ type: "artifact-page", html, ...(position ? { position: position.current } : {}) }, "*");
  }, [ready, html, frame, position]);
  return <iframe ref={frame} name={title} title={title} sandbox={SANDBOX} src={SANDBOX_PAGE} className="artifact-frame" />;
}
