"use client";

import { EditorContent, Extension, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { m as motionElement } from "framer-motion";
import { PencilIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useVersionFiles, VersionDeck, type DeckFile } from "./artifact-slides";
import type { ArtifactVersion, ViewerProps } from "./artifact-viewer";
import { Presence, presenceMotion, Swap } from "./collapse";
import { reason } from "./composer-files";

const TEXT_BLOCKS = "h1, h2, h3, p, li, th, td";
const KINDS: Record<string, string> = { h1: "Heading", h2: "Heading", h3: "Heading", p: "Paragraph", li: "List item", th: "Cell", td: "Cell" };
/**
 * What the editor never parses: an `<x-embed>` holds a page of its own and an `<svg>` a drawing, which an HTML parser
 * would rewrite. Each is set aside and put back as written.
 */
const VERBATIM = /<(x-embed|svg)\b[\s\S]*?<\/\1>/gi;

const toSubset = (html: string) =>
  html.replace(/^<p>|<\/p>$/g, "").replace(/<(\/?)strong>/g, "<$1b>").replace(/<(\/?)em>/g, "<$1i>")
    .replace(/<br class="[^"]*">/g, "<br>").replace(/ (target|rel|class)="[^"]*"/g, "");

const OneBlock = Extension.create({ name: "oneBlock", addKeyboardShortcuts: () => ({ Enter: () => true }) });

function BlockEditor({ label, initial, onChange }: { label: string; initial: string; onChange: (inner: string) => void }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false, blockquote: false,
        codeBlock: false, code: false, horizontalRule: false, strike: false, dropcursor: false, gapcursor: false,
        trailingNode: false, link: { openOnClick: false },
      }),
      OneBlock,
    ],
    content: `<p>${initial}</p>`,
    immediatelyRender: true,
    editorProps: { attributes: { role: "textbox", "aria-label": label, "aria-multiline": "false", class: "artifact-edit-block" } },
    onUpdate: ({ editor: changed }) => onChange(toSubset(changed.getHTML())),
  });
  return <EditorContent editor={editor} />;
}

function SlideTextEditor({ label, file, onChange }: { label: string; file: string; onChange: (file: string) => void }) {
  const { doc, blocks, kept } = useMemo(() => {
    const kept: string[] = [];
    const parsed = new DOMParser().parseFromString(
      `<body>${file.replace(VERBATIM, (whole) => `<template data-kept="${kept.push(whole) - 1}"></template>`)}</body>`, "text/html");
    const blocks = [...parsed.body.querySelectorAll(TEXT_BLOCKS)].filter((block) =>
      !block.closest("aside") && !block.parentElement?.closest(TEXT_BLOCKS) && !block.querySelector(`span, template, ${TEXT_BLOCKS}`));
    return { doc: parsed, blocks, kept };
  }, [file]);
  const serialize = () => doc.body.innerHTML.replace(/<template data-kept="(\d+)"><\/template>/g, (_, index: string) => kept[Number(index)] ?? "");
  const counts: Record<string, number> = {};
  return (
    <div role="group" aria-label={label} className="artifact-edit-slide">
      <span className="artifact-edit-label">{label}</span>
      {blocks.map((block, index) => {
        const kind = KINDS[block.tagName.toLowerCase()] ?? "Text";
        counts[kind] = (counts[kind] ?? 0) + 1;
        return (
          <BlockEditor key={index} label={`${kind} ${counts[kind]}`} initial={block.innerHTML} onChange={(inner) => {
            block.innerHTML = inner;
            onChange(serialize());
          }} />
        );
      })}
    </div>
  );
}

const slidesOf = (folder: string, files: readonly DeckFile[]) => files.flatMap(({ path, text }) => {
  const name = path.slice(folder.length + 1);
  return /^project\/slides\/[^/]+\.html$/.test(name) ? [{ name, id: name.slice("project/slides/".length, -".html".length), text }] : [];
});

export function EditableDeck({ artifact: newest, read, save, frame, shows }: ViewerProps) {
  const [edit, setEdit] = useState<{ version: ArtifactVersion; drafts: Record<string, string> } | null>(null);
  const deck = edit?.version ?? newest;
  const loaded = useVersionFiles(deck.path, read);
  const files = "error" in loaded ? [] : loaded;
  const [failures, setFailures] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const shown = useMemo(() => edit === null ? files
    : files.map((file) => ({ ...file, text: edit.drafts[file.path.slice(deck.path.length + 1)] ?? file.text })), [files, edit, deck.path]);
  const edited = edit !== null && Object.keys(edit.drafts).length > 0;
  useEffect(() => shows({ version: deck, unsaved: edited }), [deck, edited, shows]);
  const stop = () => {
    setEdit(null);
    setFailures([]);
  };

  const submit = async () => {
    if (edit === null) return;
    setSaving(true);
    setFailures([]);
    try {
      await save({ id: deck.id, version: deck.version, files: edit.drafts });
      setEdit(null);
    } catch (error) {
      setFailures(reason(error).split("\n").map((line) => `Couldn't save: ${line}`));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Swap state={edit === null ? "reading" : "editing"} className="artifact-edit-bar">
        {edit === null ? (
          <button type="button" className="header-btn artifact-edit-action" disabled={files.length === 0} onClick={() => setEdit({ version: newest, drafts: {} })}>
            <PencilIcon aria-hidden />Edit text
          </button>
        ) : (
          <>
            <button type="button" className="header-btn artifact-edit-action" disabled={!edited || saving} onClick={() => void submit()}>Save</button>
            <button type="button" className="header-btn artifact-edit-action" disabled={saving} onClick={stop}>Cancel</button>
          </>
        )}
      </Swap>
      <Presence>{edit !== null && !saving && newest.version > edit.version.version && (
        <motionElement.div {...presenceMotion} role="status" className="artifact-edit-newer">
          <span>Version {newest.version} arrived while you edited version {edit.version.version}. Your edits are kept.</span>
          <button type="button" className="header-btn artifact-edit-action" disabled={saving} onClick={stop}>
            Discard edits and open version {newest.version}
          </button>
        </motionElement.div>
      )}</Presence>
      <Presence>{failures.map((failure) => (
        <motionElement.p key={failure} {...presenceMotion} role="alert" className="artifact-refused artifact-edit-failure">{failure}</motionElement.p>
      ))}</Presence>
      <VersionDeck title={deck.title} path={deck.path} files={"error" in loaded ? loaded : shown} frame={frame} />
      <Presence>{edit !== null && (
        <motionElement.div {...presenceMotion} className="artifact-edit">
          {slidesOf(deck.path, files).map(({ name, id, text }, index) => (
            <SlideTextEditor key={name} label={`Slide ${index + 1}: ${id}`} file={text}
              onChange={(next) => setEdit((current) => current && { ...current, drafts: { ...current.drafts, [name]: next } })} />
          ))}
        </motionElement.div>
      )}</Presence>
    </>
  );
}
