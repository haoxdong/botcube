"use client";

import { m as motionElement } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { Presence, presenceMotion } from "./collapse";
import { reason } from "./composer-files";
import { sanitizeSlide, type CleanSlide, type Embed } from "./slide-sanitize";

/**
 * A Slides Source is a deck folder: `<folder>/project/deck.json`, the index, and one `<folder>/project/slides/<id>.html`
 * per slide. The folder is the Artifact's identity.
 */
const DECK_FILE = /^(.+)\/project\/(?:deck\.json|slides\/[A-Za-z0-9_-]{1,64}\.html)$/;
export const deckOf = (path: string): string | null => DECK_FILE.exec(path)?.[1] ?? null;
/** The Source a written file belongs to: a slide or deck.json is its deck's folder, a page is itself. */
export const sourceOf = (path: string) => deckOf(path) ?? path;

/** A deck's file as the agent last wrote it, partly while its write streams. */
export type DeckFile = { path: string; text: string; complete: boolean };
/** A file as the agent last wrote it, `complete` once it is; or why the panel couldn't read it after an edit. */
type Written = { path: string } & ({ text: string; complete: boolean } | { error: string });

/** The deck's files the agent wrote in this chat, `writing` until each is whole; null when `folder` is no deck's. */
export function deckFiles(folder: string, sources: Iterable<Written>): { files: DeckFile[]; errors: string[]; writing: boolean } | null {
  const written = [...sources].filter(({ path }) => deckOf(path) === folder);
  if (written.length === 0) return null;
  const files = written.flatMap((source) => "text" in source ? [{ path: source.path, text: source.text, complete: source.complete }] : []);
  return {
    files,
    errors: written.flatMap((source) => "error" in source ? [source.error] : []),
    writing: files.some(({ complete }) => !complete),
  };
}
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
export function DeckFrame({ title, folder, files, errors = [], runs, frame }: { title: string; folder: string; files: readonly DeckFile[]; errors?: readonly string[]; runs: boolean; frame: RefObject<HTMLIFrameElement | null> }) {
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
      <Presence>{errors.map((error) => (
        <motionElement.p key={error} {...presenceMotion} role="alert" className="artifact-refused">{error}</motionElement.p>
      ))}</Presence>
      <iframe ref={frame} title={title} sandbox="allow-scripts" src={SLIDES_PAGE} className="artifact-frame" />
      <Presence>{deck.stripped.length > 0 && (
        <motionElement.ul {...presenceMotion} aria-label="Not shown: outside the slide format" className="artifact-stripped">
          {deck.stripped.map((item) => <li key={item}>{item}</li>)}
        </motionElement.ul>
      )}</Presence>
    </>
  );
}

/** A published deck's Artifact Version's files: its deck.json, then each slide it lists. */
export async function readDeck(path: string, read: (path: string) => Promise<string>): Promise<DeckFile[]> {
  const index = `${path}/project/deck.json`;
  const text = await read(index);
  const order = orderOf(text);
  if (order === null) throw new Error("its deck.json does not parse as a deck");
  const slides = await Promise.all(order.map(async (id) => {
    const slide = `${path}/project/slides/${id}.html`;
    return { path: slide, text: await read(slide), complete: true };
  }));
  return [{ path: index, text, complete: true }, ...slides];
}

/** A published deck's Artifact Version from Files: its deck.json, then each slide it lists; empty while it loads. */
export function useVersionFiles(path: string, read: (path: string) => Promise<string>): DeckFile[] | { error: string } {
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
      <Presence>{"error" in files && (
        <motionElement.p {...presenceMotion} role="alert" className="artifact-refused">Couldn&apos;t open {title}: {files.error}</motionElement.p>
      )}</Presence>
      <DeckFrame title={title} folder={path} files={"error" in files ? [] : files} runs frame={frame} />
    </>
  );
}
