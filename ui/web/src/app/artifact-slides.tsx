"use client";

import { Fades } from "./motion";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { AlertLine, CouldntOpen } from "./alert-line";
import { reason } from "./composer-files";
import { sanitizeSlide, type CleanSlide, type Embed } from "./slide-sanitize";
import { filesPath, type FilesPath } from "./files-path";

/** A deck's file as the agent last wrote it, partly while its write streams. */
export type DeckFile = { path: string; text: string; complete: boolean };
/** A slide as its sandbox page shows it: null until its file is written; its live embeds only in a published version. */
type ShownSlide = { id: string; html: string | null; embeds: Embed[] };

/** The deck's sandbox page: an origin of its own, a frame per slide that runs no scripts, and the deck's embeds. */
const SLIDES_PAGE = "/artifact-sandbox/slides/";
/** The deck renders at most this often while the agent writes it: four renders a second. */
const RENDER_MS = 250;

/** deck.json's slide order, or null while it is half-written. */
export function orderOf(text: string): string[] | null {
  try {
    const index: unknown = JSON.parse(text);
    const order = typeof index === "object" && index !== null && "order" in index ? index.order : null;
    return Array.isArray(order) ? order.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

/**
 * The deck in its sandbox: a slot for every slide deck.json lists, each filled as its file streams in, and the slides
 * deck.json leaves out after them. The order is the last deck.json that parsed, so a deck.json being rewritten keeps
 * the deck on screen. Below it, what the sanitizer stripped from the slides whose files are whole. A published version
 * `runs` its slides' `<x-embed>` pages; a Source only previews, so its embeds stay empty.
 */
function DeckFrame({ title, folder, files, errors = [], runs, frame }: { title: string; folder: string; files: readonly DeckFile[]; errors?: readonly string[]; runs: boolean; frame: RefObject<HTMLIFrameElement | null> }) {
  const order = useRef<string[] | null>(null);
  const cleaned = useRef(new Map<string, CleanSlide>());
  const deck = useMemo(() => {
    const index = files.find(({ path }) => path === `${folder}/project/deck.json`);
    order.current = (index && orderOf(index.text)) ?? order.current;
    const slides = new Map(files.flatMap(({ path, text, complete }) => {
      const id = /\/project\/slides\/([^/]+)\.html$/.exec(path)?.[1];
      return id === undefined ? [] : [[id, { text, complete }] as const];
    }));
    const ids = [...new Set([...order.current ?? [], ...slides.keys()])];
    const clean = (id: string, text: string) => {
      const key = `${id}\n${text}`;
      const found = cleaned.current.get(key) ?? sanitizeSlide(`slides/${id}.html`, text);
      cleaned.current.set(key, found);
      return found;
    };
    const shown: ShownSlide[] = ids.map((id) => {
      const file = slides.get(id);
      if (file === undefined) return { id, html: null, embeds: [] };
      const slide = clean(id, file.text);
      return { id, html: slide.html, embeds: runs && file.complete ? slide.embeds : [] };
    });
    const stripped = ids.flatMap((id) => {
      const file = slides.get(id);
      return file?.complete ? clean(id, file.text).stripped : [];
    });
    return { slides: shown, stripped };
  }, [folder, files, runs]);

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
    if (!ready || deck.slides.length === 0) return;
    const render = () => {
      rendered.current = Date.now();
      frame.current?.contentWindow?.postMessage({ type: "artifact-slides", slides: deck.slides }, "*");
    };
    const wait = rendered.current + RENDER_MS - Date.now();
    if (wait <= 0) {
      render();
      return;
    }
    const timer = setTimeout(render, wait);
    return () => clearTimeout(timer);
  }, [ready, deck, frame]);

  return (
    <>
      <Fades>{errors.map((error) => (
        <AlertLine key={error} className="artifact-refused">{error}</AlertLine>
      ))}</Fades>
      <iframe ref={frame} title={title} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src={SLIDES_PAGE} className="artifact-frame artifact-deck" />
      <Fades>{deck.stripped.length > 0 && (
        <ul aria-label="Not shown: outside the slide format" className="artifact-stripped">
          {deck.stripped.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}</Fades>
    </>
  );
}

/** A published deck's Artifact Version's files: its deck.json, then each slide it lists. */
export async function readDeck(path: FilesPath, read: (path: FilesPath) => Promise<string>): Promise<DeckFile[]> {
  const index = filesPath(`${path}/project/deck.json`);
  const text = await read(index);
  const order = orderOf(text);
  if (order === null) throw new Error("its deck.json does not parse as a deck");
  const slides = await Promise.all(order.map(async (id) => {
    const slide = filesPath(`${path}/project/slides/${id}.html`);
    return { path: slide, text: await read(slide), complete: true };
  }));
  return [{ path: index, text, complete: true }, ...slides];
}

/** A published deck's Artifact Version from Files: its deck.json, then each slide it lists; empty while it loads. */
export function useVersionFiles(path: FilesPath, read: (path: FilesPath) => Promise<string>): DeckFile[] | { error: string } {
  const [files, setFiles] = useState<DeckFile[] | { error: string }>([]);
  useEffect(() => {
    let current = true;
    readDeck(path, read).then(
      (files) => current && setFiles(files),
      (error: unknown) => current && setFiles({ error: reason(error) }),
    );
    return () => {
      current = false;
    };
  }, [path, read]);
  return files;
}

/** A published deck's version, as `useVersionFiles` loaded it (a Viewer may lay its drafts over the files): it runs. */
export function VersionDeck({ title, path, files, frame }: { title: string; path: string; files: readonly DeckFile[] | { error: string }; frame: RefObject<HTMLIFrameElement | null> }) {
  return (
    <>
      <Fades>{"error" in files && (
        <CouldntOpen title={title} why={files.error} />
      )}</Fades>
      <DeckFrame title={title} folder={path} files={"error" in files ? [] : files} runs frame={frame} />
    </>
  );
}
