"use client";

import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { m as motionElement } from "framer-motion";
import { FileTextIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  pdfOf, saveFile, storedVersion, type ArtifactVersion, type Export, type ExportTarget, type PreviewProps, type ViewerProps,
  type Writes,
} from "./artifact-viewer";
import { Presence, presenceMotion } from "./collapse";
import { reason } from "./composer-files";

const RENDER_MS = 250;

const EXTENSIONS = [
  // StarterKit 3 underlines on Mod-U, and @tiptap/markdown writes an underline as <u>, HTML a Doc does not keep.
  StarterKit.configure({ link: { openOnClick: false }, underline: false }),
  TableKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Image.configure({ allowBase64: true }),
  Markdown,
];

const NOT_FILES = new Set(["tmp", "botcube-harness-deepagents", "artifacts"]);

const isDocSource = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return /\.md$/i.test(path) && !NOT_FILES.has(parts[0] ?? "") && !parts.some((part) => part.startsWith("."));
};

function useDoc(label: string, markdown: string, editable: boolean, onUpdate?: (markdown: string) => void) {
  return useEditor({
    extensions: EXTENSIONS,
    content: markdown,
    contentType: "markdown",
    editable,
    immediatelyRender: true,
    editorProps: { attributes: { role: "textbox", "aria-label": label, "aria-multiline": "true", "aria-readonly": String(!editable), class: "artifact-doc" } },
    onUpdate: ({ editor }) => onUpdate?.(editor.getMarkdown()),
  });
}

export function DocFrame({ title, markdown, complete }: { title: string; markdown: string; complete: boolean }) {
  const editor = useDoc(title, markdown, false);
  const rendered = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    const render = () => {
      rendered.current = Date.now();
      editor.commands.setContent(markdown, { contentType: "markdown" });
    };
    const wait = complete ? 0 : rendered.current + RENDER_MS - Date.now();
    if (wait <= 0) {
      render();
      return;
    }
    const timer = setTimeout(render, wait);
    return () => clearTimeout(timer);
  }, [editor, markdown, complete]);
  return <div className="artifact-doc-page"><EditorContent editor={editor} /></div>;
}

function DocPreview({ title, text, complete }: PreviewProps) {
  return <DocFrame title={title} markdown={text ?? ""} complete={complete} />;
}

export const DOC_WRITES: Writes = { matches: isDocSource, Preview: DocPreview };

function useMarkdown(path: string, read: (path: string) => Promise<string>) {
  const [loaded, setLoaded] = useState<{ path: string; markdown: string } | { path: string; error: string } | null>(null);
  useEffect(() => {
    let current = true;
    read(path).then(
      (markdown) => current && setLoaded({ path, markdown }),
      (error: unknown) => current && setLoaded({ path, error: reason(error) }),
    );
    return () => {
      current = false;
    };
  }, [path, read]);
  return loaded?.path === path ? loaded : null;
}

export function EditableDoc({ artifact: newest, read, save, shows }: ViewerProps) {
  const [edit, setEdit] = useState<{ version: ArtifactVersion; markdown: string } | null>(null);
  const [opened, setOpened] = useState(0);
  const [saving, setSaving] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const doc = edit?.version ?? newest;
  const loaded = useMarkdown(doc.path, read);
  const unsaved = edit !== null;
  useEffect(() => shows({ version: doc, unsaved }), [shows, doc, unsaved]);
  const stop = () => {
    setEdit(null);
    setFailures([]);
    setOpened((count) => count + 1);
  };
  const submit = async () => {
    if (edit === null) return;
    setSaving(true);
    setFailures([]);
    try {
      const name = edit.version.id.slice(edit.version.id.lastIndexOf("/") + 1);
      await save({ id: edit.version.id, version: edit.version.version, files: { [name]: edit.markdown } });
      setEdit(null);
    } catch (error) {
      setFailures(reason(error).split("\n").map((line) => `Couldn't save: ${line}`));
    } finally {
      setSaving(false);
    }
  };

  if (loaded === null) return <p className="artifact-status">Opening {doc.title}…</p>;
  if ("error" in loaded) return <p role="alert" className="artifact-refused">Couldn&apos;t open {doc.title}: {loaded.error}</p>;
  return (
    <>
      <div className="artifact-edit-bar">
        <button type="button" className="header-btn artifact-edit-action" disabled={edit === null || saving} onClick={() => void submit()}>Save</button>
        <button type="button" className="header-btn artifact-edit-action" disabled={edit === null || saving} onClick={stop}>Discard</button>
      </div>
      <Presence>{edit !== null && !saving && newest.version > edit.version.version && (
        <motionElement.div {...presenceMotion} role="status" className="artifact-edit-newer">
          <span>Version {newest.version} arrived while you edited version {edit.version.version}. Your edits are kept.</span>
          <button type="button" className="header-btn artifact-edit-action" onClick={stop}>Discard edits and open version {newest.version}</button>
        </motionElement.div>
      )}</Presence>
      <Presence>{failures.map((failure) => (
        <motionElement.p key={failure} {...presenceMotion} role="alert" className="artifact-refused artifact-edit-failure">{failure}</motionElement.p>
      ))}</Presence>
      <DocEditor key={`${doc.path}:${opened}`} title={doc.title} markdown={loaded.markdown}
        onEdit={(markdown) => setEdit({ version: doc, markdown })} />
    </>
  );
}

function DocEditor({ title, markdown, onEdit }: { title: string; markdown: string; onEdit: (markdown: string) => void }) {
  const editor = useDoc(title, markdown, true, onEdit);
  return <div className="artifact-doc-page"><EditorContent editor={editor} /></div>;
}

function htmlOf(markdown: string): string {
  const editor = new Editor({ extensions: EXTENSIONS, content: markdown, contentType: "markdown" });
  try {
    return editor.getHTML();
  } finally {
    editor.destroy();
  }
}

/** The Markdown of the stored version on screen, which the Doc's Exports are made from. */
const storedMarkdown = (target: ExportTarget) => target.read(storedVersion(target, "the Doc").path);

/** The Doc's PDF prints its stored version on screen, in a frame of its own. */
const DOC_PDF = pdfOf(async (target) => printDoc(htmlOf(await storedMarkdown(target)), target.title), true);

const WORD: Export = {
  label: "Download as Word",
  Icon: FileTextIcon,
  failed: "the Word file",
  stored: true,
  instead: DOC_PDF,
  run: async (target) => {
    const [{ wordOf }, markdown] = await Promise.all([import("./doc-word"), storedMarkdown(target)]);
    saveFile(await wordOf(htmlOf(markdown), target.title), `${target.title}.docx`);
  },
};


export const DOC_EXPORTS = [WORD, DOC_PDF] as const;

const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A sandboxed frame's print() is reachable from the app only when the frame shares the app's origin.
function printDoc(html: string, title: string) {
  const frame = Object.assign(document.createElement("iframe"), { title: `${title} for print`, hidden: true });
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.srcdoc = `<!doctype html><meta charset="utf-8"><title>${escaped(title)}</title><style>body{font:16px/1.5 Inter,system-ui,sans-serif;margin:2cm}img{max-width:100%}table{border-collapse:collapse}th,td{border:1px solid;padding:4px 8px}</style>${html}`;
  frame.addEventListener("load", () => {
    frame.contentWindow?.addEventListener("afterprint", () => frame.remove());
    frame.contentWindow?.print();
  });
  document.body.append(frame);
}
